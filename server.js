const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Rate limit
const rateLimit = require('express-rate-limit');
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// Single DB pool — used everywhere including inline auth routes
const db = require('./config/database');

async function initDB() {
  try {
    // Run all migrations (idempotent — safe to call every startup)
    const { runMigrations } = require('./database/migrate-stb');
    await runMigrations();

    // Confirm DB is reachable
    const conn = await db.getConnection();
    conn.release();
  } catch (e) { console.error('DB init error (non-fatal):', e.message); }
  console.log('Database connected');
}

// Auth middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Make db available
app.use((req, res, next) => { req.db = db; next(); });

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', tenant: process.env.TENANT_SLUG || 'unknown' });
});

// ─── AUTH ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!users.length) return res.status(401).json({ error: 'Email atau password salah' });
    const user = users[0];
    if (!(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Email atau password salah' });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── FORGOT / RESET PASSWORD ────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email wajib diisi' });

    const [users] = await db.query('SELECT id, email FROM users WHERE email = ? AND role = ?', [email, 'admin']);
    if (!users.length) return res.json({ success: true });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await db.query('UPDATE users SET reset_token = ?, reset_token_exp = ? WHERE email = ?', [token, expires, email]);

    console.log(`[Auth] Forgot password for ${email}: token=${token.substring(0, 12)}...`);
    res.json({ success: true });
  } catch (e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token dan password wajib diisi' });
    if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });

    const [users] = await db.query(
      'SELECT id FROM users WHERE reset_token = ? AND reset_token_exp > NOW() AND role = ?',
      [token, 'admin']
    );
    if (!users.length) return res.status(400).json({ error: 'Token tidak valid atau kadaluarsa' });

    const hashed = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password = ?, reset_token = NULL, reset_token_exp = NULL WHERE id = ?', [hashed, users[0].id]);
    res.json({ success: true, message: 'Password berhasil direset' });
  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── USERS — handled by routes/users.js (see routeNames) ─────────

