const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/payments/methods — public gets active only; admin gets all
router.get('/methods', async (req, res) => {
  try {
    // Check if request has a valid admin/kasir token (optional)
    let isStaff = false;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
        const [rows] = await db.query('SELECT role FROM users WHERE id = ? AND status = "active"', [decoded.userId]);
        if (rows.length && ['admin','kasir'].includes(rows[0].role)) isStaff = true;
      } catch {}
    }

    const sql = isStaff
      ? 'SELECT * FROM payment_methods ORDER BY sort_order'
      : 'SELECT id, name, code, type, description, icon FROM payment_methods WHERE is_active = 1 ORDER BY sort_order';

    const [methods] = await db.query(sql);
    res.json({ methods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/methods — create new payment method
router.post('/methods', authenticate, authorize('admin'), async (req, res) => {
  const { name, code, type, description, icon, sort_order } = req.body;
  if (!name || !code || !type) return res.status(400).json({ error: 'name, code, type wajib diisi' });
  const validTypes = ['cash', 'digital', 'transfer', 'wallet'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'type tidak valid' });
  try {
    const [r] = await db.query(
      'INSERT INTO payment_methods (name, code, type, description, icon, sort_order, is_active) VALUES (?,?,?,?,?,?,1)',
      [name, code.toLowerCase().replace(/\s+/g, '_'), type, description || null, icon || null, sort_order || 99]
    );
    const [[method]] = await db.query('SELECT * FROM payment_methods WHERE id = ?', [r.insertId]);
    res.status(201).json({ method });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Kode metode sudah ada' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/payments/methods/:id — update payment method
router.put('/methods/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, description, icon, is_active, sort_order } = req.body;
  try {
    const fields = [], vals = [];
    if (name !== undefined) { fields.push('name = ?'); vals.push(name); }
    if (description !== undefined) { fields.push('description = ?'); vals.push(description); }
    if (icon !== undefined) { fields.push('icon = ?'); vals.push(icon); }
    if (is_active !== undefined) { fields.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); vals.push(sort_order); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE payment_methods SET ${fields.join(', ')} WHERE id = ?`, vals);
    const [[method]] = await db.query('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
    res.json({ method });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/payments/methods/:id
router.delete('/methods/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
    res.json({ message: 'Metode pembayaran dihapus' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/balance — get own balance (member/any auth)
router.get('/balance', authenticate, async (req, res) => {
  try {
    const [[user]] = await db.query('SELECT balance, is_priority FROM users WHERE id = ?', [req.user.id]);
    const [txHistory] = await db.query(
      'SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ balance: parseFloat(user.balance || 0), is_priority: !!user.is_priority, transactions: txHistory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/balance/:userId — admin see any user's balance
router.get('/balance/:userId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[user]] = await db.query('SELECT id, name, email, balance, is_priority FROM users WHERE id = ?', [req.params.userId]);
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
    const [txHistory] = await db.query(
      'SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.userId]
    );
    res.json({ user, transactions: txHistory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/topup — admin topup user balance
router.post('/topup', authenticate, authorize('admin'), async (req, res) => {
  const { user_id, amount, note } = req.body;
  if (!user_id || !amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'user_id dan amount wajib diisi' });
  }
  try {
    const [[user]] = await db.query('SELECT id, name, balance FROM users WHERE id = ?', [user_id]);
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

    const balBefore = parseFloat(user.balance || 0);
    const topupAmt = parseFloat(amount);
    const balAfter = parseFloat((balBefore + topupAmt).toFixed(2));

    await db.query('UPDATE users SET balance = ? WHERE id = ?', [balAfter, user_id]);
    await db.query(
      `INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, note, created_by)
       VALUES (?, 'topup', ?, ?, ?, ?, ?)`,
      [user_id, topupAmt, balBefore, balAfter, note || `Top-up oleh admin`, req.user.id]
    );

    res.json({
      message: `Saldo berhasil ditambah`,
      user: { id: user.id, name: user.name, balance_before: balBefore, balance_after: balAfter }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/priority — admin set/unset user as priority
router.post('/priority', authenticate, authorize('admin'), async (req, res) => {
  const { user_id, is_priority } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id wajib' });
  try {
    await db.query('UPDATE users SET is_priority = ? WHERE id = ?', [is_priority ? 1 : 0, user_id]);
    res.json({ message: `User ${is_priority ? 'dijadikan' : 'dihapus dari'} priority member` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
