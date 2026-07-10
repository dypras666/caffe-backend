const express = require('express');
const router = express.Router();
const db = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { execSync } = require('child_process');

module.exports = router;

// Check subdomain availability
router.get('/api/register/check/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.json({ available: false, error: 'Slug tidak valid' });
    }
    
    // Reserved slugs
    const reserved = ['www', 'api', 'admin', 'mail', 'ftp', 'localhost', 'caffe', 'landing', 'status'];
    if (reserved.includes(slug)) {
      return res.json({ available: false, error: 'Slug ini dipesan sistem' });
    }
    
    // Check database
    const [rows] = await db.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
    
    res.json({ 
      available: rows.length === 0,
      slug: slug 
    });
  } catch (error) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Register new tenant
router.post('/api/register', async (req, res) => {
  const conn = await db.getPool().getConnection();
  
  try {
    const { name, slug, email, password, phone } = req.body;
    
    // Validation
    if (!name || !slug || !email || !password) {
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    }
    
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Slug hanya huruf kecil, angka, dan strip' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password minimal 8 karakter' });
    }
    
    // Generate random tenant ID (8 chars, alphanumeric)
    const tenantId = crypto.randomBytes(4).toString('hex');
    
    await conn.beginTransaction();
    
    // Check availability
    const [existing] = await conn.query(
      'SELECT id FROM tenants WHERE slug = ?',
      [slug]
    );
    
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Slug sudah digunakan' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insert tenant
    await conn.query(
      `INSERT INTO tenants (id, name, slug, email, phone, status, provision_status, created_at) 
       VALUES (?, ?, ?, ?, ?, 'inactive', 'pending', NOW())`,
      [tenantId, name, slug, email, phone || null]
    );
    
    // Insert admin user
    await conn.query(
      `INSERT INTO users (tenant_id, name, email, password, role, status) 
       VALUES (?, 'Admin', ?, ?, 'owner', 'active')`,
      [tenantId, email, hashedPassword]
    );
    
    await conn.commit();
    
    // Trigger provisioning asynchronously
    provisionTenant(tenantId, slug).catch(err => {
      console.error('Provisioning failed for', tenantId, err);
    });
    
    res.json({
      success: true,
      tenant: {
        id: tenantId,
        name,
        slug,
        subdomain: `${slug}.caffe.my.id`
      },
      message: 'Tenant sedang diproses. Ini butuh beberapa menit.'
    });
    
  } catch (error) {
    await conn.rollback();
    console.error('Register error:', error);
    res.status(500).json({ error: 'Terjadi kesalahan server' });
  } finally {
    conn.release();
  }
});

// Get tenant status
router.get('/api/tenant/:id/status', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, slug, status, provision_status, admin_url, admin_username, admin_password FROM tenants WHERE id = ?',
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Restart tenant containers
router.post('/api/tenant/:id/restart', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [rows] = await db.query('SELECT slug FROM tenants WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant tidak ditemukan' });
    }
    
    const slug = rows[0].slug;
    
    // Restart containers
    execSync(`docker restart ${slug}-backend ${slug}-admin ${slug}-ui`, { stdio: 'ignore' });
    
    res.json({ success: true, message: 'Container direstart' });
  } catch (error) {
    console.error('Restart error:', error);
    res.status(500).json({ error: 'Gagal restart container' });
  }
});

// Provisioning function
async function provisionTenant(tenantId, slug) {
  const conn = await db.getConnection();
  
  try {
    console.log(`Provisioning tenant ${tenantId} (${slug})...`);
    
    // Update status to provisioning
    await conn.query('UPDATE tenants SET provision_status = ? WHERE id = ?', ['provisioning', tenantId]);
    
    // Find available port base
    const [tenants] = await conn.query('SELECT slug FROM tenants WHERE id != ?', [tenantId]);
    let portBase = 3100;
    for (const t of tenants) {
      // Check if port is in use (simplified check)
      portBase += 10;
    }
    
    const backendPort = portBase;
    const adminPort = portBase + 1;
    const uiPort = portBase + 2;
    
    // Create tenant directory
    execSync(`mkdir -p /opt/cafe-azzura/tenants/${slug}`, { stdio: 'ignore' });
    
    // Copy files
    execSync(`cp -r /opt/cafe-azzura/tenants/greister/* /opt/cafe-azzura/tenants/${slug}/`, { stdio: 'ignore' });
    
    // Update .env
    const envContent = `
NODE_ENV=production
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=CafeAzzura2024
DB_NAME=cafe_azzura
TENANT_ID=${tenantId}
JWT_SECRET=${crypto.randomBytes(32).toString('hex')}
SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}
`;
    execSync(`echo '${envContent}' > /opt/cafe-azzura/tenants/${slug}/cafe-backend/.env`, { stdio: 'ignore' });
    
    // Build images (run in background)
    try {
      execSync(`cd /opt/cafe-azzura/tenants/${slug}/cafe-backend && docker build -t ${slug}-backend:latest .`, { 
        stdio: 'ignore', 
        timeout: 300000 
      });
      execSync(`cd /opt/cafe-azzura/tenants/${slug}/cafe-admin && docker build -t ${slug}-admin:latest .`, { 
        stdio: 'ignore', 
        timeout: 300000 
      });
      execSync(`cd /opt/cafe-azzura/tenants/${slug}/cafe-ui && docker build -t ${slug}-ui:latest .`, { 
        stdio: 'ignore', 
        timeout: 300000 
      });
      
      // Start containers
      execSync(`docker run -d --name ${slug}-backend --restart unless-stopped --network host -v /opt/cafe-azzura/tenants/${slug}/cafe-backend/.env:/app/.env ${slug}-backend:latest`, { stdio: 'ignore' });
      execSync(`docker run -d --name ${slug}-admin --restart unless-stopped -p ${adminPort}:80 ${slug}-admin:latest`, { stdio: 'ignore' });
      execSync(`docker run -d --name ${slug}-ui --restart unless-stopped -p ${uiPort}:80 ${slug}-ui:latest`, { stdio: 'ignore' });
      
      // Generate admin credentials
      const adminPassword = crypto.randomBytes(8).toString('base64').slice(0, 12);
      const hashedPassword = bcrypt.hashSync(adminPassword, 10);
      await conn.query('UPDATE users SET password = ? WHERE tenant_id = ? AND role = ?', [hashedPassword, tenantId, 'owner']);
      
      // Update tenant status
      await conn.query(
        `UPDATE tenants SET status = 'active', provision_status = 'completed', 
         admin_url = ?, admin_username = ?, admin_password = ?,
         backend_port = ?, admin_port = ?, ui_port = ? 
         WHERE id = ?`,
        [`https://${slug}.caffe.my.id/admin`, email, adminPassword, backendPort, adminPort, uiPort, tenantId]
      );
      
      console.log(`Tenant ${slug} provisioned successfully!`);
      
    } catch (buildError) {
      console.error('Build failed:', buildError.message);
      await conn.query('UPDATE tenants SET provision_status = ? WHERE id = ?', ['failed', tenantId]);
    }
    
  } catch (error) {
    console.error('Provisioning error:', error);
    await conn.query('UPDATE tenants SET provision_status = ? WHERE id = ?', ['failed', tenantId]);
  } finally {
    conn.release();
  }
}

// Tenant count
router.get('/api/stats', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT COUNT(*) as count FROM tenants WHERE status = 'active'");
    res.json({ activeTenants: rows[0].count });
  } catch (error) {
    res.json({ activeTenants: 0 });
  }
});
