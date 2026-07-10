const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/rooms - list all rooms with table count
router.get('/', authenticate, async (req, res) => {
  try {
    const [rooms] = await db.query(`
      SELECT r.*,
        COUNT(t.id) AS total_tables,
        SUM(CASE WHEN t.is_active = 1 THEN 1 ELSE 0 END) AS active_tables,
        SUM(CASE WHEN t.status = 'available' AND t.is_active = 1 THEN 1 ELSE 0 END) AS available_tables
      FROM rooms r
      LEFT JOIN tables t ON t.room_id = r.id
      GROUP BY r.id
      ORDER BY r.sort_order, r.name
    `);
    res.json({ rooms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rooms/:id - single room with its tables
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [[room]] = await db.query('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Room tidak ditemukan' });

    const [tables] = await db.query(
      'SELECT * FROM tables WHERE room_id = ? ORDER BY sort_order, table_number',
      [req.params.id]
    );
    res.json({ room: { ...room, tables } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms - create room (admin only)
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { name, description, capacity, image, sort_order, is_active } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama room wajib diisi' });
  try {
    const [result] = await db.query(
      'INSERT INTO rooms (name, description, capacity, image, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      [name, description || null, capacity || 0, image || null, sort_order || 0, is_active !== false ? 1 : 0]
    );
    const [[room]] = await db.query('SELECT * FROM rooms WHERE id = ?', [result.insertId]);
    res.status(201).json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/rooms/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, description, capacity, image, sort_order, is_active } = req.body;
  try {
    const [[existing]] = await db.query('SELECT id FROM rooms WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Room tidak ditemukan' });

    await db.query(
      `UPDATE rooms SET
        name = COALESCE(?, name),
        description = ?,
        capacity = COALESCE(?, capacity),
        image = ?,
        sort_order = COALESCE(?, sort_order),
        is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [name || null, description !== undefined ? description : null, capacity || null, image !== undefined ? image : null, sort_order !== undefined ? sort_order : null, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id]
    );
    const [[room]] = await db.query('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    res.json({ room, message: 'Room updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rooms/:id
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[existing]] = await db.query('SELECT id FROM rooms WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Room tidak ditemukan' });

    await db.query('DELETE FROM rooms WHERE id = ?', [req.params.id]);
    res.json({ message: 'Room deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
