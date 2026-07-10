const db = require('../config/database');

async function setup() {
  console.log('Setting up tenants table...');
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
      db_name VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_slug (slug),
      INDEX idx_status (status)
    )
  `);
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role ENUM('owner', 'admin', 'manager', 'cashier', 'staff') DEFAULT 'staff',
      status ENUM('active', 'inactive') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_email (email)
    )
  `);
  
  // Insert greister tenant
  await db.query(`
    INSERT IGNORE INTO tenants (id, name, slug, email, status) 
    VALUES (1, 'Greister Cafe', 'greister', 'admin@greister.com', 'active')
  `);
  
  console.log('Setup complete!');
  process.exit(0);
}

setup().catch(err => {
  console.error(err);
  process.exit(1);
});
