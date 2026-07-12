const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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

// Database pool
let db;
async function initDB() {
  db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
  });
  // Auto-create missing tables (idempotent per-tenant init)
  try {
    const conn = await db.getConnection();
    await conn.execute(`CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
      description TEXT, is_active TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(200) NOT NULL,
      category_id INT, price DECIMAL(10,0) NOT NULL,
      description TEXT, is_available TINYINT DEFAULT 1,
      image_url VARCHAR(500), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS branches (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL,
      address TEXT, phone VARCHAR(50), email VARCHAR(255),
      image_url VARCHAR(500), is_active TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS settings (
      id INT AUTO_INCREMENT PRIMARY KEY, setting_key VARCHAR(100) UNIQUE NOT NULL,
      setting_value TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS tables (
      id INT AUTO_INCREMENT PRIMARY KEY, number INT NOT NULL UNIQUE,
      capacity INT DEFAULT 4, status VARCHAR(20) DEFAULT 'available'
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100),
      email VARCHAR(100) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'cashier',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY, table_id INT,
      customer_name VARCHAR(100), total_amount DECIMAL(10,0) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending', payment_method VARCHAR(20),
      notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY, order_id INT, product_id INT,
      quantity INT DEFAULT 1, price DECIMAL(10,0),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS members (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100),
      email VARCHAR(100) UNIQUE NOT NULL, phone VARCHAR(50),
      password VARCHAR(255) NOT NULL, points INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS member_topups (
      id INT AUTO_INCREMENT PRIMARY KEY, member_id INT NOT NULL,
      amount DECIMAL(10,0) NOT NULL, payment_method VARCHAR(50),
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (member_id) REFERENCES members(id)
    )`);
    conn.release();
    console.log('Tables auto-created');
  } catch (e) { console.error('Table init error (non-fatal):', e.message); }
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

// ─── DASHBOARD ──────────────────────────────────────────────────
app.get('/api/dashboard/stats', authenticate, async (req, res) => {
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
  'stock', 'recipes', 'units', 'variants', 'expenses', 'hr',
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
  app.listen(PORT, '0.0.0.0', () => console.log(`Cafe Backend running on port ${PORT}`));
}
start().catch(e => { console.error('Failed:', e); process.exit(1); });
