const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ─── Shared-backend: tenant-aware DB proxy ────────────────────
const {
  db: tenantDb,
  tenantMiddleware,
  getTenantSecret,
  getTenantSlug,
  invalidatePool,
} = require('./config/tenant-pools');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Rate limit
const rateLimit = require('express-rate-limit');
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// ─── Tenant resolver (must be before all /api routes) ─────────
app.use('/api', tenantMiddleware);

// Shared db proxy — resolves to current tenant's pool per-request
const db = tenantDb;

// In shared mode, initDB is a no-op — pools created lazily per tenant
async function initDB() {
  console.log('[shared-backend] started, tenant pools created on first request');
}

// Auth middleware — uses per-tenant JWT secret
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, getTenantSecret());
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Make db available
app.use((req, res, next) => { req.db = db; next(); });

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', tenant: getTenantSlug() || 'unknown', mode: 'shared' });
});

// Internal: invalidate pool cache when tenant upgrades
app.get('/_internal/invalidate/:slug', (req, res) => {
  invalidatePool(req.params.slug);
  res.json({ ok: true });
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

// ─── USERS ──────────────────────────────────────────────────────
app.get('/api/users', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', authenticate, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const [r] = await db.query('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name, email, hashed, role || 'cashier']);
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', authenticate, async (req, res) => {
  try {
    const { name, email, role } = req.body;
    await db.query('UPDATE users SET name=?, email=?, role=? WHERE id=?', [name, email, role, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// ─── CATEGORIES ────────────────────────────────────────────────
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM categories WHERE is_active = 1');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/categories', authenticate, async (req, res) => {
  try {
    const { name, description } = req.body;
    const [r] = await db.query('INSERT INTO categories (name, description) VALUES (?, ?)', [name, description || null]);
    res.json({ id: r.insertId, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/categories/:id', authenticate, async (req, res) => {
  try {
    const { name, description } = req.body;
    await db.query('UPDATE categories SET name=?, description=? WHERE id=?', [name, description, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/categories/:id', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM categories WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PRODUCTS ──────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE (p.is_available = 1 OR p.is_available IS NULL) ORDER BY p.created_at DESC"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', authenticate, async (req, res) => {
  try {
    const { name, category_id, price, description } = req.body;
    const [r] = await db.query('INSERT INTO products (name, category_id, price, description) VALUES (?, ?, ?, ?)',
      [name, category_id, price, description || null]);
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', authenticate, async (req, res) => {
  try {
    const { name, category_id, price, description, is_available } = req.body;
    await db.query('UPDATE products SET name=?, category_id=?, price=?, description=?, is_available=? WHERE id=?',
      [name, category_id, price, description, is_available ?? 1, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TABLES ────────────────────────────────────────────────────
app.get('/api/tables', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM tables ORDER BY number ASC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tables', authenticate, async (req, res) => {
  try {
    const { number, capacity } = req.body;
    const [r] = await db.query('INSERT INTO tables (number, capacity) VALUES (?, ?)', [number, capacity || 4]);
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tables/:id', authenticate, async (req, res) => {
  try {
    const { number, capacity, status } = req.body;
    await db.query('UPDATE tables SET number=?, capacity=?, status=? WHERE id=?',
      [number, capacity, status || 'available', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tables/:id', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM tables WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ORDERS ────────────────────────────────────────────────────
app.get('/api/orders', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT o.*, t.number as table_number FROM orders o LEFT JOIN tables t ON o.table_id = t.id ORDER BY o.created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', authenticate, async (req, res) => {
  try {
    const { table_id, customer_name, items, payment_method, notes } = req.body;
    let total = 0;
    if (items) {
      for (const item of items) {
        const [prod] = await db.query('SELECT price FROM products WHERE id = ?', [item.product_id]);
        total += (parseFloat(prod[0]?.price) || 0) * (item.quantity || 1);
      }
    }
    const [r] = await db.query(
      'INSERT INTO orders (table_id, customer_name, total_amount, status, payment_method, notes) VALUES (?,?,?,?,?,?)',
      [table_id || null, customer_name || 'Guest', total, 'pending', payment_method || 'cash', notes || null]
    );
    if (items) {
      for (const item of items) {
        await db.query('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)',
          [r.insertId, item.product_id, item.quantity || 1, item.price || 0]);
      }
    }
    res.json({ id: r.insertId, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/orders/:id', authenticate, async (req, res) => {
  try {
    const { status, payment_method } = req.body;
    await db.query('UPDATE orders SET status=?, payment_method=COALESCE(?,payment_method) WHERE id=?',
      [status, payment_method, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:id', authenticate, async (req, res) => {
  try {
    const [orders] = await db.query(
      'SELECT o.*, t.number as table_number FROM orders o LEFT JOIN tables t ON o.table_id = t.id WHERE o.id=?', [req.params.id]);
    if (!orders.length) return res.status(404).json({ error: 'Not found' });
    const [items] = await db.query(
      'SELECT oi.*, p.name as product_name FROM order_items oi LEFT JOIN products p ON oi.product_id=p.id WHERE oi.order_id=?',
      [req.params.id]);
    res.json({ ...orders[0], items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MEMBERS ───────────────────────────────────────────────────
app.get('/api/members/search', authenticate, async (req, res) => {
  try {
    const q = req.query.q || '';
    const [rows] = await db.query(
      "SELECT id, name, email, role, created_at FROM users WHERE name LIKE ? OR email LIKE ? LIMIT 10",
      [`%${q}%`, `%${q}%`]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REGISTER ──────────────────────────────────────────────────
app.post('/api/auth/register', authenticate, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const [r] = await db.query('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)',
      [name, email, hashed, role || 'cashier']);
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SETTINGS ──────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  try { res.json({}); } catch (e) { res.json({}); }
});

app.put('/api/settings', (req, res) => {
  try { res.json({ success: true }); } catch (e) { res.json({ success: true }); }
});

// ─── BOOKINGS ──────────────────────────────────────────────────
app.get('/api/bookings', authenticate, async (req, res) => {
  try { res.json([]); } catch (e) { res.json([]); }
});

app.post('/api/bookings', authenticate, async (req, res) => {
  try { res.json({ id: 0 }); } catch (e) { res.json({ id: 0 }); }
});

// ─── INGREDIENTS ───────────────────────────────────────────────
app.get('/api/ingredients', authenticate, async (req, res) => {
  try { res.json([]); } catch (e) { res.json([]); }
});

app.post('/api/ingredients', authenticate, async (req, res) => {
  try { res.json({ id: 0 }); } catch (e) { res.json({ id: 0 }); }
});

app.put('/api/ingredients/:id', authenticate, async (req, res) => {
  try { res.json({ success: true }); } catch (e) { res.json({ success: true }); }
});

app.delete('/api/ingredients/:id', authenticate, async (req, res) => {
  try { res.json({ success: true }); } catch (e) { res.json({ success: true }); }
});

app.get('/api/ingredients/:id/units', authenticate, async (req, res) => {
  try { res.json([]); } catch (e) { res.json([]); }
});

app.post('/api/ingredients/:id/adjust', authenticate, async (req, res) => {
  try { res.json({ success: true }); } catch (e) { res.json({ success: true }); }
});

// ─── REPORTS ───────────────────────────────────────────────────
app.get('/api/reports/summary', authenticate, async (req, res) => {
  try {
    res.json({
      total_orders: 0, total_revenue: '0', average_order: '0',
      top_products: [], daily_summary: []
    });
  } catch (e) { res.json({}); }
});

app.get('/api/reports/products', authenticate, async (req, res) => {
  try { res.json([]); } catch (e) { res.json([]); }
});

app.get('/api/reports/hourly', authenticate, async (req, res) => {
  try { res.json([]); } catch (e) { res.json([]); }
});

app.get('/api/reports/tables', authenticate, async (req, res) => {
  try { res.json([]); } catch (e) { res.json([]); }
});

app.get('/api/reports/staff', authenticate, async (req, res) => {
  try { res.json([]); } catch (e) { res.json([]); }
});

// ─── MEDIA ─────────────────────────────────────────────────────
app.get('/api/media', (req, res) => res.json([]));
app.post('/api/media/upload', authenticate, (req, res) => res.json({ url: null }));

// ─── BRANCHES ──────────────────────────────────────────────────
app.get('/api/branches', authenticate, async (req, res) => {
  try { const [r] = await db.query('SELECT * FROM branches'); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/branches/public', async (req, res) => {
  try { const [r] = await db.query('SELECT * FROM branches WHERE is_active=1'); res.json({ branches: r }); }
  catch (e) { res.json({ branches: [] }); }
});
app.post('/api/branches', authenticate, (req, res) => res.json({ id: 0 }));
app.put('/api/branches/:id', authenticate, (req, res) => res.json({ success: true }));
app.delete('/api/branches/:id', authenticate, (req, res) => res.json({ success: true }));

// ─── ROUTE FILES ──────────────────────────────────────────────
const routeNames = [
  'shifts', 'payments', 'roles', 'rooms', 'vouchers',
  'stock', 'recipes', 'units', 'variants', 'expenses', 'hr', 'webhooks',
  'audit', 'backup', 'integrations', 'posts', 'printers', 'stations',
  'bookings', 'members', 'media', 'reports', 'settings', 'register',
  'ingredients', 'users', 'dashboard',
];
routeNames.forEach(name => {
  try {
    const r = require(`./routes/${name}`);
    app.use(`/api/${name}`, r);
  } catch (e) {
    // route file not found — fallback to empty stub
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
app.use(express.static(publicDir));

// SPA fallback — NOT for API paths
app.get('/{*p}', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'API route not found' });
  if (req.path.startsWith('/admin')) {
    const p = path.join(publicDir, 'admin', 'index.html');
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  const uiIndex = path.join(publicDir, 'ui', 'index.html');
  if (fs.existsSync(uiIndex)) return res.sendFile(uiIndex);
  res.status(404).send('Not found');
});

// Start
async function start() {
  await initDB();
  app.listen(PORT, '0.0.0.0', () => console.log(`[shared-backend] Running on port ${PORT}`));
}
start().catch(e => { console.error('Failed:', e); process.exit(1); });