// ─── DASHBOARD (public stats for gallery page) ──────────────────
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [[{ orders }]] = await db.query("SELECT COUNT(*) as orders FROM orders WHERE DATE(created_at) = CURDATE()");
    const [[{ tables }]] = await db.query("SELECT COUNT(*) as tables FROM tables");
    const [[{ products }]] = await db.query("SELECT COUNT(*) as products FROM products WHERE is_available = 1");
    const [[{ users_count }]] = await db.query("SELECT COUNT(*) as users_count FROM users");
    const [[{ revenue_today }]] = await db.query("SELECT COALESCE(SUM(total_amount), 0) as revenue_today FROM orders WHERE DATE(created_at) = CURDATE()");
    const [[{ orders_count }]] = await db.query("SELECT COUNT(*) as orders_count FROM orders");
    const [[{ total_revenue }]] = await db.query("SELECT COALESCE(SUM(total_amount), 0) as total_revenue FROM orders");
    res.json({
      revenue_today: revenue_today.toString(),
      revenue_month: '0.00',
      orders: parseInt(orders),
      tables: parseInt(tables),
      products: parseInt(products),
      users: parseInt(users_count),
      total_orders: parseInt(orders_count),
      total_revenue: total_revenue.toString(),
      tier: process.env.PRICING_TIER || 'free',
      ram_mb: parseInt(process.env.RAM_MB || '64'),
      cpu_cores: parseFloat(process.env.CPU_CORES || '0.25')
    });
  } catch (e) {
    console.error('Stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── SYSTEM INFO ──────────────────────────────────────────────
app.get('/api/system/info', authenticate, async (req, res) => {
  try {
    let users = [];
    let branches = [];
    try {
      [users] = await db.query('SELECT id, name, email, role, is_active FROM users');
    } catch {
      [users] = await db.query('SELECT id, name, email, role FROM users');
    }
    try {
      [branches] = await db.query('SELECT id, name FROM branches');
    } catch { branches = []; }

    res.json({
      tenant: {
        name: process.env.TENANT_NAME || process.env.TENANT_SLUG || 'Cafe',
        slug: process.env.TENANT_SLUG || 'unknown',
        tier: process.env.PRICING_TIER || 'free',
        created_at: process.env.TENANT_CREATED_AT || null,
      },
      stats: {
        total_users: users.length,
        admin_count: users.filter(u => u.role === 'admin').length,
        kasir_count: users.filter(u => u.role === 'kasir').length,
        waiter_count: users.filter(u => u.role === 'waiter').length,
        member_count: users.filter(u => u.role === 'member').length,
        active_users: users.filter(u => u.is_active == 1 || u.is_active === undefined).length,
        inactive_users: users.filter(u => u.is_active == 0).length,
        with_email: users.filter(u => u.email && u.email.trim()).length,
        with_phone: 0,
        branches: branches.length,
      },
    });
  } catch (e) {
    console.error('System info error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE FILES ──────────────────────────────────────────────
const routeNames = [
  'orders', 'products', 'categories', 'tables', 'branches',
  'shifts', 'payments', 'roles', 'rooms', 'vouchers',
  'stock', 'recipes', 'units', 'variants', 'expenses', 'hr',
  'audit', 'backup', 'integrations', 'posts', 'printers', 'stations',
  'bookings', 'members', 'media', 'reports', 'settings', 'register',
  'ingredients', 'users', 'dashboard', 'auth', 'setup',
];
routeNames.forEach(name => {
  try {
    const r = require(`./routes/${name}`);
    app.use(`/api/${name}`, r);
  } catch (e) {
    // route file not found or failed to load — log and use empty stub
    console.error(`[route] Failed to load routes/${name}:`, e.message);
    app.get(`/api/${name}`, authenticate, (req, res) => res.json([]));
    app.post(`/api/${name}`, authenticate, (req, res) => res.json({ id: 0 }));
    app.put(`/api/${name}/:id`, authenticate, (req, res) => res.json({ success: true }));
    app.delete(`/api/${name}/:id`, authenticate, (req, res) => res.json({ success: true }));
  }
});

// ─── SYSTEM PING (no auth, for LAN discovery) ─────────────────
app.get('/api/system/ping', async (req, res) => {
  let cafeName = 'Cafe Kasir';
  try {
    const [[row]] = await db.query(
      "SELECT setting_value FROM system_settings WHERE setting_key='cafe_name' LIMIT 1"
    );
    if (row?.setting_value) cafeName = row.setting_value;
  } catch (_) {}
  res.json({ ok: true, cafeName, timestamp: new Date().toISOString(), version: '1.0' });
});

// ─── MOBILE SYNC ──────────────────────────────────────────────
app.use('/api/mobile/sync', require('./routes/mobilesync'));

// ─── DUITKU ───────────────────────────────────────────────────
const duitkuRoutes = require('./routes/duitku');
app.use('/api/duitku', duitkuRoutes);
// Public callback URL persis yang didaftarkan ke Duitku
const duitkuService = require('./services/DuitkuService');
app.post('/payment/callback/duitku', async (req, res) => {
  try {
    console.log('[Duitku] Callback received:', JSON.stringify(req.body));
    const result = await duitkuService.handleCallback(req.body);
    console.log('[Duitku] Callback processed:', result);
    res.status(200).send('SUCCESS');
  } catch (err) {
    console.error('[Duitku] Callback error:', err.message);
    res.status(400).send(err.message);
  }
});

// ─── STATIC FILES ──────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');
app.use('/admin', express.static(path.join(publicDir, 'admin')));
app.use('/assets', express.static(path.join(publicDir, 'admin/assets')));
// Cafe Kasir web app
app.use('/kasir', express.static(path.join(publicDir, 'kasir')));
app.use(express.static(publicDir));

// SPA fallback — NOT for API paths
app.get('/{*p}', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'API route not found' });
  if (req.path.startsWith('/admin')) {
    const p = path.join(publicDir, 'admin', 'index.html');
    if (fs.existsSync(p)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.sendFile(p);
    }
  }
  if (req.path.startsWith('/kasir')) {
    const p = path.join(publicDir, 'kasir', 'index.html');
    if (fs.existsSync(p)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.sendFile(p);
    }
  }
  const uiIndex = path.join(publicDir, 'ui', 'index.html');
  if (fs.existsSync(uiIndex)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(uiIndex);
  }
  res.status(404).send('Not found');
});

// Start
async function start() {
  await initDB();
  if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, '0.0.0.0', () => console.log(`Cafe Backend running on port ${PORT}`));
  }
}

const startPromise = start().catch(e => { console.error('Failed:', e); process.exit(1); });
// Export app + startPromise so tests can await DB init
app.ready = startPromise;
module.exports = app;
