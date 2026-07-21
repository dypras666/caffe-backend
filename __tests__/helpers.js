const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const bcrypt = require('bcryptjs');

// Wait for DB/server init before tests run
beforeAll(async () => { if (app.ready) await app.ready; }, 15000);

let cachedAdminToken = null;
let cachedKasirToken = null;
let cachedWaiterToken = null;
let cachedMemberToken = null;

const getAdminToken = async () => {
  if (cachedAdminToken) return cachedAdminToken;
  // Try env-specified admin email first, then fallback options
  const candidates = [
    { email: process.env.TEST_ADMIN_EMAIL || 'admin@cafeazzura.com', password: process.env.TEST_ADMIN_PASSWORD || 'admin123' },
    { email: 'admin@cafeazzura.com', password: 'admin123' },
  ];
  for (const cred of candidates) {
    const res = await request(app).post('/api/auth/login').send(cred);
    if (res.body.token) { cachedAdminToken = res.body.token; return cachedAdminToken; }
  }
  // Auto-create admin user for test environment
  const email = 'admin.test@cafeazzura.com';
  const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (rows.length === 0) {
    const hashed = await bcrypt.hash('admin123', 10);
    await db.query(
      'INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, ?)',
      ['Admin Test', email, hashed, 'admin', 'active']
    );
  }
  const res = await request(app).post('/api/auth/login').send({ email, password: 'admin123' });
  if (!res.body.token) throw new Error(`Admin login failed: ${JSON.stringify(res.body)}`);
  cachedAdminToken = res.body.token;
  return cachedAdminToken;
};

const getKasirToken = async () => {
  if (cachedKasirToken) return cachedKasirToken;
  const email = 'kasir.test@cafeazzura.com';
  const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (rows.length === 0) {
    const hashed = await bcrypt.hash('kasir123', 10);
    await db.query(
      'INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, ?)',
      ['Kasir Test', email, hashed, 'kasir', 'active']
    );
  }
  const res = await request(app).post('/api/auth/login').send({ email, password: 'kasir123' });
  if (!res.body.token) throw new Error(`Kasir login failed: ${JSON.stringify(res.body)}`);
  cachedKasirToken = res.body.token;
  return cachedKasirToken;
};

const getWaiterToken = async () => {
  if (cachedWaiterToken) return cachedWaiterToken;
  const email = 'waiter.test@cafeazzura.com';
  const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (rows.length === 0) {
    const hashed = await bcrypt.hash('waiter123', 10);
    await db.query(
      'INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, ?)',
      ['Waiter Test', email, hashed, 'waiter', 'active']
    );
  }
  const res = await request(app).post('/api/auth/login').send({ email, password: 'waiter123' });
  if (!res.body.token) throw new Error(`Waiter login failed: ${JSON.stringify(res.body)}`);
  cachedWaiterToken = res.body.token;
  return cachedWaiterToken;
};

const getMemberToken = async () => {
  if (cachedMemberToken) return cachedMemberToken;
  const email = 'member.test@cafeazzura.com';
  const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (rows.length === 0) {
    const hashed = await bcrypt.hash('member123', 10);
    await db.query(
      'INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, ?)',
      ['Member Test', email, hashed, 'member', 'active']
    );
  }
  const res = await request(app).post('/api/auth/login').send({ email, password: 'member123' });
  if (!res.body.token) throw new Error(`Member login failed: ${JSON.stringify(res.body)}`);
  cachedMemberToken = res.body.token;
  return cachedMemberToken;
};

const cleanupTestUsers = async () => {
  await db.query('DELETE FROM users WHERE email IN (?,?,?,?)', [
    'kasir.test@cafeazzura.com',
    'waiter.test@cafeazzura.com',
    'member.test@cafeazzura.com',
    'crud.test@cafeazzura.com',
  ]);
  cachedKasirToken = null;
  cachedWaiterToken = null;
  cachedMemberToken = null;
};

// Legacy compat
const cleanupKasir = async () => {
  await db.query('DELETE FROM users WHERE email = ?', ['kasir.test@cafeazzura.com']);
  cachedKasirToken = null;
};

const resetTokenCache = () => {
  cachedAdminToken = null;
  cachedKasirToken = null;
  cachedWaiterToken = null;
  cachedMemberToken = null;
};

module.exports = {
  getAdminToken, getKasirToken, getWaiterToken, getMemberToken,
  cleanupKasir, cleanupTestUsers, resetTokenCache,
};

// Get waiter token
const getWaiterTokenFresh = async () => {
  const email = `waiter.fresh.${Date.now()}@test.com`;
  const hashed = await require('bcryptjs').hash('waiter123', 10);
  await db.query('INSERT INTO users (name,email,password,role,status) VALUES (?,?,?,?,?)', ['Waiter Fresh', email, hashed, 'waiter', 'active']);
  const res = await require('supertest')(require('../server')).post('/api/auth/login').send({ email, password: 'waiter123' });
  return { token: res.body.token, email };
};
module.exports.getWaiterTokenFresh = getWaiterTokenFresh;
