require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

async function seedDemo() {
  console.log('Menjalankan Seeder Demo (Stations, Products, Variants, Shifts, Modules)...');

  try {
    // 1. ENABLE ALL MODULES & SETTINGS
    console.log('  1. Mengaktifkan Modul & Pengaturan...');
    const settings = [
      ['hr_enabled', 'true', 'boolean', 'features', 'Enable HR Module', 1],
      ['shift_enabled', 'true', 'boolean', 'features', 'Enable Shift Module', 1],
      ['inventory_enabled', 'true', 'boolean', 'features', 'Enable Inventory', 1],
      ['wifi_enabled', 'true', 'boolean', 'features', 'Enable WiFi', 1],
      ['enable_booking', 'true', 'boolean', 'features', 'Enable Booking', 1],
      ['enable_takeaway', 'true', 'boolean', 'features', 'Enable Takeaway', 1],
      ['enable_delivery', 'true', 'boolean', 'features', 'Enable Delivery', 1],
      ['pos_require_shift', 'true', 'boolean', 'pos', 'Wajib Buka Shift Sebelum Transaksi', 1]
    ];
    for (const [key, val, type, group, label, pub] of settings) {
      await db.query(`
        INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, is_public) 
        VALUES (?, ?, ?, ?, ?, ?) 
        ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), is_public=VALUES(is_public)
      `, [key, val, type, group, label, pub]);
    }

    // 2. STATIONS
    console.log('  2. Membuat Stations...');
    const stations = [
      { name: 'Kasir', code: 'KSR', type: 'cashier' },
      { name: 'Bar', code: 'BAR', type: 'bar' },
      { name: 'Kitchen', code: 'KTN', type: 'kitchen' }
    ];
    for (const st of stations) {
      await db.query(`
        INSERT IGNORE INTO stations (name, code, type, is_active) 
        VALUES (?, ?, ?, 1)
      `, [st.name, st.code, st.type]);
    }

    // 3. SHIFTS
    console.log('  3. Membuat Template Shift...');
    await db.query('CREATE TABLE IF NOT EXISTS work_shifts (id INT AUTO_INCREMENT PRIMARY KEY, shift_name VARCHAR(100), start_time TIME, end_time TIME, break_minutes INT, is_active TINYINT DEFAULT 1)');
    const shifts = [
      { name: 'Shift Pagi', start: '07:00:00', end: '15:00:00', break: 60 },
      { name: 'Shift Siang', start: '11:00:00', end: '19:00:00', break: 60 },
      { name: 'Shift Malam', start: '15:00:00', end: '23:00:00', break: 60 }
    ];
    for (const sh of shifts) {
      const [res] = await db.query('SELECT id FROM work_shifts WHERE shift_name = ?', [sh.name]);
      if (res.length === 0) {
        await db.query('INSERT INTO work_shifts (shift_name, start_time, end_time, break_minutes, is_active) VALUES (?, ?, ?, ?, 1)', [sh.name, sh.start, sh.end, sh.break]);
      }
    }

    // 4. USERS (Demo)
    console.log('  4. Membuat Demo Users...');
    const users = [
      { name: 'Demo Kasir', email: 'kasir@demo.com', role: 'kasir' },
      { name: 'Demo Bar', email: 'bar@demo.com', role: 'kasir' },
      { name: 'Demo Kitchen', email: 'kitchen@demo.com', role: 'kasir' }
    ];
    const defaultPassword = await bcrypt.hash('kasir123', 10);
    for (const u of users) {
      await db.query('INSERT IGNORE INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, "active")', [u.name, u.email, defaultPassword, u.role]);
    }

    // 5. CATEGORIES & PRODUCTS (with Variants & Addons)
    console.log('  5. Membuat Produk & Varian...');
    
    // Check tables existence safely
    await db.query(`CREATE TABLE IF NOT EXISTS product_variant_groups (id INT AUTO_INCREMENT PRIMARY KEY, product_id INT, name VARCHAR(100), type VARCHAR(50) DEFAULT 'single', is_required TINYINT DEFAULT 0, sort_order INT DEFAULT 0, is_active TINYINT DEFAULT 1)`);
    await db.query(`CREATE TABLE IF NOT EXISTS product_variant_options (id INT AUTO_INCREMENT PRIMARY KEY, group_id INT, name VARCHAR(100), price_modifier DECIMAL(10,2) DEFAULT 0, is_default TINYINT DEFAULT 0, sort_order INT DEFAULT 0, is_active TINYINT DEFAULT 1)`);
    await db.query(`CREATE TABLE IF NOT EXISTS product_addon_groups (id INT AUTO_INCREMENT PRIMARY KEY, product_id INT, name VARCHAR(100), max_selection INT DEFAULT 1, sort_order INT DEFAULT 0, is_active TINYINT DEFAULT 1)`);
    await db.query(`CREATE TABLE IF NOT EXISTS product_addons (id INT AUTO_INCREMENT PRIMARY KEY, group_id INT, name VARCHAR(100), price DECIMAL(10,2) DEFAULT 0, max_qty INT DEFAULT 1, sort_order INT DEFAULT 0, is_active TINYINT DEFAULT 1)`);
    await db.query(`CREATE TABLE IF NOT EXISTS product_stations (product_id INT NOT NULL, station_id INT NOT NULL, PRIMARY KEY (product_id, station_id))`);
    
    const [catRes1] = await db.query('INSERT IGNORE INTO categories (name, slug, display_order) VALUES (?, ?, ?)', ['Kopi', 'kopi', 1]);
    const catId1 = catRes1.insertId || (await db.query('SELECT id FROM categories WHERE slug="kopi"'))[0][0].id;

    const [catRes2] = await db.query('INSERT IGNORE INTO categories (name, slug, display_order) VALUES (?, ?, ?)', ['Makanan', 'makanan', 2]);
    const catId2 = catRes2.insertId || (await db.query('SELECT id FROM categories WHERE slug="makanan"'))[0][0].id;

    const [barIdRes] = await db.query('SELECT id FROM stations WHERE code="BAR"');
    const barId = barIdRes.length ? barIdRes[0].id : 1;

    const [ktnIdRes] = await db.query('SELECT id FROM stations WHERE code="KTN"');
    const ktnId = ktnIdRes.length ? ktnIdRes[0].id : 1;

    // PRODUK 1: Americano (BAR)
    const [p1Res] = await db.query('INSERT IGNORE INTO products (category_id, name, slug, price, stock, is_available) VALUES (?, ?, ?, ?, ?, 1)', [catId1, 'Americano', 'americano', 20000, 100]);
    const p1Id = p1Res.insertId || (await db.query('SELECT id FROM products WHERE slug="americano"'))[0][0].id;
    await db.query('INSERT IGNORE INTO product_stations (product_id, station_id) VALUES (?, ?)', [p1Id, barId]);

    // Variant: Suhu (Hot/Ice)
    const [vg1Res] = await db.query('INSERT INTO product_variant_groups (product_id, name, type, is_required) VALUES (?, ?, ?, 1)', [p1Id, 'Suhu', 'single']);
    const vg1Id = vg1Res.insertId;
    await db.query('INSERT INTO product_variant_options (group_id, name, price_modifier, is_default) VALUES (?, ?, ?, 1)', [vg1Id, 'Hot', 0]);
    await db.query('INSERT INTO product_variant_options (group_id, name, price_modifier, is_default) VALUES (?, ?, ?, 0)', [vg1Id, 'Ice', 3000]);

    // Addon: Gula
    const [ag1Res] = await db.query('INSERT INTO product_addon_groups (product_id, name, max_selection) VALUES (?, ?, 1)', [p1Id, 'Ekstra Gula']);
    const ag1Id = ag1Res.insertId;
    await db.query('INSERT INTO product_addons (group_id, name, price) VALUES (?, ?, ?)', [ag1Id, 'Dengan Gula', 0]);
    await db.query('INSERT INTO product_addons (group_id, name, price) VALUES (?, ?, ?)', [ag1Id, 'Tanpa Gula', 0]);

    // PRODUK 2: Nasi Goreng (KITCHEN)
    const [p2Res] = await db.query('INSERT IGNORE INTO products (category_id, name, slug, price, stock, is_available) VALUES (?, ?, ?, ?, ?, 1)', [catId2, 'Nasi Goreng Spesial', 'nasi-goreng-spesial', 35000, 50]);
    const p2Id = p2Res.insertId || (await db.query('SELECT id FROM products WHERE slug="nasi-goreng-spesial"'))[0][0].id;
    await db.query('INSERT IGNORE INTO product_stations (product_id, station_id) VALUES (?, ?)', [p2Id, ktnId]);

    // Variant: Level Pedas
    const [vg2Res] = await db.query('INSERT INTO product_variant_groups (product_id, name, type, is_required) VALUES (?, ?, ?, 1)', [p2Id, 'Level Pedas', 'single']);
    const vg2Id = vg2Res.insertId;
    await db.query('INSERT INTO product_variant_options (group_id, name) VALUES (?, ?)', [vg2Id, 'Tidak Pedas']);
    await db.query('INSERT INTO product_variant_options (group_id, name) VALUES (?, ?)', [vg2Id, 'Sedang']);
    await db.query('INSERT INTO product_variant_options (group_id, name) VALUES (?, ?)', [vg2Id, 'Sangat Pedas']);

    // Addon: Topping
    const [ag2Res] = await db.query('INSERT INTO product_addon_groups (product_id, name, max_selection) VALUES (?, ?, 3)', [p2Id, 'Topping Tambahan']);
    const ag2Id = ag2Res.insertId;
    await db.query('INSERT INTO product_addons (group_id, name, price) VALUES (?, ?, ?)', [ag2Id, 'Telur Ceplok', 5000]);
    await db.query('INSERT INTO product_addons (group_id, name, price) VALUES (?, ?, ?)', [ag2Id, 'Sosis', 7000]);
    await db.query('INSERT INTO product_addons (group_id, name, price) VALUES (?, ?, ?)', [ag2Id, 'Keju', 4000]);

    console.log('Seeding Demo selesai.');
    process.exit(0);
  } catch (err) {
    console.error('Gagal menjalankan seeder demo:', err);
    process.exit(1);
  }
}

seedDemo();
