const db = require('../config/database');
(async () => {
  const sqls = [
    // Extend employees table
    `ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS photo VARCHAR(255) NULL AFTER status,
      ADD COLUMN IF NOT EXISTS ktp_number VARCHAR(20) NULL AFTER photo,
      ADD COLUMN IF NOT EXISTS ktp_photo VARCHAR(255) NULL AFTER ktp_number,
      ADD COLUMN IF NOT EXISTS birth_date DATE NULL AFTER ktp_photo,
      ADD COLUMN IF NOT EXISTS birth_place VARCHAR(100) NULL AFTER birth_date,
      ADD COLUMN IF NOT EXISTS gender ENUM('male','female') NULL AFTER birth_place,
      ADD COLUMN IF NOT EXISTS marital_status ENUM('single','married','divorced','widowed') NULL AFTER gender,
      ADD COLUMN IF NOT EXISTS blood_type ENUM('A','B','AB','O') NULL AFTER marital_status,
      ADD COLUMN IF NOT EXISTS religion VARCHAR(50) NULL AFTER blood_type,
      ADD COLUMN IF NOT EXISTS education VARCHAR(100) NULL AFTER religion,
      ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(150) NULL AFTER education,
      ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(20) NULL AFTER emergency_contact_name,
      ADD COLUMN IF NOT EXISTS emergency_contact_relation VARCHAR(50) NULL AFTER emergency_contact_phone`,
    // Extend attendance table
    `ALTER TABLE attendance
      ADD COLUMN IF NOT EXISTS method ENUM('manual','gps','face','fingerprint') DEFAULT 'manual' AFTER recorded_by,
      ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7) NULL AFTER method,
      ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL AFTER latitude,
      ADD COLUMN IF NOT EXISTS distance_meters INT NULL AFTER longitude,
      ADD COLUMN IF NOT EXISTS selfie_photo VARCHAR(255) NULL AFTER distance_meters,
      ADD COLUMN IF NOT EXISTS is_verified TINYINT(1) DEFAULT 0 AFTER selfie_photo`,
    // Employee schedules
    `CREATE TABLE IF NOT EXISTS employee_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      work_date DATE NOT NULL,
      shift_id INT NULL,
      notes VARCHAR(255) NULL,
      status ENUM('scheduled','confirmed','cancelled') DEFAULT 'scheduled',
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_schedule (employee_id, work_date),
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      FOREIGN KEY (shift_id) REFERENCES work_shifts(id) ON DELETE SET NULL
    )`,
    // KPI metric definitions
    `CREATE TABLE IF NOT EXISTS kpi_metrics (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      description TEXT NULL,
      unit VARCHAR(50) NULL,
      target_type ENUM('numeric','percentage','boolean') DEFAULT 'numeric',
      higher_is_better TINYINT(1) DEFAULT 1,
      is_active TINYINT(1) DEFAULT 1,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // Employee KPI per month
    `CREATE TABLE IF NOT EXISTS employee_kpi (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      metric_id INT NOT NULL,
      period_month VARCHAR(7) NOT NULL,
      target_value DECIMAL(10,2) DEFAULT 0,
      actual_value DECIMAL(10,2) DEFAULT 0,
      score DECIMAL(5,2) DEFAULT 0,
      notes TEXT NULL,
      recorded_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_metric_month (employee_id, metric_id, period_month),
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      FOREIGN KEY (metric_id) REFERENCES kpi_metrics(id) ON DELETE CASCADE
    )`,
    // Default KPI metrics
    `INSERT IGNORE INTO kpi_metrics (id, name, description, unit, target_type, higher_is_better) VALUES
      (1, 'Kehadiran', 'Persentase kehadiran dalam sebulan', '%', 'percentage', 1),
      (2, 'Ketepatan Waktu', 'Persentase masuk tepat waktu', '%', 'percentage', 1),
      (3, 'Kecepatan Layanan', 'Rata-rata waktu layanan per pelanggan (menit)', 'menit', 'numeric', 0),
      (4, 'Kepuasan Pelanggan', 'Skor rata-rata review pelanggan', 'skor', 'numeric', 1),
      (5, 'Target Penjualan', 'Pencapaian target penjualan', '%', 'percentage', 1)`,
    // Settings
    `INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES
      ('hr_advanced_enabled', 'false'),
      ('attendance_office_lat', '0'),
      ('attendance_office_lng', '0'),
      ('attendance_radius_meters', '100'),
      ('attendance_allowed_methods', 'manual,gps'),
      ('attendance_require_selfie', 'false'),
      ('attendance_face_api_url', '')`
  ];
  for (const sql of sqls) {
    try { await db.query(sql); console.log('✓', sql.slice(0,60)); }
    catch(e) { console.error('✗', e.message.slice(0,100)); }
  }
  process.exit(0);
})();
