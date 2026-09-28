const db = require('../config/database');

(async () => {
  console.log('Running kiosk & overtime migration...');
  const statements = [
    // 1. Create overtime table
    `CREATE TABLE IF NOT EXISTS overtime (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      overtime_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      total_hours DECIMAL(5,2) DEFAULT 0,
      rate_per_hour DECIMAL(12,2) DEFAULT 0,
      total_pay DECIMAL(12,2) DEFAULT 0,
      reason TEXT NULL,
      status ENUM('pending','approved','rejected') DEFAULT 'pending',
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;`,

    // 2. Add columns to employees table
    `ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS pin_code VARCHAR(10) NULL,
      ADD COLUMN IF NOT EXISTS face_photo MEDIUMTEXT NULL,
      ADD COLUMN IF NOT EXISTS face_descriptor LONGTEXT NULL;`,

    // 3. Extend attendance table
    `ALTER TABLE attendance
      ADD COLUMN IF NOT EXISTS method ENUM('manual','gps','face','fingerprint','pin') DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7) NULL,
      ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL,
      ADD COLUMN IF NOT EXISTS distance_meters INT NULL,
      ADD COLUMN IF NOT EXISTS selfie_photo MEDIUMTEXT NULL,
      ADD COLUMN IF NOT EXISTS is_verified TINYINT(1) DEFAULT 0;`,

    // 4. Ensure types are flexible
    `ALTER TABLE attendance MODIFY COLUMN selfie_photo MEDIUMTEXT NULL;`,
    `ALTER TABLE attendance MODIFY COLUMN method ENUM('manual','gps','face','fingerprint','pin') DEFAULT 'manual';`,

    // 5. System settings for kiosk & attendance
    `INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, is_public) VALUES
      ('kiosk_enabled', 'true', 'text', 'general', 1),
      ('kiosk_mode', 'all', 'text', 'general', 1),
      ('kiosk_require_radius', 'false', 'text', 'general', 1),
      ('attendance_radius_meters', '100', 'text', 'general', 1),
      ('attendance_office_lat', '0', 'text', 'general', 1),
      ('attendance_office_lng', '0', 'text', 'general', 1),
      ('attendance_require_selfie', 'false', 'text', 'general', 1)
    ON DUPLICATE KEY UPDATE updated_at = NOW();`
  ];

  for (const sql of statements) {
    try {
      await db.query(sql);
      console.log('✓ Success:', sql.replace(/\s+/g, ' ').slice(0, 60));
    } catch (e) {
      console.error('✗ Error executing:', sql.replace(/\s+/g, ' ').slice(0, 60), e.message);
    }
  }

  console.log('Migration completed successfully.');
  process.exit(0);
})();
