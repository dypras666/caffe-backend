/**
 * Migration runner — satu-satunya cara schema dibuat/diupdate.
 * node database/migrate-stb.js
 *
 * Idempotent — aman dijalankan berkali-kali.
 * Install baru: jalankan semua migration dari 001.
 * Existing install: migration yang sudah applied di-skip.
 */
require('dotenv').config();
const db = require('../config/database');

const MIGRATIONS = [
  // ─── 001-010: Core tables ───────────────────────────────────────────────────
  {
    id: '001_categories',
    statements: [
      `CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        is_active TINYINT DEFAULT 1,
        display_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '002_branches',
    statements: [
      `CREATE TABLE IF NOT EXISTS branches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address TEXT,
        phone VARCHAR(50),
        email VARCHAR(255),
        image_url VARCHAR(500),
        is_active TINYINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '003_system_settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS system_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) UNIQUE NOT NULL,
        setting_value TEXT,
        setting_type VARCHAR(20) DEFAULT 'text',
        setting_group VARCHAR(100),
        label VARCHAR(255),
        description TEXT,
        is_public TINYINT DEFAULT 0,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '004_users',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE NOT NULL,
        phone VARCHAR(50),
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'cashier',
        status VARCHAR(20) DEFAULT 'active',
        balance DECIMAL(15,2) DEFAULT 0,
        is_priority TINYINT DEFAULT 0,
        branch_id INT DEFAULT NULL,
        reset_token VARCHAR(255) NULL,
        reset_token_exp DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '005_rooms',
    statements: [
      `CREATE TABLE IF NOT EXISTS rooms (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        capacity INT DEFAULT 0,
        image VARCHAR(255),
        is_active TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '006_tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS tables (
        id INT AUTO_INCREMENT PRIMARY KEY,
        number INT,
        table_number VARCHAR(20),
        name VARCHAR(100),
        capacity INT DEFAULT 4,
        status VARCHAR(20) DEFAULT 'available',
        room_id INT DEFAULT NULL,
        branch_id INT DEFAULT 1,
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        maintenance_note TEXT,
        manual_close TINYINT(1) DEFAULT 0,
        auto_free_at TIMESTAMP NULL
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '007_products',
    statements: [
      `CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        category_id INT,
        price DECIMAL(10,0) NOT NULL,
        description TEXT,
        is_available TINYINT DEFAULT 1,
        image_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '008_members',
    statements: [
      `CREATE TABLE IF NOT EXISTS members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE NOT NULL,
        phone VARCHAR(50),
        password VARCHAR(255) NOT NULL,
        points INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS member_topups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        member_id INT NOT NULL,
        amount DECIMAL(10,0) NOT NULL,
        payment_method VARCHAR(50),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (member_id) REFERENCES members(id)
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '009_shifts',
    statements: [
      `CREATE TABLE IF NOT EXISTS shifts (
        id INT AUTO_INCREMENT PRIMARY KEY,
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
        expected_cash DECIMAL(15,2) DEFAULT 0,
        handover_cash DECIMAL(15,2) DEFAULT 0,
        notes TEXT,
        total_orders INT DEFAULT 0,
        total_revenue DECIMAL(15,2) DEFAULT 0,
        cash_revenue DECIMAL(15,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '010_payment_methods',
    statements: [
      `CREATE TABLE IF NOT EXISTS payment_methods (
        id INT AUTO_INCREMENT PRIMARY KEY,
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
      ) ENGINE=InnoDB`,
      `INSERT IGNORE INTO payment_methods (name, code, type, sort_order) VALUES
        ('Tunai', 'cash', 'cash', 1),
        ('QRIS', 'qris', 'digital', 2),
        ('Transfer Bank', 'bank_transfer', 'transfer', 3)`,
    ],
  },
  {
    id: '011_orders',
    statements: [
      `CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_number VARCHAR(50),
        order_type VARCHAR(20) DEFAULT 'dine-in',
        order_status VARCHAR(20) DEFAULT 'pending',
        payment_status VARCHAR(20) DEFAULT 'pending',
        payment_method VARCHAR(50),
        table_id INT,
        table_number VARCHAR(20),
        customer_name VARCHAR(100),
        customer_email VARCHAR(100),
        customer_phone VARCHAR(50),
        served_by INT DEFAULT NULL,
        branch_id INT DEFAULT NULL,
        shift_id INT DEFAULT NULL,
        subtotal DECIMAL(10,0) DEFAULT 0,
        tax DECIMAL(10,0) DEFAULT 0,
        discount DECIMAL(10,0) DEFAULT 0,
        voucher_code VARCHAR(50),
        voucher_discount DECIMAL(10,0) DEFAULT 0,
        total_amount DECIMAL(10,0) DEFAULT 0,
        total DECIMAL(15,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '012_order_items',
    statements: [
      `CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT,
        product_id INT,
        product_name VARCHAR(200),
        quantity INT DEFAULT 1,
        price DECIMAL(10,0),
        product_price DECIMAL(10,2) DEFAULT 0,
        unit_price DECIMAL(10,2) DEFAULT 0,
        addons_total DECIMAL(10,2) DEFAULT 0,
        subtotal DECIMAL(15,2) DEFAULT 0,
        notes TEXT,
        variants_selected JSON,
        addons_selected JSON,
        station_id INT DEFAULT NULL,
        station_status ENUM('pending','preparing','ready') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '013_activity_logs_sessions',
    statements: [
      `CREATE TABLE IF NOT EXISTS activity_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        user_email VARCHAR(100),
        user_name VARCHAR(100),
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id INT,
        table_name VARCHAR(100),
        record_id INT,
        old_values JSON,
        new_values JSON,
        details TEXT,
        ip_address VARCHAR(45),
        user_agent VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(128) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '014_blog_tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS post_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(150) UNIQUE,
        description TEXT,
        color VARCHAR(20) DEFAULT '#6F4E37',
        parent_id INT DEFAULT NULL,
        display_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS post_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(150) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(200) UNIQUE NOT NULL,
        content LONGTEXT,
        excerpt TEXT,
        post_type VARCHAR(20) DEFAULT 'article',
        cover_image VARCHAR(500),
        status VARCHAR(20) DEFAULT 'draft',
        seo_title VARCHAR(255),
        seo_description TEXT,
        seo_keywords VARCHAR(255),
        allow_comments TINYINT(1) DEFAULT 1,
        views INT DEFAULT 0,
        created_by INT,
        updated_by INT,
        published_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS post_category_relations (
        post_id INT NOT NULL,
        category_id INT NOT NULL,
        PRIMARY KEY (post_id, category_id)
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS post_tag_relations (
        post_id INT NOT NULL,
        tag_id INT NOT NULL,
        PRIMARY KEY (post_id, tag_id)
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS post_galleries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        image_url VARCHAR(500) NOT NULL,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS post_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        user_id INT NOT NULL,
        parent_id INT DEFAULT NULL,
        content TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '015_seed_settings',
    statements: [
      `INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, is_public, sort_order) VALUES
        ('cafe_name',               'Cafe',   'text',    'general', 'Nama Cafe',                              1, 1),
        ('cafe_address',            '',       'text',    'general', 'Alamat Cafe',                            1, 2),
        ('currency_symbol',         'Rp',     'text',    'general', 'Simbol Mata Uang',                       0, 3),
        ('pos_require_shift',       'false',  'boolean', 'pos',     'Wajib Buka Shift Sebelum Transaksi',     0, 1),
        ('pos_allow_no_table',      'true',   'boolean', 'pos',     'Izinkan Order Tanpa Meja',               0, 2),
        ('pos_auto_print_receipt',  'false',  'boolean', 'pos',     'Auto Print Struk Setelah Bayar',         0, 3),
        ('pos_require_payment_method','true', 'boolean', 'pos',     'Wajib Pilih Metode Pembayaran',          0, 4),
        ('topup_enabled',           'false',  'boolean', 'member',  'Aktifkan Fitur Top Up Saldo',            0, 1),
        ('topup_min_amount',        '10000',  'number',  'member',  'Minimum Nominal Top Up (Rp)',            0, 2),
        ('member_registration',     'true',   'boolean', 'member',  'Izinkan Registrasi Member Baru',        0, 3),
        ('enable_booking',          'true',   'boolean', 'booking', 'Aktifkan Fitur Booking',                0, 1),
        ('booking_require_dp',      'false',  'boolean', 'booking', 'Wajib Down Payment',                    0, 2),
        ('booking_dp_amount',       '50',     'number',  'booking', 'Persentase DP (%)',                     0, 3),
        ('table_order_require_member','false','boolean', 'table',   'Wajib Login Member untuk Order QR',     0, 1),
        ('table_order_min_amount',  '0',      'number',  'table',   'Minimum Order via QR (Rp)',             0, 2)`,
    ],
  },

  // ─── 050+: Schema patches (existing installs) ───────────────────────────────
  {
    id: '050_roles_table_rbac',
    statements: [
      `CREATE TABLE IF NOT EXISTS roles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        label VARCHAR(100),
        description TEXT,
        permissions JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
      `INSERT IGNORE INTO roles (name, label, permissions) VALUES
        ('admin','Administrator','{"orders":["read","create","update","delete","update_status","cancel","edit_items"],"products":["read","create","update","delete"],"shifts":["read","create","close"],"tables":["read","update"],"members":["read","create","update"]}'),
        ('kasir','Kasir','{"orders":["read","create","update","update_status","cancel","edit_items"],"products":["read"],"shifts":["read","create","close"],"tables":["read","update"],"members":["read"]}'),
        ('waiter','Waiter','{"orders":["read","create","update_status"],"products":["read"],"tables":["read"],"members":["read"]}')`,
    ],
  },
  {
    id: '051_order_items_columns',
    statements: [
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_price DECIMAL(10,2) DEFAULT 0`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10,2) DEFAULT 0`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS addons_total DECIMAL(10,2) DEFAULT 0`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS subtotal DECIMAL(15,2) DEFAULT 0`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS notes TEXT`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_name VARCHAR(200)`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variants_selected JSON`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS addons_selected JSON`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS station_id INT DEFAULT NULL`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS station_status ENUM('pending','preparing','ready') DEFAULT 'pending'`,
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
  {
    id: '052_shifts_columns',
    statements: [
      `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS expected_cash DECIMAL(15,2) DEFAULT 0`,
      `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS handover_cash DECIMAL(15,2) DEFAULT 0`,
      `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS user_id INT DEFAULT NULL`,
      `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS shift_date DATE`,
      `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS start_time TIME`,
      `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS end_time TIME`,
    ],
  },
  {
    id: '053_orders_columns',
    statements: [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS served_by INT DEFAULT NULL`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_status VARCHAR(20) DEFAULT 'pending'`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number VARCHAR(50)`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'dine-in'`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending'`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10,0) DEFAULT 0`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax DECIMAL(10,0) DEFAULT 0`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount DECIMAL(10,0) DEFAULT 0`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS voucher_code VARCHAR(50)`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS voucher_discount DECIMAL(10,0) DEFAULT 0`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_id INT`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number VARCHAR(20)`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email VARCHAR(100)`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50)`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS shift_id INT`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    ],
  },
  {
    id: '054_tables_columns',
    statements: [
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS table_number VARCHAR(20)`,
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS name VARCHAR(100)`,
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS room_id INT`,
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS branch_id INT`,
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`,
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1`,
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS maintenance_note TEXT`,
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS manual_close TINYINT(1) DEFAULT 0`,
      `ALTER TABLE tables ADD COLUMN IF NOT EXISTS auto_free_at TIMESTAMP NULL`,
      `UPDATE tables SET table_number = CONCAT('A', LPAD(IFNULL(number, id), 2, '0')) WHERE table_number IS NULL`,
      `UPDATE tables SET name = CONCAT('Meja ', IFNULL(table_number, id)) WHERE name IS NULL`,
    ],
  },
  {
    id: '055_order_sequences',
    statements: [
      `CREATE TABLE IF NOT EXISTS order_sequences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        seq_key VARCHAR(50) NOT NULL UNIQUE,
        last_number INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`,
      `INSERT IGNORE INTO order_sequences (seq_key, last_number) VALUES ('order', 0), ('shift', 0)`,
    ],
  },
  {
    id: '056_station_and_push_tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS product_stations (
        product_id INT NOT NULL, station_id INT NOT NULL, PRIMARY KEY (product_id, station_id)
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS category_stations (
        category_id INT NOT NULL, station_id INT NOT NULL, PRIMARY KEY (category_id, station_id)
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS device_push_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL, token VARCHAR(200) NOT NULL, device_name VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_token (user_id, token), INDEX idx_user (user_id)
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '057_mobile_sync_tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS mobile_sync_queue (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(100) NOT NULL, user_id INT NOT NULL,
        local_id VARCHAR(100) NOT NULL, entity_type ENUM('order') DEFAULT 'order',
        payload JSON NOT NULL, checksum VARCHAR(64) NOT NULL,
        status ENUM('pending','processing','done','failed','conflict') DEFAULT 'pending',
        attempts INT DEFAULT 0, server_id INT, server_ref VARCHAR(100),
        conflict_data JSON, error_msg TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP NULL,
        INDEX idx_device (device_id), INDEX idx_status (status),
        UNIQUE KEY uk_device_local (device_id, local_id)
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS mobile_sync_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(100) NOT NULL, user_id INT NOT NULL,
        batch_id VARCHAR(64) NOT NULL, total INT DEFAULT 0,
        done INT DEFAULT 0, failed INT DEFAULT 0, conflict INT DEFAULT 0,
        duration_ms INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_device (device_id)
      ) ENGINE=InnoDB`,
    ],
  },
  {
    id: '059_orders_payment_proof',
    statements: [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_proof_url VARCHAR(500) DEFAULT NULL`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_proof_storage VARCHAR(10) DEFAULT NULL`,
    ],
  },
  {
    id: '058_activity_logs_columns',
    statements: [
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS table_name VARCHAR(100)`,
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS record_id INT`,
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS old_values JSON`,
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS new_values JSON`,
    ],
  },
  {
    id: '059_activity_logs_audit_columns',
    statements: [
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'info'`,
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS module VARCHAR(50)`,
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS description TEXT`
    ],
  },
  {
    id: '060_navigation_menus',
    statements: [
      `CREATE TABLE IF NOT EXISTS navigation_menus (
        id INT AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(100) NOT NULL,
        url VARCHAR(500) NOT NULL,
        icon VARCHAR(50) DEFAULT NULL,
        target VARCHAR(20) DEFAULT '_self',
        sort_order INT DEFAULT 0,
        parent_id INT DEFAULT NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `INSERT IGNORE INTO navigation_menus (id, label, url, icon, sort_order, is_active) VALUES
        (1, 'Home', '/#home', 'Home', 1, 1),
        (2, 'Menu', '/#menu', 'UtensilsCrossed', 2, 1),
        (3, 'Blog', '/blog', 'FileText', 3, 1),
        (4, 'Virtual Tour', '/#tour', 'Eye', 4, 1),
        (5, 'Brew Service', '/#brew', 'Coffee', 5, 1),
        (6, 'Booking', '/#booking', 'CalendarCheck', 6, 1),
        (7, 'Gallery', '/#gallery', 'Image', 7, 1),
        (8, 'Contact', '/#contact', 'Phone', 8, 1)`,
    ],
  },
];

async function run(exitAfter = true) {
  if (exitAfter) console.log('\n=== Migration Runner ===\n');

  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id VARCHAR(100) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // Migrate from old _stb_migrations table if it exists
  try {
    const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM _stb_migrations`);
    if (row.n > 0) {
      await db.query(`INSERT IGNORE INTO _migrations (id, applied_at) SELECT id, applied_at FROM _stb_migrations`);
    }
  } catch (e) { /* _stb_migrations doesn't exist — that's fine */ }

  const [applied] = await db.query('SELECT id FROM _migrations');
  const appliedIds = new Set(applied.map(r => r.id));

  let done = 0, skipped = 0;

  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id)) {
      if (exitAfter) process.stdout.write('.');
      skipped++;
      continue;
    }

    if (exitAfter) process.stdout.write(`\n  + ${m.id} ... `);
    for (const sql of m.statements) {
      try {
        await db.query(sql);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME' && e.code !== 'ER_TABLE_EXISTS_ERROR' && !e.message.includes('Duplicate column')) {
          if (exitAfter) process.stdout.write(`\n    ! ${e.message.slice(0, 100)}\n  `);
        }
      }
    }
    await db.query('INSERT INTO _migrations (id) VALUES (?)', [m.id]);
    if (exitAfter) process.stdout.write('OK');
    done++;
  }

  if (exitAfter) {
    console.log(`\n\n=== Done: ${done} applied, ${skipped} skipped ===\n`);
    process.exit(0);
  } else if (done > 0) {
    console.log(`[Migration] ${done} new migration(s) applied.`);
  }
}

async function runMigrations() {
  await run(false);
}

module.exports = { runMigrations };

if (require.main === module) {
  run(true).catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
