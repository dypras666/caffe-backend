const mysql = require('mysql2');
const { AsyncLocalStorage } = require('async_hooks');

// Per-request tenant context: { pool, secret, slug }
const tenantStorage = new AsyncLocalStorage();

// Pool cache: slug → { pool, secret, db_name }
const pools = new Map();

// Registry DB — reads tenant credentials
let registryDb = null;
function getRegistryDb() {
  if (registryDb) return registryDb;
  registryDb = mysql.createPool({
    host: process.env.REGISTRY_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.REGISTRY_DB_PORT || '3306'),
    user: process.env.REGISTRY_DB_USER || 'root',
    password: process.env.REGISTRY_DB_PASS || '',
    database: process.env.REGISTRY_DB_NAME || 'caffe_registry',
    connectionLimit: 3,
  }).promise();
  return registryDb;
}

async function getTenantPool(slug) {
  if (pools.has(slug)) return pools.get(slug);

  const reg = getRegistryDb();
  const [[tenant]] = await reg.query(
    'SELECT db_name, db_user, db_pass, secret FROM tenants WHERE slug = ? AND status = "active"',
    [slug]
  );
  if (!tenant) throw new Error(`Tenant "${slug}" not found`);

  const pool = mysql.createPool({
    host: process.env.SHARED_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.SHARED_DB_PORT || '3910'),
    user: tenant.db_user,
    password: tenant.db_pass,
    database: tenant.db_name,
    connectionLimit: 5,
    waitForConnections: true,
  }).promise();

  // Attach getPool/getConnection for code that uses db.getPool()
  pool.getPool = () => pool;

  const ctx = { pool, secret: tenant.secret, slug, db_name: tenant.db_name };
  pools.set(slug, ctx);
  return ctx;
}

function invalidatePool(slug) {
  if (pools.has(slug)) {
    pools.get(slug).pool.end().catch(() => {});
    pools.delete(slug);
  }
}

// Express middleware — must run before any route
async function tenantMiddleware(req, res, next) {
  const slug = req.headers['x-tenant-slug'];
  if (!slug) return res.status(400).json({ error: 'Missing x-tenant-slug header' });
  try {
    const ctx = await getTenantPool(slug);
    tenantStorage.run(ctx, next);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}

// Returns current tenant's db (pool) — used as drop-in for config/database.js
const db = new Proxy({}, {
  get(_, prop) {
    const ctx = tenantStorage.getStore();
    if (!ctx) throw new Error('No tenant context — tenantMiddleware not applied?');
    if (prop === 'getPool') return () => ctx.pool;
    const val = ctx.pool[prop];
    return typeof val === 'function' ? val.bind(ctx.pool) : val;
  }
});

function getTenantSecret() {
  const ctx = tenantStorage.getStore();
  return ctx?.secret || process.env.JWT_SECRET;
}

function getTenantSlug() {
  return tenantStorage.getStore()?.slug;
}

module.exports = { db, tenantMiddleware, getTenantSecret, getTenantSlug, invalidatePool };
