const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize, invalidatePermCache, loadPermissions } = require('../middleware/auth');

// GET /api/roles/my-permissions — returns current user's permission map
router.get('/my-permissions', authenticate, async (req, res) => {
  try {
    const perms = await loadPermissions();
    const mine = perms[req.user.role] || {};
    res.json({ role: req.user.role, permissions: mine });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/roles
router.get('/', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM roles ORDER BY id');
    res.json({ roles: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/roles/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [[role]] = await db.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return res.status(404).json({ error: 'Role tidak ditemukan' });
    res.json({ role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/roles — admin only, cannot duplicate system roles
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { name, label, description, permissions } = req.body;
  if (!name || !label) return res.status(400).json({ error: 'name dan label wajib' });
  try {
    const [r] = await db.query(
      'INSERT INTO roles (name, label, description, permissions) VALUES (?, ?, ?, ?)',
      [name.toLowerCase(), label, description || null, permissions ? JSON.stringify(permissions) : null]
    );
    const [[role]] = await db.query('SELECT * FROM roles WHERE id = ?', [r.insertId]);
    res.status(201).json({ role });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Nama role sudah ada' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/roles/:id — cannot modify system roles' name
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { label, description, permissions } = req.body;
  try {
    const [[role]] = await db.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return res.status(404).json({ error: 'Role tidak ditemukan' });

    const fields = [], vals = [];
    if (label !== undefined) { fields.push('label=?'); vals.push(label); }
    if (description !== undefined) { fields.push('description=?'); vals.push(description); }
    if (permissions !== undefined) { fields.push('permissions=?'); vals.push(JSON.stringify(permissions)); }
    if (!fields.length) return res.status(400).json({ error: 'Tidak ada perubahan' });

    vals.push(req.params.id);
    await db.query(`UPDATE roles SET ${fields.join(',')}, updated_at=NOW() WHERE id=?`, vals);
    invalidatePermCache();
    const [[updated]] = await db.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    res.json({ role: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/roles/:id — cannot delete system roles
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[role]] = await db.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return res.status(404).json({ error: 'Role tidak ditemukan' });
    if (role.is_system) return res.status(400).json({ error: 'Role sistem tidak bisa dihapus' });

    // Check if any user has this role
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM users WHERE role = ?', [role.name]);
    if (cnt > 0) return res.status(400).json({ error: `Role digunakan oleh ${cnt} pengguna, tidak bisa dihapus` });

    await db.query('DELETE FROM roles WHERE id = ?', [req.params.id]);
    res.json({ message: 'Role dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
