/**
 * Seeder: jalankan dengan `node database/seeds.js`
 * Idempotent — aman dijalankan berkali-kali (INSERT IGNORE)
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

async function seed() {
  console.log('🌱 Running seeds...\n');

  // ─── Users ────────────────────────────────────────────────────
  const users = [
    { name: 'Admin',        email: 'admin@cafeazzura.com',   password: 'admin123',   role: 'admin',  phone: '08111000000', balance: 0,      is_priority: 0 },
    { name: 'Kasir Utama',  email: 'kasir@cafeazzura.com',   password: 'kasir123',   role: 'kasir',  phone: '08111000001', balance: 0,      is_priority: 0 },
    { name: 'Kasir 2',      email: 'kasir2@cafeazzura.com',  password: 'kasir123',   role: 'kasir',  phone: '08111000002', balance: 0,      is_priority: 0 },
    { name: 'Display Dapur',email: 'dapur@cafeazzura.com',   password: 'dapur123',   role: 'kasir',  phone: '08111000007', balance: 0,      is_priority: 0 },
    { name: 'Display Bar',  email: 'bar@cafeazzura.com',     password: 'bar123',     role: 'kasir',  phone: '08111000008', balance: 0,      is_priority: 0 },
    { name: 'Waiter Anton', email: 'waiter@cafeazzura.com',  password: 'waiter123',  role: 'waiter', phone: '08111000003', balance: 0,      is_priority: 0 },
    { name: 'Waiter Budi',  email: 'waiter2@cafeazzura.com', password: 'waiter123',  role: 'waiter', phone: '08111000004', balance: 0,      is_priority: 0 },
    { name: 'Member Demo',  email: 'member@cafeazzura.com',  password: 'member123',  role: 'member', phone: '08111000005', balance: 50000,  is_priority: 0 },
    { name: 'VIP Member',   email: 'vip@cafeazzura.com',     password: 'vip123',     role: 'member', phone: '08111000006', balance: 250000, is_priority: 1 },
  ];

  for (const u of users) {
    const [existing] = await db.query('SELECT id FROM users WHERE email=?', [u.email]);
    if (existing.length > 0) {
      console.log(`  ⏭  User exists: ${u.email}`);
      continue;
    }
    const hash = await bcrypt.hash(u.password, 10);
    await db.query(
      'INSERT INTO users (name,email,password,role,phone,status,balance,is_priority) VALUES (?,?,?,?,?,?,?,?)',
      [u.name, u.email, hash, u.role, u.phone, 'active', u.balance, u.is_priority]
    );
    console.log(`  ✅ Created: ${u.email} (${u.role}) — password: ${u.password}`);
  }

  // ─── Summary ──────────────────────────────────────────────────
  console.log('\n📋 Akun yang tersedia:\n');
  console.log('  Role     | Email                          | Password');
  console.log('  ---------|--------------------------------|----------');
  users.forEach(u => {
    const role = u.role.padEnd(8);
    const email = u.email.padEnd(31);
    console.log(`  ${role} | ${email}| ${u.password}`);
  });
  console.log('');

  process.exit(0);
}

seed().catch(e => { console.error(e); process.exit(1); });
