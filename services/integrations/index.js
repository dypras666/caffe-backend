const db = require('../../config/database');
const IntegrationManager = require('./IntegrationManager');
const BaseIntegration = require('./BaseIntegration');
const MikroTikRadiusIntegration = require('./MikroTikRadiusIntegration');

const manager = IntegrationManager.getInstance();

async function ensureTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS external_integrations (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        provider VARCHAR(50) NOT NULL COMMENT 'mikrotik_radius, custom, etc',
        config JSON COMMENT 'Provider-specific configuration',
        status ENUM('active', 'inactive') DEFAULT 'inactive',
        trigger_events JSON COMMENT 'Events to listen to',
        run_order INT DEFAULT 0,
        last_run_at TIMESTAMP NULL,
        last_run_status ENUM('success', 'failed') NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_slug (slug),
        INDEX idx_provider (provider),
        INDEX idx_status (status)
      ) ENGINE=InnoDB
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS integration_logs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        integration_id INT,
        trigger_event VARCHAR(100),
        reference_type VARCHAR(50) COMMENT 'booking, order, user',
        reference_id INT,
        request_data JSON,
        response_data JSON,
        status ENUM('success', 'failed') NOT NULL,
        error_message TEXT,
        duration_ms INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (integration_id) REFERENCES external_integrations(id) ON DELETE SET NULL,
        INDEX idx_integration (integration_id),
        INDEX idx_reference (reference_type, reference_id),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS wifi_credentials (
        id INT PRIMARY KEY AUTO_INCREMENT,
        booking_id INT,
        order_id INT,
        integration_id INT,
        username VARCHAR(100) NOT NULL,
        password VARCHAR(100) NOT NULL,
        ssid VARCHAR(255),
        valid_from DATETIME NOT NULL,
        valid_until DATETIME NOT NULL,
        status ENUM('active', 'expired', 'revoked') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (integration_id) REFERENCES external_integrations(id) ON DELETE SET NULL,
        INDEX idx_booking (booking_id),
        INDEX idx_order (order_id),
        INDEX idx_username (username),
        INDEX idx_status (status)
      ) ENGINE=InnoDB
    `);

    await db.query(`
      INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, description, display_order)
      VALUES
        ('wifi_ssid', 'Cafe-Azzura-WiFi', 'text', 'integrations', 'WiFi SSID', 'Nama jaringan WiFi', 50),
        ('wifi_credential_duration_hours', '4', 'number', 'integrations', 'Masa Berlaku WiFi (Jam)', 'Durasi kredensial WiFi', 51),
        ('wifi_password_length', '8', 'number', 'integrations', 'Panjang Password WiFi', 'Jumlah karakter password', 52)
    `);

    await db.query(`
      INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, description, display_order)
      VALUES
        ('storage_driver', 'local', 'select', 'storage', 'Storage Driver', 'Penyimpanan file (local/s3)', 100),
        ('storage_s3_key', '', 'password', 'storage', 'S3 Access Key ID', 'AWS S3 Access Key ID', 101),
        ('storage_s3_secret', '', 'password', 'storage', 'S3 Secret Access Key', 'AWS S3 Secret Access Key', 102),
        ('storage_s3_bucket', 'uploads', 'text', 'storage', 'S3 Bucket', 'Nama bucket S3', 103),
        ('storage_s3_region', 'us-east-1', 'text', 'storage', 'S3 Region', 'Region AWS S3', 104),
        ('storage_s3_endpoint', '', 'text', 'storage', 'S3 Endpoint (Optional)', 'Custom endpoint untuk S3-compatible (MinIO, etc)', 105),
        ('storage_s3_url', '', 'text', 'storage', 'S3 Public URL (Optional)', 'Base URL untuk akses publik file S3', 106)
    `);

    await db.query(`
      INSERT IGNORE INTO external_integrations (name, slug, description, provider, config, status, trigger_events, run_order)
      VALUES ('MikroTik WiFi Hotspot', 'mikrotik-wifi', 'Generate kredensial WiFi via MikroTik Hotspot', 'mikrotik_radius',
              '{"connection_type":"rest","host":"","api_port":"80","ssh_port":"22","username":"","password":"","profile":"default","use_ssl":false}',
              'inactive', '["booking.confirmed","order.completed"]', 1)
    `);

    console.log('[Integrations] Tables ensured');
  } catch (error) {
    console.error('[Integrations] Table migration error:', error.message);
  }
}

async function initIntegrations() {
  await ensureTables();
  try {
    await manager.loadIntegrations();
    console.log(`[Integrations] Loaded ${manager.integrations.length} active integration(s)`);
  } catch (error) {
    console.error('[Integrations] Failed to load integrations:', error.message);
  }
}

async function triggerBookingEvent(event, booking) {
  return manager.triggerEvent(event, 'booking', booking.id, {
    name: booking.name,
    email: booking.email,
    phone: booking.phone,
    booking_date: booking.booking_date,
    booking_time: booking.booking_time,
    guests: booking.guests,
  });
}

async function triggerOrderEvent(event, order) {
  return manager.triggerEvent(event, 'order', order.id, {
    name: order.customer_name,
    email: order.customer_email,
    phone: order.customer_phone,
    total: order.total,
    order_number: order.order_number,
  });
}

module.exports = {
  IntegrationManager,
  BaseIntegration,
  MikroTikRadiusIntegration,
  manager,
  initIntegrations,
  triggerBookingEvent,
  triggerOrderEvent,
};
