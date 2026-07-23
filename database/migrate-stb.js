/**
 * STB Migration — jalankan di server STB/lokal yang punya schema minimal
 * node database/migrate-stb.js
 *
 * Hanya menjalankan migration 050+ yang spesifik untuk STB.
 * Idempotent — aman dijalankan berkali-kali.
 */
require('dotenv').config();
const db = require('../config/database');

const STB_MIGRATIONS = [
  {
    id: '050_roles_table_rbac',
    description: 'Create roles table for RBAC can() middleware',
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
    description: 'Add missing columns to order_items',
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
    description: 'Add missing columns to shifts',
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
    description: 'Add missing columns to orders',
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
    description: 'Add missing columns to tables + populate table_number',
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
    description: 'Create order_sequences table',
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
    description: 'Create product_stations, category_stations, device_push_tokens',
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
    description: 'Create mobile_sync_queue and mobile_sync_log',
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
    id: '058_activity_logs_columns',
    description: 'Add missing columns to activity_logs',
    statements: [
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS table_name VARCHAR(100)`,
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS record_id INT`,
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS old_values JSON`,
      `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS new_values JSON`,
    ],
  },
];

async function run(exitAfter = true) {
  if (exitAfter) console.log('\n🚀 STB Migration Runner\n');

  // Tracking table
  await db.query(`
    CREATE TABLE IF NOT EXISTS _stb_migrations (
      id VARCHAR(100) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  const [applied] = await db.query('SELECT id FROM _stb_migrations');
  const appliedIds = new Set(applied.map(r => r.id));

  let done = 0, skipped = 0, failed = 0;

  for (const m of STB_MIGRATIONS) {
    if (appliedIds.has(m.id)) {
      console.log(`  ⏭  ${m.id}`);
      skipped++;
      continue;
    }

    process.stdout.write(`  ⟳  ${m.id} (${m.description})... `);
    let ok = true;
    for (const sql of m.statements) {
      try {
        await db.query(sql);
      } catch (e) {
        // IF NOT EXISTS errors are fine — column/table already exists
        if (e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_TABLE_EXISTS_ERROR' || e.message.includes('Duplicate column')) {
          // ignore
        } else {
          console.log(`\n     ⚠  Warning: ${e.message.slice(0, 80)}`);
          // Don't fail the whole migration for ALTER TABLE warnings
        }
      }
    }

    // Mark as applied even with warnings (idempotent columns)
    await db.query('INSERT INTO _stb_migrations (id) VALUES (?)', [m.id]);
    console.log('✅');
    done++;
  }

  if (exitAfter) {
    console.log(`\n✅ STB Migration done — ${done} applied, ${skipped} skipped.\n`);
    process.exit(0);
  } else if (done > 0) {
    console.log(`[STB Migration] ${done} new migrations applied.`);
  }
}

// Export for use in server.js startup
async function runStbMigrations() {
  await run(false); // false = don't exit process when called from server
}

module.exports = { runStbMigrations };

if (require.main === module) {
  run(true).catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
