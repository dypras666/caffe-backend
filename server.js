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
  // DB connection is handled by config/database.js.
  // This function kept for startup hook only.
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
    await conn.execute(`CREATE TABLE IF NOT EXISTS system_settings (
      id INT AUTO_INCREMENT PRIMARY KEY, setting_key VARCHAR(100) UNIQUE NOT NULL,
      setting_value TEXT, setting_type VARCHAR(20) DEFAULT 'text',
      setting_group VARCHAR(100), label VARCHAR(255),
      description TEXT, is_public TINYINT DEFAULT 0,
      sort_order INT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS tables (
      id INT AUTO_INCREMENT PRIMARY KEY, number INT NOT NULL UNIQUE,
      capacity INT DEFAULT 4, status VARCHAR(20) DEFAULT 'available'
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100),
      email VARCHAR(100) UNIQUE NOT NULL, phone VARCHAR(50),
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'cashier',
      status VARCHAR(20) DEFAULT 'active',
      balance DECIMAL(15,2) DEFAULT 0,
      is_priority TINYINT DEFAULT 0,
      branch_id INT DEFAULT NULL,
      reset_token VARCHAR(255) NULL,
      reset_token_exp DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY, table_id INT,
      customer_name VARCHAR(100), total_amount DECIMAL(10,0) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending', payment_method VARCHAR(20),
      shift_id INT DEFAULT NULL,
      payment_status VARCHAR(20) DEFAULT 'pending',
      order_status VARCHAR(20) DEFAULT 'open',
      total DECIMAL(15,2) DEFAULT 0,
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

    await conn.execute(`CREATE TABLE IF NOT EXISTS rooms (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      capacity INT DEFAULT 0,
      image VARCHAR(255),
      is_active TINYINT(1) DEFAULT 1,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS shifts (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      branch_id INT DEFAULT 1,
      shift_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      status VARCHAR(20) DEFAULT 'open',
      opened_by INT DEFAULT NULL,
      closed_by INT DEFAULT NULL,
      opened_at TIMESTAMP NULL DEFAULT NULL,
      closed_at TIMESTAMP NULL DEFAULT NULL,
      cash_start DECIMAL(15,2) DEFAULT 0,
      cash_end DECIMAL(15,2) DEFAULT 0,
      cash_difference DECIMAL(15,2) DEFAULT 0,
      opening_cash DECIMAL(15,2) DEFAULT 0,
      closing_cash DECIMAL(15,2) DEFAULT 0,
      notes TEXT,
      total_orders INT DEFAULT 0,
      total_revenue DECIMAL(15,2) DEFAULT 0,
      cash_revenue DECIMAL(15,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS payment_methods (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      code VARCHAR(50) NOT NULL UNIQUE,
      type ENUM('cash','digital','transfer','wallet') NOT NULL DEFAULT 'cash',
      account_number VARCHAR(50),
      account_name VARCHAR(100),
      icon VARCHAR(255),
      description TEXT,
      is_active TINYINT(1) DEFAULT 1,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await conn.execute(`INSERT IGNORE INTO payment_methods (name, code, type, sort_order) VALUES
      ('Tunai', 'cash', 'cash', 1),
      ('QRIS', 'qris', 'digital', 2),
      ('Transfer Bank', 'bank_transfer', 'transfer', 3)`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS activity_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT,
      user_email VARCHAR(100),
      user_name VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id INT,
      details TEXT,
      ip_address VARCHAR(45),
      user_agent VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(128) PRIMARY KEY,
      user_id INT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

    conn.release();
    console.log('Tables auto-created');

    // Auto-add missing columns to existing tables
    const autoAlter = async (table, col, def) => {
      try {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      } catch (e) { /* already exists */ }
    };
    await autoAlter('users', 'status', "VARCHAR(20) DEFAULT 'active'");
    await autoAlter('users', 'balance', 'DECIMAL(15,2) DEFAULT 0');
    await autoAlter('users', 'is_priority', 'TINYINT DEFAULT 0');
    await autoAlter('users', 'branch_id', 'INT DEFAULT NULL');
    await autoAlter('tables', 'is_active', 'TINYINT(1) DEFAULT 1');
    await autoAlter('tables', 'room_id', 'INT DEFAULT NULL');
    await autoAlter('tables', 'sort_order', 'INT DEFAULT 0');
    await autoAlter('tables', 'branch_id', 'INT DEFAULT 1');
    await autoAlter('tables', 'maintenance_note', 'VARCHAR(255) DEFAULT NULL');
    await autoAlter('tables', 'manual_close', 'TINYINT(1) DEFAULT 0');
    await autoAlter('tables', 'auto_free_at', 'TIMESTAMP NULL');
    await autoAlter('orders', 'shift_id', 'INT DEFAULT NULL');
    await autoAlter('orders', 'payment_status', "VARCHAR(20) DEFAULT 'pending'");
    await autoAlter('orders', 'order_status', "VARCHAR(20) DEFAULT 'open'");
    await autoAlter('orders', 'total', 'DECIMAL(15,2) DEFAULT 0');
    // Sync total = total_amount for existing orders
    try { await db.execute('UPDATE orders SET total = total_amount WHERE total = 0 OR total IS NULL'); } catch(e) {}

    // Ensure existing tenants have reset_token columns
    try {
      await db.execute("ALTER TABLE users ADD COLUMN reset_token VARCHAR(255) NULL AFTER role");
      await db.execute("ALTER TABLE users ADD COLUMN reset_token_exp DATETIME NULL AFTER reset_token");
    } catch (e) { /* already exists */ }
    try {
      await db.execute("ALTER TABLE users ADD COLUMN reset_token_exp DATETIME NULL AFTER reset_token");
    } catch (e) { /* already exists */ }

    // Seed default settings (ignore if already exist)
    try {
      const [exist] = await db.execute("SELECT 1 FROM system_settings WHERE setting_key = 'cafe_name'");
      if (!exist || !exist.length) {
        await db.execute("INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, is_public, sort_order) VALUES ('cafe_name', ?, 'text', 'general', 'Nama Cafe', 1, 1)", [process.env.TENANT_NAME || 'Cafe']);
        await db.execute("INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, is_public, sort_order) VALUES ('cafe_address', '', 'text', 'general', 'Alamat Cafe', 1, 2)");
      }
    } catch (e) { /* non-fatal seed */ }
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

// ─── ROUTE FILES ──────────────────────────────────────────────
const routeNames = [
  'orders', 'products', 'categories', 'tables', 'branches',
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
  app.listen(PORT, '0.0.0.0', () => console.log(`Cafe Backend running on port ${PORT}`));
}
start().catch(e => { console.error('Failed:', e); process.exit(1); });
