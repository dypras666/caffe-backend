const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

function isSetupComplete() {
  return db.query(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'setup_completed'"
  ).then(([rows]) => rows.length > 0 && rows[0].setting_value === 'true');
}

// GET /api/setup/status
router.get('/status', async (req, res) => {
  try {
    const completed = await isSetupComplete();
    const [[admin]] = await db.query(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'"
    );
    const [[branchCount]] = await db.query('SELECT COUNT(*) AS count FROM branches');
    res.json({
      setup_completed: completed,
      has_admin: admin.count > 0,
      branch_count: branchCount.count,
    });
  } catch (error) {
    console.error('Setup status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/setup/initialize
router.post('/initialize', async (req, res) => {
  try {
    const completed = await isSetupComplete();
    if (completed) {
      return res.status(400).json({ error: 'Setup sudah pernah dilakukan' });
    }

    const { cafe_name, tagline, admin, branches, kasirs, features } = req.body;

    if (!cafe_name) return res.status(400).json({ error: 'Nama cafe wajib diisi' });
    if (!admin || !admin.email || !admin.password) {
      return res.status(400).json({ error: 'Akun admin wajib diisi' });
    }

    // 1. Save cafe settings
    const settings = [
      ['site_name', cafe_name, 'text', 'general'],
      ['site_tagline', tagline || '', 'text', 'general'],
      ['setup_completed', 'true', 'boolean', 'system'],
    ];
    if (features) {
      if (features.enable_booking !== undefined) settings.push(['enable_booking', String(features.enable_booking), 'boolean', 'features']);
      if (features.enable_takeaway !== undefined) settings.push(['enable_takeaway', String(features.enable_takeaway), 'boolean', 'features']);
      if (features.enable_delivery !== undefined) settings.push(['enable_delivery', String(features.enable_delivery), 'boolean', 'features']);
      if (features.multi_branch !== undefined) settings.push(['multi_branch_enabled', String(features.multi_branch), 'boolean', 'general']);
      if (features.hr_enabled !== undefined) settings.push(['hr_enabled', String(features.hr_enabled), 'text', 'general']);
      if (features.points_enabled !== undefined) settings.push(['points_enabled', String(features.points_enabled), 'text', 'general']);
      if (features.shift_enabled !== undefined) settings.push(['shift_enabled', String(features.shift_enabled), 'boolean', 'pos']);
      if (features.topup_enabled !== undefined) settings.push(['topup_enabled', String(features.topup_enabled), 'boolean', 'member']);
      if (features.member_registration !== undefined) settings.push(['member_registration', String(features.member_registration), 'boolean', 'general']);
    }

    for (const [key, value, type, group] of settings) {
      const [existing] = await db.query('SELECT id FROM system_settings WHERE setting_key = ?', [key]);
      if (existing.length > 0) {
        await db.query('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
      } else {
        await db.query(
          'INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group) VALUES (?, ?, ?, ?)',
          [key, value, type, group]
        );
      }
    }

    // 2. Create branches
    const branchIds = [];
    if (branches && branches.length > 0) {
      for (const b of branches) {
        const [result] = await db.query(
          'INSERT INTO branches (name, code, address, phone, city) VALUES (?, ?, ?, ?, ?)',
          [b.name, b.code || b.name.substring(0, 3).toUpperCase(), b.address || null, b.phone || null, b.city || null]
        );
        branchIds.push(result.insertId);
      }
    } else {
      // Default branch
      const [result] = await db.query(
        'INSERT INTO branches (name, code) VALUES (?, ?)',
        [`${cafe_name} - Pusat`, 'MAIN']
      );
      branchIds.push(result.insertId);
    }

    // 3. Create admin account
    const adminBranchId = branchIds[0] || null;
    const hashedAdmin = await bcrypt.hash(admin.password, 10);
    const [adminResult] = await db.query(
      'INSERT INTO users (name, email, password, role, branch_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      [admin.name || 'Admin', admin.email, hashedAdmin, 'admin', adminBranchId, 'active']
    );

    // 4. Create kasir accounts
    const kasirCreated = [];
    if (kasirs && kasirs.length > 0) {
      for (const k of kasirs) {
        const branchId = k.branch_id || branchIds[0] || null;
        const hashed = await bcrypt.hash(k.password, 10);
        const [result] = await db.query(
          'INSERT INTO users (name, email, password, role, branch_id, status) VALUES (?, ?, ?, ?, ?, ?)',
          [k.name, k.email, hashed, 'kasir', branchId, 'active']
        );
        kasirCreated.push({ id: result.insertId, name: k.name, email: k.email, branch_id: branchId });
      }
    }

    res.status(201).json({
      message: 'Setup berhasil',
      admin: { id: adminResult.insertId, name: admin.name, email: admin.email },
      branches: branchIds,
      kasirs: kasirCreated,
    });
  } catch (error) {
    console.error('Setup init error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email sudah terdaftar' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/setup/reset - only for dev, reset setup flag
router.post('/reset', async (req, res) => {
  try {
    await db.query("DELETE FROM system_settings WHERE setting_key = 'setup_completed'");
    res.json({ message: 'Setup flag reset. Refresh untuk memulai ulang.' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
