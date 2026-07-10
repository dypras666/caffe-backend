require('dotenv').config();
const db = require('../config/database');

async function init() {
  console.log('Initializing database...');
  
  // Tenants table with new fields
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id VARCHAR(8) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(50),
      status ENUM('active','inactive') DEFAULT 'inactive',
      provision_status ENUM('pending','provisioning','completed','failed') DEFAULT 'pending',
      admin_url VARCHAR(500),
      admin_username VARCHAR(255),
      admin_password VARCHAR(255),
      backend_port INT,
      admin_port INT,
      ui_port INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  
  // Users table
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(8) DEFAULT 'greister',
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role ENUM('owner','admin','manager','cashier','staff') DEFAULT 'cashier',
      status ENUM('active','inactive') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Categories
  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(8) DEFAULT 'greister',
      name VARCHAR(255) NOT NULL,
      description TEXT,
      icon VARCHAR(50),
      color VARCHAR(20),
      sort_order INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Products
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(8) DEFAULT 'greister',
      category_id INT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price DECIMAL(12,2) NOT NULL DEFAULT 0,
      cost DECIMAL(12,2) DEFAULT 0,
      image VARCHAR(500),
      is_available TINYINT(1) DEFAULT 1,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Tables
  await db.query(`
    CREATE TABLE IF NOT EXISTS tables (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(8) DEFAULT 'greister',
      name VARCHAR(100) NOT NULL,
      qr_code VARCHAR(255),
      status ENUM('available','occupied','reserved','maintenance') DEFAULT 'available',
      capacity INT DEFAULT 4,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Orders
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(8) DEFAULT 'greister',
      table_id INT,
      user_id INT,
      order_number VARCHAR(50),
      status ENUM('pending','confirmed','preparing','ready','served','paid','cancelled') DEFAULT 'pending',
      subtotal DECIMAL(12,2) DEFAULT 0,
      tax DECIMAL(12,2) DEFAULT 0,
      discount DECIMAL(12,2) DEFAULT 0,
      total DECIMAL(12,2) DEFAULT 0,
      payment_method VARCHAR(50),
      payment_status ENUM('unpaid','partial','paid') DEFAULT 'unpaid',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Order items
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      product_id INT,
      product_name VARCHAR(255),
      quantity INT DEFAULT 1,
      price DECIMAL(12,2),
      subtotal DECIMAL(12,2),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Settings
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(8) DEFAULT 'greister',
      key_name VARCHAR(100) NOT NULL,
      key_value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_key (tenant_id, key_name)
    )
  `);
  
  // Insert greister tenant with 8-char ID
  await db.query(`INSERT IGNORE INTO tenants (id, name, slug, email, status, provision_status) VALUES ('greister', 'Greister Cafe', 'greister', 'admin@greister.com', 'active', 'completed')`);
  
  console.log('✅ Database initialized!');
  process.exit(0);
}

init().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
