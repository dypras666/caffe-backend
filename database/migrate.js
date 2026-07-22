/**
 * Migration runner — jalankan dengan: node database/migrate.js
 *
 * Idempotent: aman dijalankan berkali-kali.
 * Setiap migration dicek via tabel `_migrations` sebelum dijalankan.
 */
require('dotenv').config();
const db = require('../config/database');

const MIGRATIONS = [
  {
    id: '001_extend_users',
    sql: `
      ALTER TABLE users
        MODIFY COLUMN role ENUM('admin','kasir','waiter','member') DEFAULT 'kasir',
        ADD COLUMN IF NOT EXISTS balance DECIMAL(10,2) DEFAULT 0.00,
        ADD COLUMN IF NOT EXISTS is_priority TINYINT(1) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS member_number VARCHAR(20) UNIQUE DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS member_since DATE DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS total_orders INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_spent DECIMAL(14,2) DEFAULT 0;
    `,
  },
  {
    id: '002_member_number_trigger',
    // Trigger must be run as separate statements — use raw flag
    raw: true,
    statements: [
      `DROP TRIGGER IF EXISTS trg_member_number`,
      `CREATE TRIGGER trg_member_number
       BEFORE INSERT ON users
       FOR EACH ROW
       BEGIN
         IF NEW.role = 'member' AND NEW.member_number IS NULL THEN
           SET NEW.member_number = CONCAT('MBR-', LPAD(
             (SELECT COALESCE(MAX(CAST(SUBSTRING(member_number, 5) AS UNSIGNED)), 10000) + 1
              FROM users WHERE role = 'member'), 5, '0'));
           SET NEW.member_since = CURDATE();
         END IF;
       END`,
    ],
  },
  {
    id: '003_order_sequences',
    sql: `
      CREATE TABLE IF NOT EXISTS order_sequences (
        id INT PRIMARY KEY AUTO_INCREMENT,
        seq_key VARCHAR(50) NOT NULL UNIQUE,
        last_number INT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO order_sequences (seq_key, last_number) VALUES
        ('order', 0), ('booking', 0), ('po', 0), ('opname', 0), ('expense', 0);
    `,
  },
  {
    id: '004_payment_methods',
    sql: `
      CREATE TABLE IF NOT EXISTS payment_methods (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(50) NOT NULL UNIQUE,
        type ENUM('cash','digital','transfer','wallet') NOT NULL,
        icon VARCHAR(255),
        description TEXT,
        is_active TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO payment_methods (name, code, type, sort_order) VALUES
        ('Tunai',             'cash',    'cash',     1),
        ('Kartu Debit/Kredit','card',    'digital',  2),
        ('QRIS',              'qris',    'digital',  3),
        ('Transfer Bank',     'transfer','transfer', 4),
        ('Saldo Member',      'balance', 'wallet',   5);
    `,
  },
  {
    id: '005_balance_transactions',
    sql: `
      CREATE TABLE IF NOT EXISTS balance_transactions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        type ENUM('topup','deduct','refund') NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        balance_before DECIMAL(10,2) NOT NULL,
        balance_after DECIMAL(10,2) NOT NULL,
        reference_type VARCHAR(50),
        reference_id INT,
        note TEXT,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB;
    `,
  },
  {
    id: '006_topup_requests',
    sql: `
      CREATE TABLE IF NOT EXISTS topup_requests (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        payment_method VARCHAR(50) DEFAULT 'transfer',
        reference VARCHAR(100),
        note TEXT,
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        approved_by INT,
        approved_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user (user_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB;
    `,
  },
  {
    id: '007_rooms_and_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS rooms (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        capacity INT DEFAULT 0,
        image VARCHAR(255),
        is_active TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;

      ALTER TABLE \`tables\`
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT 1,
        ADD COLUMN IF NOT EXISTS maintenance_note VARCHAR(255) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS manual_close TINYINT(1) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS auto_free_at TIMESTAMP NULL;
    `,
  },
  {
    id: '008_table_auto_free_trigger',
    desc: 'MySQL EVENT to auto-free occupied tables with no active orders every 5 minutes',
    sql: `
      SET GLOBAL event_scheduler = ON;

      DROP EVENT IF EXISTS evt_auto_free_tables;
      CREATE EVENT evt_auto_free_tables
      ON SCHEDULE EVERY 5 MINUTE
      DO
        UPDATE \`tables\` t
        SET t.status = 'available', t.auto_free_at = NULL
        WHERE t.status = 'occupied'
          AND t.manual_close = 0
          AND (
            (t.auto_free_at IS NOT NULL AND t.auto_free_at <= NOW())
            OR NOT EXISTS (
              SELECT 1 FROM orders o
              WHERE o.table_id = t.id
                AND o.order_status NOT IN ('completed','cancelled')
            )
          );
    `,
    optional: true, // MySQL EVENT scheduler may not be available on all setups
  },
  {
    id: '009_printers',
    sql: `
      CREATE TABLE IF NOT EXISTS printers (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        type ENUM('receipt','kitchen','bar','label') NOT NULL DEFAULT 'receipt',
        connection ENUM('browser','network','usb') NOT NULL DEFAULT 'browser',
        ip VARCHAR(50),
        port INT DEFAULT 9100,
        paper_width ENUM('58mm','80mm') DEFAULT '80mm',
        char_per_line INT DEFAULT 42,
        is_default TINYINT(1) DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        auto_cut TINYINT(1) DEFAULT 1,
        header_text TEXT,
        footer_text TEXT,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO printers (name,type,connection,paper_width,char_per_line,is_default,is_active,header_text,footer_text,sort_order) VALUES
        ('Receipt Kasir','receipt','browser','80mm',42,1,1,'Café Azzura\nTerima kasih telah berkunjung!','Simpan struk ini sebagai bukti pembayaran.',1),
        ('Printer Dapur', 'kitchen','browser','80mm',42,0,1,'KITCHEN TICKET','',2),
        ('Printer Bar',   'bar',    'browser','58mm',32,0,1,'BAR TICKET','',3);
    `,
  },
  {
    id: '010_stations',
    sql: `
      CREATE TABLE IF NOT EXISTS stations (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(30) UNIQUE NOT NULL,
        type ENUM('kitchen','bar','cashier','service','other') DEFAULT 'kitchen',
        printer_id INT DEFAULT NULL,
        auto_print TINYINT(1) DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        display_color VARCHAR(20) DEFAULT '#6F4E37',
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO stations (name,code,type,auto_print,is_active,display_color,sort_order) VALUES
        ('Dapur', 'KITCHEN','kitchen',1,1,'#E67E22',1),
        ('Bar',   'BAR',    'bar',    1,1,'#8E44AD',2),
        ('Kasir', 'CASHIER','cashier',0,1,'#2980B9',3),
        ('Waiter','WAITER', 'service',0,1,'#27AE60',4);

      CREATE TABLE IF NOT EXISTS product_stations (
        product_id INT NOT NULL, station_id INT NOT NULL,
        PRIMARY KEY (product_id, station_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS category_stations (
        category_id INT NOT NULL, station_id INT NOT NULL,
        PRIMARY KEY (category_id, station_id),
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
        FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;

      ALTER TABLE order_items
        ADD COLUMN IF NOT EXISTS station_id INT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS station_status ENUM('pending','preparing','ready') DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS addons_total DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS variants_selected JSON DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS addons_selected JSON DEFAULT NULL;
    `,
  },
  {
    id: '011_stock_management',
    sql: `
      CREATE TABLE IF NOT EXISTS suppliers (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) UNIQUE,
        contact_person VARCHAR(255), phone VARCHAR(50), email VARCHAR(255),
        address TEXT, is_active TINYINT(1) DEFAULT 1, notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO suppliers (name,code,contact_person,phone) VALUES ('Supplier Umum','SUP-001','Admin','08123456789');

      CREATE TABLE IF NOT EXISTS ingredients (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) UNIQUE,
        unit VARCHAR(30) NOT NULL DEFAULT 'gram',
        unit_id INT DEFAULT NULL,
        unit_cost DECIMAL(12,4) DEFAULT 0,
        stock_qty DECIMAL(12,3) DEFAULT 0,
        min_stock DECIMAL(12,3) DEFAULT 0,
        supplier_id INT,
        notes TEXT, is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
        INDEX idx_name (name)
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS recipes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        product_id INT NOT NULL UNIQUE,
        notes TEXT, yield_qty DECIMAL(8,3) DEFAULT 1, yield_unit VARCHAR(30) DEFAULT 'porsi',
        prep_time_min INT DEFAULT 0, last_cost DECIMAL(12,4) DEFAULT 0,
        created_by INT, updated_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS recipe_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        recipe_id INT NOT NULL, ingredient_id INT NOT NULL,
        qty DECIMAL(12,3) NOT NULL, unit VARCHAR(30) NOT NULL,
        waste_pct DECIMAL(5,2) DEFAULT 0, notes VARCHAR(255),
        FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
        FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE,
        UNIQUE KEY uniq_recipe_ingredient (recipe_id,ingredient_id)
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS stock_cards (
        id INT PRIMARY KEY AUTO_INCREMENT,
        product_id INT NOT NULL,
        movement_type ENUM('in','out','adjustment','opname','waste','return') NOT NULL,
        reference_type VARCHAR(50), reference_id INT,
        qty_before INT NOT NULL DEFAULT 0, qty_change INT NOT NULL, qty_after INT NOT NULL DEFAULT 0,
        unit_cost DECIMAL(10,2) DEFAULT 0, note TEXT, created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product (product_id), INDEX idx_created (created_at)
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS stock_opnames (
        id INT PRIMARY KEY AUTO_INCREMENT,
        opname_number VARCHAR(50) UNIQUE NOT NULL,
        status ENUM('draft','in_progress','completed','cancelled') DEFAULT 'draft',
        opname_date DATE NOT NULL, notes TEXT,
        created_by INT, approved_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS stock_opname_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        opname_id INT NOT NULL, product_id INT NOT NULL,
        qty_system INT NOT NULL DEFAULT 0, qty_actual INT NOT NULL DEFAULT 0,
        qty_diff INT GENERATED ALWAYS AS (qty_actual - qty_system) STORED,
        unit_cost DECIMAL(10,2) DEFAULT 0, notes TEXT,
        FOREIGN KEY (opname_id) REFERENCES stock_opnames(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS purchase_orders (
        id INT PRIMARY KEY AUTO_INCREMENT,
        po_number VARCHAR(50) UNIQUE NOT NULL, supplier_id INT,
        status ENUM('draft','ordered','partial','received','cancelled') DEFAULT 'draft',
        order_date DATE NOT NULL, expected_date DATE, received_date DATE,
        subtotal DECIMAL(12,2) DEFAULT 0, discount DECIMAL(12,2) DEFAULT 0,
        tax DECIMAL(12,2) DEFAULT 0, total DECIMAL(12,2) DEFAULT 0,
        notes TEXT, created_by INT, approved_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
        INDEX idx_status (status), INDEX idx_date (order_date)
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        po_id INT NOT NULL, product_id INT, ingredient_id INT,
        product_name VARCHAR(255) NOT NULL, unit VARCHAR(50) DEFAULT 'pcs',
        qty_ordered INT NOT NULL DEFAULT 0, qty_received INT DEFAULT 0,
        unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0, subtotal DECIMAL(12,2) NOT NULL DEFAULT 0, notes TEXT,
        FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `,
  },
  {
    id: '012_units',
    sql: `
      CREATE TABLE IF NOT EXISTS units (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(50) NOT NULL, symbol VARCHAR(20) NOT NULL,
        type ENUM('weight','volume','count','length','other') DEFAULT 'count',
        base_unit_id INT DEFAULT NULL, conversion_factor DECIMAL(14,6) DEFAULT 1.000000,
        is_active TINYINT(1) DEFAULT 1, sort_order INT DEFAULT 0,
        FOREIGN KEY (base_unit_id) REFERENCES units(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO units (name,symbol,type,conversion_factor,sort_order) VALUES
        ('Gram','g','weight',1,1),('Kilogram','kg','weight',1000,2),('Milligram','mg','weight',0.001,3),
        ('Mililiter','ml','volume',1,4),('Liter','L','volume',1000,5),
        ('Pieces','pcs','count',1,6),('Pack','pak','count',1,7),('Box','box','count',1,8),
        ('Porsi','porsi','count',1,9),('Shot','shot','count',1,10),
        ('Sendok','sdm','volume',15,11),('Cangkir','cup','volume',240,12);
      UPDATE units u JOIN units base ON base.symbol='g'  SET u.base_unit_id=base.id WHERE u.symbol IN ('kg','mg') AND u.base_unit_id IS NULL;
      UPDATE units u JOIN units base ON base.symbol='ml' SET u.base_unit_id=base.id WHERE u.symbol IN ('L','sdm','cup') AND u.base_unit_id IS NULL;
    `,
  },
  {
    id: '013_expenses',
    sql: `
      CREATE TABLE IF NOT EXISTS expense_categories (
        id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100) NOT NULL,
        code VARCHAR(30) UNIQUE, parent_id INT,
        type ENUM('operational','cogs','capex','other') DEFAULT 'operational',
        is_active TINYINT(1) DEFAULT 1, sort_order INT DEFAULT 0,
        FOREIGN KEY (parent_id) REFERENCES expense_categories(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO expense_categories (name,code,type,sort_order) VALUES
        ('Bahan Baku & COGS','COGS','cogs',1),('Operasional','OPS','operational',2),
        ('Gaji & Tunjangan','SALARY','operational',3),('Listrik & Air','UTILITY','operational',4),
        ('Sewa Tempat','RENT','operational',5),('Marketing & Promosi','MKTG','operational',6),
        ('Perlengkapan & Alat','EQUIP','capex',7),('Pemeliharaan','MAINT','operational',8),
        ('Transportasi','TRANS','operational',9),('Lain-lain','OTHER','other',10);

      CREATE TABLE IF NOT EXISTS expenses (
        id INT PRIMARY KEY AUTO_INCREMENT,
        expense_number VARCHAR(50) UNIQUE NOT NULL, category_id INT,
        title VARCHAR(255) NOT NULL, amount DECIMAL(12,2) NOT NULL,
        expense_date DATE NOT NULL, payment_method VARCHAR(50) DEFAULT 'cash',
        reference VARCHAR(100), description TEXT, attachment VARCHAR(255),
        status ENUM('draft','approved','rejected') DEFAULT 'approved',
        created_by INT, approved_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
        INDEX idx_date (expense_date)
      ) ENGINE=InnoDB;
    `,
  },
  {
    id: '014_branches_and_qr',
    sql: `
      CREATE TABLE IF NOT EXISTS branches (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(150) NOT NULL, code VARCHAR(30) UNIQUE NOT NULL,
        address TEXT, phone VARCHAR(50), email VARCHAR(150), city VARCHAR(100),
        is_active TINYINT(1) DEFAULT 1, is_main TINYINT(1) DEFAULT 0,
        timezone VARCHAR(50) DEFAULT 'Asia/Jakarta',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO branches (name,code,address,phone,is_active,is_main) VALUES
        ('Café Azzura - Pusat','MAIN','123 Coffee Street, Brew City','+1 (555) 123-4567',1,1);

      CREATE TABLE IF NOT EXISTS table_qr_codes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        table_id INT NOT NULL, branch_id INT,
        qr_type ENUM('static','dynamic') NOT NULL DEFAULT 'static',
        qr_token VARCHAR(100) UNIQUE, qr_data TEXT, base_url VARCHAR(255),
        radius_enabled TINYINT(1) DEFAULT 0, radius_meters INT DEFAULT 50,
        table_lat DECIMAL(10,7), table_lng DECIMAL(10,7),
        is_active TINYINT(1) DEFAULT 1, scan_count INT DEFAULT 0,
        last_scanned_at TIMESTAMP NULL, expires_at TIMESTAMP NULL, created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (table_id) REFERENCES \`tables\`(id) ON DELETE CASCADE,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
        INDEX idx_token (qr_token), INDEX idx_table (table_id)
      ) ENGINE=InnoDB;
    `,
  },
  {
    id: '015_order_cancel_requests',
    sql: `
      CREATE TABLE IF NOT EXISTS order_cancel_requests (
        id INT PRIMARY KEY AUTO_INCREMENT,
        order_id INT NOT NULL, requested_by INT,
        reason TEXT,
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        reviewed_by INT, reviewed_at TIMESTAMP NULL, note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        INDEX idx_status (status)
      ) ENGINE=InnoDB;
    `,
  },
  {
    id: '016_ingredient_extras',
    sql: `
      CREATE TABLE IF NOT EXISTS ingredient_stock_log (
        id INT PRIMARY KEY AUTO_INCREMENT, ingredient_id INT NOT NULL,
        movement_type ENUM('in','out','adjustment','waste','opname') NOT NULL,
        qty DECIMAL(12,3) NOT NULL, qty_before DECIMAL(12,3) DEFAULT 0,
        qty_after DECIMAL(12,3) DEFAULT 0, reference_type VARCHAR(50), reference_id INT,
        input_qty DECIMAL(12,3), input_unit_id INT, unit_cost DECIMAL(12,4) DEFAULT 0,
        note TEXT, created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE,
        INDEX idx_ingredient (ingredient_id)
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS ingredient_unit_conversions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        ingredient_id INT NOT NULL, unit_name VARCHAR(50) NOT NULL,
        unit_symbol VARCHAR(20) NOT NULL, conversion_qty DECIMAL(14,4) NOT NULL,
        notes VARCHAR(100), sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1,
        FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE,
        UNIQUE KEY uq_ing_unit (ingredient_id, unit_symbol),
        INDEX idx_ing (ingredient_id)
      ) ENGINE=InnoDB;

      ALTER TABLE product_variant_options
        ADD COLUMN IF NOT EXISTS ingredient_id INT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS ingredient_qty DECIMAL(10,3) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ingredient_unit VARCHAR(30) DEFAULT NULL;

      ALTER TABLE product_addons
        ADD COLUMN IF NOT EXISTS ingredient_id INT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS ingredient_qty DECIMAL(10,3) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ingredient_unit VARCHAR(30) DEFAULT NULL;
    `,
  },
  {
    id: '017_print_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS print_jobs (
        id INT PRIMARY KEY AUTO_INCREMENT, order_id INT,
        printer_id INT, job_type ENUM('receipt','kitchen','bar') NOT NULL,
        status ENUM('pending','sent','failed') DEFAULT 'pending',
        raw_data MEDIUMTEXT, error_msg TEXT, created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        INDEX idx_order (order_id)
      ) ENGINE=InnoDB;
    `,
  },
  {
    id: '018_system_settings_extend',
    sql: `
      ALTER TABLE system_settings
        ADD COLUMN IF NOT EXISTS is_public TINYINT(1) DEFAULT 0 AFTER setting_group;

      INSERT IGNORE INTO system_settings (setting_key,label,setting_value,setting_type,setting_group,is_public) VALUES
        -- General
        ('site_name','Nama Café','Café Azzura','text','general',1),
        ('site_tagline','Tagline','Where Every Sip Tells a Story','text','general',1),
        ('site_logo','Logo Café','','image','general',1),
        ('currency_symbol','Simbol Mata Uang','Rp','text','general',1),
        ('tax_rate','Tarif Pajak (%)','0','number','general',0),
        ('opening_hours','Jam Buka','{"mon-fri":"7:00 AM - 10:00 PM","sat-sun":"8:00 AM - 11:00 PM"}','json','general',1),
        -- Contact
        ('contact_email','Email Kontak','info@cafeazzura.com','text','contact',1),
        ('contact_phone','Telepon','','text','contact',1),
        ('contact_address','Alamat','','text','contact',1),
        -- Booking
        ('enable_booking','Aktifkan Booking','true','boolean','booking',1),
        ('booking_require_dp','Wajib Bayar DP','false','boolean','booking',1),
        ('booking_dp_amount','Jumlah DP','50','number','booking',1),
        ('booking_priority_skip_dp','Priority Skip DP','true','boolean','booking',0),
        -- Table settings (auto-close)
        ('pos_require_table','Wajib Pilih Meja','false','boolean','table',0),
        ('table_auto_free_enabled','Auto Bebaskan Meja','true','boolean','table',0),
        ('table_auto_free_hours','Jam Auto Bebas','8','number','table',0),
        ('table_booking_check_overlap','Cek Overlap Booking','true','boolean','table',0),
        ('table_order_max_items','Maks Item per Order Meja','20','number','table',0),
        ('table_order_min_amount','Minimum Order Meja','0','number','table',1),
        ('table_order_payment','Metode Bayar Order Meja','both','text','table',1),
        ('table_order_require_member','Wajib Member untuk Order Meja','false','boolean','table',1),
        -- POS
        ('pos_auto_print_kitchen','Auto Print Tiket Dapur','true','boolean','pos',0),
        ('pos_auto_print_receipt','Auto Print Struk','false','boolean','pos',0),
        ('station_display_refresh','Auto Refresh Display (detik)','10','number','pos',0),
        -- Member
        ('member_registration','Buka Registrasi Member','true','boolean','general',1),
        ('topup_enabled','Aktifkan Top-up Saldo','true','boolean','member',1),
        ('topup_min_amount','Min Top-up (Rp)','10000','number','member',1),
        ('priority_auto_enable','Auto Priority (akumulasi)','false','boolean','member',0),
        ('priority_min_orders','Min Order untuk Priority','20','number','member',0),
        ('priority_min_spent','Min Total Belanja untuk Priority','500000','number','member',0),
        -- QR
        ('qr_base_url','Base URL untuk QR Meja','http://localhost:5174','text','pos',0),
        ('qr_default_type','Tipe QR Default','static','text','pos',0),
        ('qr_radius_enabled','Aktifkan Radius QR','false','boolean','pos',0);
    `,
  },
  {
    id: '019_orders_extend',
    sql: `
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS table_id INT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT 1,
        ADD COLUMN IF NOT EXISTS total_amount DECIMAL(10,2) DEFAULT NULL;
      -- total_amount alias for total (for display)
      UPDATE orders SET total_amount = total WHERE total_amount IS NULL;
    `,
  },
  {
    id: '020_bookings_extend',
    sql: `
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS booking_number VARCHAR(50) UNIQUE,
        ADD COLUMN IF NOT EXISTS user_id INT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS dp_amount DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS dp_paid TINYINT(1) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS dp_payment_method VARCHAR(50),
        ADD COLUMN IF NOT EXISTS payment_status ENUM('unpaid','dp_paid','paid','refunded') DEFAULT 'unpaid',
        ADD COLUMN IF NOT EXISTS total_amount DECIMAL(10,2) DEFAULT 0;
    `,
  },
  {
    id: '021_branch_scoping',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL,
        ADD FOREIGN KEY IF NOT EXISTS fk_users_branch (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

      ALTER TABLE employees
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL,
        ADD FOREIGN KEY IF NOT EXISTS fk_employees_branch (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS roles (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(50) NOT NULL UNIQUE,
        label VARCHAR(100) NOT NULL,
        description TEXT,
        permissions JSON,
        is_system TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;

      INSERT IGNORE INTO roles (name, label, description, is_system) VALUES
        ('admin',  'Administrator', 'Akses penuh ke semua fitur', 1),
        ('kasir',  'Kasir',         'Kelola transaksi dan pesanan', 1),
        ('waiter', 'Waiter',        'Input pesanan meja', 1),
        ('member', 'Member',        'Pelanggan terdaftar', 1);
    `,
  },
  {
    id: '022_balance_type_fix',
    sql: `
      ALTER TABLE balance_transactions
        MODIFY COLUMN type ENUM('topup','deduct','refund','adjustment') NOT NULL;
    `,
  },
  {
    id: '023_branch_point_rules',
    sql: `
      CREATE TABLE IF NOT EXISTS branch_point_rules (
        id INT PRIMARY KEY AUTO_INCREMENT,
        branch_id INT NOT NULL,
        name VARCHAR(100) NOT NULL DEFAULT 'Default',
        points_per_amount DECIMAL(10,4) NOT NULL DEFAULT 1.0,
        min_transaction DECIMAL(12,2) DEFAULT 0,
        multiplier DECIMAL(6,2) DEFAULT 1.00,
        is_active TINYINT(1) DEFAULT 1,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
        INDEX idx_branch (branch_id)
      ) ENGINE=InnoDB;
      INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES
        ('points_enabled', 'false'),
        ('points_per_amount', '1'),
        ('points_min_transaction', '10000');
    `,
  },
  {
    id: '024_stations_branch',
    sql: `
      ALTER TABLE stations
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL,
        ADD FOREIGN KEY IF NOT EXISTS fk_stations_branch (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
    `,
  },
  {
    id: '025_member_points',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS points INT DEFAULT 0;

      CREATE TABLE IF NOT EXISTS point_transactions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        order_id INT DEFAULT NULL,
        branch_id INT DEFAULT NULL,
        type ENUM('earn','redeem','adjust','expire') NOT NULL DEFAULT 'earn',
        points INT NOT NULL,
        points_before INT NOT NULL DEFAULT 0,
        points_after INT NOT NULL DEFAULT 0,
        note VARCHAR(255),
        created_by INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
        INDEX idx_user (user_id),
        INDEX idx_order (order_id)
      ) ENGINE=InnoDB;
    `,
  },
  {
    id: '026_vouchers',
    sql: `
      CREATE TABLE IF NOT EXISTS vouchers (
        id INT PRIMARY KEY AUTO_INCREMENT,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(150) NOT NULL,
        description TEXT,
        type ENUM('free_item','item_discount','total_discount','bonus_points') NOT NULL,
        discount_type ENUM('fixed','percent') DEFAULT NULL,
        discount_value DECIMAL(12,2) DEFAULT 0,
        free_product_id INT DEFAULT NULL,
        free_product_qty INT DEFAULT 1,
        bonus_points_multiplier DECIMAL(6,2) DEFAULT 1.00,
        min_transaction DECIMAL(12,2) DEFAULT 0,
        max_discount DECIMAL(12,2) DEFAULT NULL,
        branch_id INT DEFAULT NULL,
        member_only TINYINT(1) DEFAULT 0,
        usage_limit INT DEFAULT NULL,
        usage_per_member INT DEFAULT 1,
        used_count INT DEFAULT 0,
        valid_from DATETIME DEFAULT NULL,
        valid_until DATETIME DEFAULT NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_by INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
        FOREIGN KEY (free_product_id) REFERENCES products(id) ON DELETE SET NULL,
        INDEX idx_code (code),
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS voucher_usages (
        id INT PRIMARY KEY AUTO_INCREMENT,
        voucher_id INT NOT NULL,
        order_id INT DEFAULT NULL,
        user_id INT DEFAULT NULL,
        discount_applied DECIMAL(12,2) DEFAULT 0,
        free_product_id INT DEFAULT NULL,
        bonus_points INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_voucher (voucher_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB;

      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS voucher_code VARCHAR(50) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS voucher_discount DECIMAL(12,2) DEFAULT 0;
    `,
  },
  {
    id: '031_remove_storage_settings',
    sql: `
      DELETE FROM system_settings
      WHERE setting_key LIKE 'storage_%';
    `,
  },
  {
    id: '030_feature_flags_public',
    sql: `
      UPDATE system_settings
        SET is_public = 1
      WHERE setting_key IN ('hr_enabled','shift_enabled','enable_booking','inventory_enabled','wifi_enabled');
    `,
  },
  {
    id: '030_orders_shift_id',
    sql: `
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS shift_id INT DEFAULT NULL,
        ADD INDEX IF NOT EXISTS idx_orders_shift (shift_id);

      ALTER TABLE shifts
        ADD COLUMN IF NOT EXISTS total_orders  INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_revenue DECIMAL(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cash_revenue  DECIMAL(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS handover_cash DECIMAL(12,2) DEFAULT NULL COMMENT 'Kas yang diserahkan ke shift berikutnya';
    `,
  },
  {
    id: '029_role_permissions_seed',
    sql: `
      UPDATE roles SET permissions = '{"orders":{"create":true,"read":true,"update_status":true,"cancel":false,"delete":false},"products":{"create":false,"read":true,"update":false,"delete":false},"bookings":{"create":true,"read":true,"update_status":true,"delete":false},"customers":{"read":true}}'
      WHERE name = 'kasir' AND (permissions IS NULL OR JSON_LENGTH(permissions) = 0);

      UPDATE roles SET permissions = '{"orders":{"create":true,"read":true,"update_status":true,"cancel":false,"delete":false},"products":{"create":false,"read":true,"update":false,"delete":false},"bookings":{"create":true,"read":true,"update_status":true,"delete":false},"customers":{"read":false}}'
      WHERE name = 'waiter' AND (permissions IS NULL OR JSON_LENGTH(permissions) = 0);

      UPDATE roles SET permissions = '{"orders":{"create":true,"read":true,"update_status":true,"cancel":true,"delete":true},"products":{"create":true,"read":true,"update":true,"delete":true},"bookings":{"create":true,"read":true,"update_status":true,"delete":true},"customers":{"read":true}}'
      WHERE name = 'admin' AND (permissions IS NULL OR JSON_LENGTH(permissions) = 0);
    `,
  },
  {
    id: '027_purchase_order_branch',
    sql: `
      ALTER TABLE purchase_orders
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL,
        ADD INDEX IF NOT EXISTS idx_po_branch (branch_id);
    `,
  },
  {
    id: '027_branch_stock',
    sql: `
      CREATE TABLE IF NOT EXISTS product_branch_stock (
        id            INT PRIMARY KEY AUTO_INCREMENT,
        product_id    INT NOT NULL,
        branch_id     INT NOT NULL,
        stock         INT NOT NULL DEFAULT 0,
        min_stock     INT NOT NULL DEFAULT 0,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_prod_branch (product_id, branch_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (branch_id)  REFERENCES branches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;

      CREATE TABLE IF NOT EXISTS ingredient_branch_stock (
        id            INT PRIMARY KEY AUTO_INCREMENT,
        ingredient_id INT NOT NULL,
        branch_id     INT NOT NULL,
        stock_qty     DECIMAL(12,3) NOT NULL DEFAULT 0,
        min_stock     DECIMAL(12,3) NOT NULL DEFAULT 0,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ing_branch (ingredient_id, branch_id),
        FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE,
        FOREIGN KEY (branch_id)     REFERENCES branches(id)  ON DELETE CASCADE
      ) ENGINE=InnoDB;

      ALTER TABLE stock_cards
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL,
        ADD INDEX IF NOT EXISTS idx_sc_branch (branch_id);

      ALTER TABLE ingredient_stock_log
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL,
        ADD INDEX IF NOT EXISTS idx_isl_branch (branch_id);

      INSERT IGNORE INTO product_branch_stock (product_id, branch_id, stock, min_stock)
        SELECT p.id, b.id, p.stock, p.min_stock
        FROM products p
        CROSS JOIN branches b
        WHERE b.is_active = 1
          AND p.status = 'active';

      INSERT IGNORE INTO ingredient_branch_stock (ingredient_id, branch_id, stock_qty, min_stock)
        SELECT i.id, b.id, i.stock_qty, i.min_stock
        FROM ingredients i
        CROSS JOIN branches b
        WHERE b.is_active = 1
          AND i.is_active = 1;
    `,
  },

  // ── Schema fixes applied 2026-07 ─────────────────────────────

  {
    id: '032_tables_rename_number_to_table_number',
    optional: true,
    sql: `
      ALTER TABLE \`tables\`
        CHANGE COLUMN IF EXISTS \`number\` \`table_number\` VARCHAR(20) NOT NULL;
      ALTER TABLE \`tables\`
        ADD COLUMN IF NOT EXISTS \`name\` VARCHAR(100) DEFAULT NULL AFTER table_number;
    `,
  },

  {
    id: '033_users_add_updated_at_avatar',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS avatar VARCHAR(500) DEFAULT NULL AFTER phone,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP AFTER created_at;
    `,
  },

  {
    id: '034_categories_add_status_parent_order',
    sql: `
      ALTER TABLE categories
        ADD COLUMN IF NOT EXISTS status ENUM('active','inactive') DEFAULT 'active' AFTER is_active,
        ADD COLUMN IF NOT EXISTS parent_id INT DEFAULT NULL AFTER status,
        ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 0 AFTER parent_id,
        ADD COLUMN IF NOT EXISTS image_url VARCHAR(500) DEFAULT NULL AFTER display_order,
        ADD COLUMN IF NOT EXISTS slug VARCHAR(255) DEFAULT NULL AFTER image_url,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP AFTER created_at;
    `,
  },

  {
    id: '035_expenses_add_branch_id',
    sql: `
      ALTER TABLE expenses
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL AFTER category_id;
    `,
  },

  {
    id: '036_order_items_rename_price_to_unit_price',
    optional: true,
    sql: `
      ALTER TABLE order_items
        CHANGE COLUMN IF EXISTS \`price\` \`unit_price\` DECIMAL(10,2) NOT NULL,
        ADD COLUMN IF NOT EXISTS product_name VARCHAR(200) DEFAULT NULL AFTER product_id,
        ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10,2) DEFAULT 0 AFTER unit_price,
        ADD COLUMN IF NOT EXISTS addons_total DECIMAL(10,2) DEFAULT 0.00 AFTER subtotal,
        ADD COLUMN IF NOT EXISTS variants_selected LONGTEXT DEFAULT NULL AFTER addons_total,
        ADD COLUMN IF NOT EXISTS addons_selected LONGTEXT DEFAULT NULL AFTER variants_selected,
        ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL AFTER addons_selected,
        ADD COLUMN IF NOT EXISTS station_id INT DEFAULT NULL AFTER notes,
        ADD COLUMN IF NOT EXISTS station_status ENUM('pending','preparing','ready') DEFAULT 'pending' AFTER station_id;
    `,
  },

  {
    id: '037_media_normalize_columns',
    optional: true,
    sql: `
      ALTER TABLE media
        ADD COLUMN IF NOT EXISTS file_name VARCHAR(255) DEFAULT NULL AFTER id,
        ADD COLUMN IF NOT EXISTS file_path VARCHAR(500) DEFAULT NULL AFTER file_name,
        ADD COLUMN IF NOT EXISTS file_type VARCHAR(50) DEFAULT NULL AFTER file_path,
        ADD COLUMN IF NOT EXISTS file_size INT DEFAULT NULL AFTER file_type,
        ADD COLUMN IF NOT EXISTS storage_type VARCHAR(20) DEFAULT 'local' AFTER file_size,
        ADD COLUMN IF NOT EXISTS alt_text VARCHAR(255) DEFAULT NULL AFTER storage_type;
      UPDATE media SET
        file_name = COALESCE(file_name, filename, original_name),
        file_path = COALESCE(file_path, url),
        file_size = COALESCE(file_size, size),
        file_type = COALESCE(file_type, SUBSTRING_INDEX(mime_type,'/',1)),
        storage_type = COALESCE(storage_type, 'local')
      WHERE file_name IS NULL OR file_path IS NULL;
    `,
  },

  {
    id: '038_system_settings_pos_seed',
    sql: `
      INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, is_public, sort_order) VALUES
        ('pos_require_shift',          'false', 'boolean', 'pos',    'Wajib Buka Shift Sebelum Transaksi',  0, 1),
        ('pos_allow_no_table',         'true',  'boolean', 'pos',    'Izinkan Order Tanpa Meja',            0, 2),
        ('pos_auto_print_receipt',     'false', 'boolean', 'pos',    'Auto Print Struk Setelah Bayar',      0, 3),
        ('pos_require_payment_method', 'true',  'boolean', 'pos',    'Wajib Pilih Metode Pembayaran',       0, 4),
        ('topup_enabled',              'false', 'boolean', 'member', 'Aktifkan Fitur Top Up Saldo',         0, 1),
        ('topup_min_amount',           '10000', 'number',  'member', 'Minimum Nominal Top Up (Rp)',         0, 2),
        ('member_registration',        'true',  'boolean', 'member', 'Izinkan Registrasi Member Baru',      0, 3),
        ('currency_symbol',            'Rp',    'text',    'general','Simbol Mata Uang',                    0, 3);
    `,
  },

  {
    id: '039_suppliers_rename_contact',
    optional: true,
    sql: `
      ALTER TABLE suppliers
        CHANGE COLUMN IF EXISTS \`contact\` \`contact_person\` VARCHAR(255) DEFAULT NULL;
    `,
  },

  {
    id: '049_order_items_add_product_price',
    sql: `
      ALTER TABLE order_items
        ADD COLUMN IF NOT EXISTS product_price DECIMAL(10,2) DEFAULT NULL AFTER product_name;
      UPDATE order_items SET product_price = COALESCE(product_price, unit_price) WHERE product_price IS NULL;
    `,
  },

  {
    id: '044_product_custom_fields_table',
    sql: `
      CREATE TABLE IF NOT EXISTS product_custom_fields (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        field_id INT NOT NULL,
        field_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `,
  },

  {
    id: '043_products_add_image_column',
    sql: `
      ALTER TABLE products
        ADD COLUMN IF NOT EXISTS image VARCHAR(500) DEFAULT NULL AFTER image_url;
      UPDATE products SET image = image_url WHERE image IS NULL AND image_url IS NOT NULL;
    `,
  },

  {
    id: '042_system_settings_add_display_order',
    sql: `
      ALTER TABLE system_settings
        ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 0 AFTER sort_order;
    `,
  },

  {
    id: '041_orders_add_missing_columns',
    sql: `
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS served_by INT DEFAULT NULL AFTER shift_id,
        ADD COLUMN IF NOT EXISTS tax DECIMAL(10,2) DEFAULT 0.00 AFTER subtotal,
        ADD COLUMN IF NOT EXISTS discount DECIMAL(10,2) DEFAULT 0.00 AFTER tax,
        ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'dine-in' AFTER order_status;
    `,
  },

  {
    id: '040_bookings_add_missing_columns',
    sql: `
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT NULL AFTER created_by,
        ADD COLUMN IF NOT EXISTS table_number VARCHAR(20) DEFAULT NULL AFTER table_id,
        ADD COLUMN IF NOT EXISTS special_request TEXT DEFAULT NULL AFTER notes,
        ADD COLUMN IF NOT EXISTS guests INT DEFAULT 1 AFTER pax,
        ADD COLUMN IF NOT EXISTS name VARCHAR(150) DEFAULT NULL AFTER id,
        ADD COLUMN IF NOT EXISTS email VARCHAR(150) DEFAULT NULL AFTER name,
        ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT NULL AFTER email;
      UPDATE bookings SET
        name  = COALESCE(name, customer_name),
        email = COALESCE(email, customer_email),
        phone = COALESCE(phone, customer_phone),
        guests = COALESCE(guests, pax)
      WHERE name IS NULL OR email IS NULL;
    `,
  },

  {
    id: '045_product_field_definitions_table',
    sql: `
      CREATE TABLE IF NOT EXISTS product_field_definitions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        field_key VARCHAR(100) NOT NULL UNIQUE,
        field_label VARCHAR(150) NOT NULL,
        field_type ENUM('text','number','boolean','select','image') DEFAULT 'text',
        is_required TINYINT(1) DEFAULT 0,
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `,
  },

  {
    id: '046_orders_expand_payment_status_enum',
    optional: true,
    sql: `
      ALTER TABLE orders
        MODIFY COLUMN payment_status ENUM('unpaid','paid','pending','partial','refund','cancelled') DEFAULT 'unpaid';
    `,
  },

  {
    id: '047_orders_expand_payment_method_enum',
    optional: true,
    sql: `
      ALTER TABLE orders
        MODIFY COLUMN payment_method VARCHAR(50) DEFAULT 'cash';
    `,
  },

  {
    id: '048_product_field_definitions_add_field_name',
    optional: true,
    sql: `
      ALTER TABLE product_field_definitions
        ADD COLUMN IF NOT EXISTS field_name VARCHAR(150) DEFAULT NULL AFTER field_key;
      UPDATE product_field_definitions SET field_name = COALESCE(field_name, field_label, field_key) WHERE field_name IS NULL;
    `,
  },
];

async function run() {
  // Create migrations tracking table
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id VARCHAR(50) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  const [applied] = await db.query('SELECT id FROM _migrations');
  const appliedIds = new Set(applied.map(r => r.id));

  let count = 0;
  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id)) {
      console.log(`  ⏭  ${m.id} — already applied`);
      continue;
    }

    process.stdout.write(`  ⟳  ${m.id} — running...`);
    try {
      let statements;
      if (m.raw && m.statements) {
        // Pre-split statements (for triggers/procedures with internal semicolons)
        statements = m.statements.map(s => s.trim()).filter(s => s.length > 0);
      } else {
        // Split by semicolon
        statements = (m.sql || '')
          .split(';')
          .map(s => s.trim())
          .filter(s => s.length > 0 && !s.startsWith('--'));
      }

      for (const stmt of statements) {
        await db.query(stmt);
      }

      await db.query('INSERT INTO _migrations (id) VALUES (?)', [m.id]);
      console.log(' ✅');
      count++;
    } catch (err) {
      if (m.optional) {
        console.log(` ⚠  optional — skipped (${err.message})`);
        await db.query('INSERT INTO _migrations (id) VALUES (?)', [m.id]);
      } else {
        console.log(` ❌ FAILED: ${err.message}`);
        console.error(err);
        process.exit(1);
      }
    }
  }

  console.log(`\n✅ Migration done — ${count} new, ${MIGRATIONS.length - count} skipped.\n`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });

// Run HR migration separately
async function runHrMigration() {
  console.log('Running HR migration...');
  const db = require('../config/database');
  const hrMigrations = [
    `CREATE TABLE IF NOT EXISTS employees (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      employee_code VARCHAR(50) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      nik VARCHAR(20) NULL,
      phone VARCHAR(20) NULL,
      address TEXT NULL,
      department VARCHAR(100) NULL,
      position VARCHAR(100) NULL,
      employment_type ENUM('full-time','part-time','contract','hourly') DEFAULT 'full-time',
      join_date DATE NULL,
      base_salary DECIMAL(15,2) DEFAULT 0,
      hourly_rate DECIMAL(10,2) DEFAULT 0,
      bank_name VARCHAR(100) NULL,
      bank_account VARCHAR(50) NULL,
      bank_account_name VARCHAR(150) NULL,
      status ENUM('active','inactive') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS work_shifts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      shift_name VARCHAR(100) NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      break_minutes INT DEFAULT 0,
      color VARCHAR(20) DEFAULT '#6366f1',
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      shift_id INT NULL,
      work_date DATE NOT NULL,
      clock_in TIME NULL,
      clock_out TIME NULL,
      total_hours DECIMAL(5,2) DEFAULT 0,
      overtime_hours DECIMAL(5,2) DEFAULT 0,
      status ENUM('present','absent','sick','leave','late','holiday') DEFAULT 'present',
      notes TEXT NULL,
      recorded_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_date (employee_id, work_date),
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      FOREIGN KEY (shift_id) REFERENCES work_shifts(id) ON DELETE SET NULL,
      FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS shift_swaps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      requester_employee_id INT NOT NULL,
      target_employee_id INT NOT NULL,
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      from_shift_id INT NULL,
      to_shift_id INT NULL,
      reason TEXT NULL,
      status ENUM('pending','approved','rejected') DEFAULT 'pending',
      approved_by INT NULL,
      approved_at TIMESTAMP NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (requester_employee_id) REFERENCES employees(id),
      FOREIGN KEY (target_employee_id) REFERENCES employees(id),
      FOREIGN KEY (from_shift_id) REFERENCES work_shifts(id) ON DELETE SET NULL,
      FOREIGN KEY (to_shift_id) REFERENCES work_shifts(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payroll (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      period_month VARCHAR(7) NOT NULL,
      base_salary DECIMAL(15,2) DEFAULT 0,
      total_hours DECIMAL(8,2) DEFAULT 0,
      overtime_hours DECIMAL(8,2) DEFAULT 0,
      overtime_pay DECIMAL(15,2) DEFAULT 0,
      gross_salary DECIMAL(15,2) DEFAULT 0,
      bonus DECIMAL(15,2) DEFAULT 0,
      deductions DECIMAL(15,2) DEFAULT 0,
      net_salary DECIMAL(15,2) DEFAULT 0,
      work_days INT DEFAULT 0,
      absent_days INT DEFAULT 0,
      sick_days INT DEFAULT 0,
      leave_days INT DEFAULT 0,
      status ENUM('draft','approved','paid') DEFAULT 'draft',
      notes TEXT NULL,
      paid_at TIMESTAMP NULL,
      paid_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_month (employee_id, period_month),
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      FOREIGN KEY (paid_by) REFERENCES users(id) ON DELETE SET NULL
    )`,
    `INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES
      ('hr_enabled', 'false'),
      ('hr_work_days_per_week', '6'),
      ('hr_work_hours_per_day', '8'),
      ('hr_overtime_multiplier', '1.5'),
      ('hr_payroll_day', '25')`
  ];
  for (const sql of hrMigrations) {
    try { await db.query(sql); console.log('  ✓', sql.slice(0, 50)); }
    catch (e) { console.error('  ✗', e.message); }
  }
  console.log('HR migration done.');
  process.exit(0);
}

if (require.main === module && process.argv[2] === 'hr') {
  runHrMigration();
}
