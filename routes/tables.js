const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/tables - list all tables
// ?room_id=X  filter by room
// ?status=available  filter by status
// ?date=YYYY-MM-DD&time=HH:MM  check booking overlap (returns is_booked flag per table)
router.get('/', authenticate, async (req, res) => {
  try {
    const { room_id, status, date, time, branch_id } = req.query;
    let sql = `
      SELECT t.*, t.table_number, r.name AS room_name,
        (SELECT COUNT(*) FROM orders o
         WHERE o.table_id = t.id
           AND o.order_status NOT IN ('completed','cancelled')
           AND o.payment_status = 'pending') AS unpaid_order_count,
        (SELECT o.order_number FROM orders o
         WHERE o.table_id = t.id
           AND o.order_status NOT IN ('completed','cancelled')
           AND o.payment_status = 'pending'
         ORDER BY o.created_at ASC LIMIT 1) AS unpaid_order_number,
        (SELECT o.total FROM orders o
         WHERE o.table_id = t.id
           AND o.order_status NOT IN ('completed','cancelled')
           AND o.payment_status = 'pending'
         ORDER BY o.created_at ASC LIMIT 1) AS unpaid_total,
        (SELECT o.customer_name FROM orders o
         WHERE o.table_id = t.id
           AND o.order_status NOT IN ('completed','cancelled')
           AND o.payment_status = 'pending'
         ORDER BY o.created_at ASC LIMIT 1) AS unpaid_customer_name,
        (SELECT o.created_at FROM orders o
         WHERE o.table_id = t.id
           AND o.order_status NOT IN ('completed','cancelled')
           AND o.payment_status = 'pending'
         ORDER BY o.created_at ASC LIMIT 1) AS occupied_since
      FROM tables t
      LEFT JOIN rooms r ON r.id = t.room_id
      WHERE 1=1
    `;
    const params = [];
    if (room_id) { sql += ' AND t.room_id = ?'; params.push(room_id); }
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    if (branch_id) { sql += ' AND t.branch_id = ?'; params.push(branch_id); }
    sql += ' ORDER BY t.room_id, t.sort_order, t.table_number';

    const [tables] = await db.query(sql, params);

    // Auto-free logic — two conditions:
    // 1. auto_free_at has passed (timer expired)
    // 2. Table is 'occupied' but has NO active orders (order was completed/cancelled without freeing table)
    const now = new Date();
    const occupiedIds = tables.filter(t => t.status === 'occupied' && !t.manual_close).map(t => t.id);

    if (occupiedIds.length > 0) {
      // Find occupied tables that have no active orders
      const [activeOrderTables] = await db.query(
        `SELECT DISTINCT table_id FROM orders
         WHERE table_id IN (?)
           AND order_status NOT IN ('completed','cancelled')`,
        [occupiedIds]
      );
      const activeTableIds = new Set(activeOrderTables.map(r => r.table_id));

      for (const t of tables) {
        const shouldFree =
          // Timer expired
          (t.auto_free_at && !t.manual_close && new Date(t.auto_free_at) <= now) ||
          // Occupied but no active orders
          (t.status === 'occupied' && !t.manual_close && !activeTableIds.has(t.id));

        if (shouldFree && t.status !== 'available') {
          await db.query('UPDATE tables SET status="available", auto_free_at=NULL WHERE id=?', [t.id]);
          t.status = 'available';
          t.auto_free_at = null;
        }
      }
    } else {
      // Just check timer for non-occupied tables (reserved, maintenance)
      for (const t of tables) {
        if (t.auto_free_at && !t.manual_close && new Date(t.auto_free_at) <= now && t.status !== 'available') {
          await db.query('UPDATE tables SET status="available", auto_free_at=NULL WHERE id=?', [t.id]);
          t.status = 'available';
          t.auto_free_at = null;
        }
      }
    }

    // Booking overlap check: mark tables as is_booked if have confirmed booking at requested date/time
    if (date && time) {
      try {
        const checkTime = time.slice(0, 5);
        const [booked] = await db.query(
          `SELECT DISTINCT number FROM bookings
           WHERE booking_date = ?
             AND status IN ('pending','confirmed')
             AND TIME(booking_time) BETWEEN SUBTIME(?, '02:00:00') AND ADDTIME(?, '02:00:00')`,
          [date, checkTime, checkTime]
        );
        const bookedNums = new Set(booked.map(b => b.table_number));
        tables.forEach(t => { t.is_booked = bookedNums.has(t.table_number); });
      } catch (_) { /* bookings table may not exist */ }
    }

    res.json({ tables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Table-related settings keys
const TABLE_SETTINGS_KEYS = [
  'pos_require_table',
  'table_auto_free_enabled',
  'table_auto_free_hours',
  'table_booking_check_overlap',
  'table_order_max_items',
];

// GET /api/tables/settings
router.get('/settings', authenticate, async (req, res) => {
  try {
    const placeholders = TABLE_SETTINGS_KEYS.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${placeholders})`,
      TABLE_SETTINGS_KEYS
    );
    const settings = {};
    TABLE_SETTINGS_KEYS.forEach(k => { settings[k] = null; });
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tables/settings (admin)
router.put('/settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const updates = {};
    TABLE_SETTINGS_KEYS.forEach(k => {
      if (req.body[k] !== undefined) updates[k] = String(req.body[k]);
    });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Tidak ada setting yang dikirim' });
    for (const [key, value] of Object.entries(updates)) {
      await db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [key, value]
      );
    }
    const placeholders = TABLE_SETTINGS_KEYS.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${placeholders})`,
      TABLE_SETTINGS_KEYS
    );
    const settings = {};
    TABLE_SETTINGS_KEYS.forEach(k => { settings[k] = null; });
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    res.json({ message: 'Settings updated', settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tables/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [[table]] = await db.query(
      'SELECT t.*, r.name AS room_name FROM tables t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?',
      [req.params.id]
    );
    if (!table) return res.status(404).json({ error: 'Meja tidak ditemukan' });
    res.json({ table });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tables (admin)
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { room_id, table_number, name, capacity, status, is_active, sort_order } = req.body;
  if (!table_number) return res.status(400).json({ error: 'Nomor meja wajib diisi' });
  try {
    const [result] = await db.query(
      'INSERT INTO tables (room_id, table_number, name, capacity, status, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [room_id || null, table_number, name || null, capacity || 4, status || 'available', is_active !== false ? 1 : 0, sort_order || 0]
    );
    const [[table]] = await db.query(
      'SELECT t.*, r.name AS room_name FROM tables t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?',
      [result.insertId]
    );
    res.status(201).json({ table });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Nomor meja sudah ada' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tables/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { room_id, table_number, name, capacity, status, is_active, sort_order } = req.body;
  try {
    const [[existing]] = await db.query('SELECT id FROM tables WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Meja tidak ditemukan' });

    const fields = [];
    const vals = [];
    if (room_id !== undefined) { fields.push('room_id = ?'); vals.push(room_id); }
    if (table_number) { fields.push('table_number = ?'); vals.push(table_number); }
    if (name !== undefined) { fields.push('name = ?'); vals.push(name); }
    if (capacity !== undefined) { fields.push('capacity = ?'); vals.push(capacity); }
    if (status) { fields.push('status = ?'); vals.push(status); }
    if (is_active !== undefined) { fields.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); vals.push(sort_order); }

    if (!fields.length) return res.status(400).json({ error: 'Tidak ada field yang diupdate' });

    vals.push(req.params.id);
    await db.query(`UPDATE tables SET ${fields.join(', ')} WHERE id = ?`, vals);

    const [[table]] = await db.query(
      'SELECT t.*, r.name AS room_name FROM tables t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?',
      [req.params.id]
    );
    res.json({ table, message: 'Meja updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Nomor meja sudah ada' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/tables/:id/status — quick status change
// body: { status, manual_close?, maintenance_note?, auto_free_hours? }
router.patch('/:id/status', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  const { status, manual_close, maintenance_note, auto_free_hours } = req.body;
  const valid = ['available', 'occupied', 'reserved', 'maintenance'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Status tidak valid' });
  try {
    let autoFreeAt = null;

    if (status === 'available') {
      // Clearing status — also clear manual_close and auto_free_at
      await db.query(
        'UPDATE tables SET status=?, manual_close=0, auto_free_at=NULL, maintenance_note=NULL WHERE id=?',
        [status, req.params.id]
      );
    } else {
      // Calculate auto_free_at if provided (and not manual_close)
      if (auto_free_hours && !manual_close) {
        autoFreeAt = new Date(Date.now() + parseFloat(auto_free_hours) * 60 * 60 * 1000)
          .toISOString().slice(0, 19).replace('T', ' ');
      }
      await db.query(
        `UPDATE tables SET status=?, manual_close=?, maintenance_note=?, auto_free_at=? WHERE id=?`,
        [status, manual_close ? 1 : 0, maintenance_note || null, autoFreeAt, req.params.id]
      );
    }
    res.json({ message: 'Status updated', status, auto_free_at: autoFreeAt, manual_close: !!manual_close });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tables/:id (admin only)
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[existing]] = await db.query('SELECT id FROM tables WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Meja tidak ditemukan' });
    await db.query('DELETE FROM tables WHERE id = ?', [req.params.id]);
    res.json({ message: 'Meja deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
