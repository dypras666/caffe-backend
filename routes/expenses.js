const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

// ─── Seq helper ──────────────────────────────────────────────
async function nextExpenseNumber() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE order_sequences SET last_number = last_number + 1 WHERE seq_key = "expense"');
    const [[row]] = await conn.query('SELECT last_number FROM order_sequences WHERE seq_key = "expense"');
    await conn.commit();
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `EXP-${d}-${String(row.last_number).padStart(5, '0')}`;
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
}

// GET /api/expenses/categories
router.get('/categories', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM expense_categories WHERE is_active=1 ORDER BY sort_order, name');
    res.json({ categories: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/categories', authenticate, authorize('admin'), async (req, res) => {
  const { name, code, type, parent_id, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama kategori wajib' });
  try {
    const [r] = await db.query(
      'INSERT INTO expense_categories (name, code, type, parent_id, sort_order) VALUES (?,?,?,?,?)',
      [name, code || null, type || 'operational', parent_id || null, sort_order || 0]
    );
    const [[cat]] = await db.query('SELECT * FROM expense_categories WHERE id=?', [r.insertId]);
    res.status(201).json({ category: cat });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Kode kategori sudah ada' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/categories/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, code, type, sort_order, is_active } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (code !== undefined) { fields.push('code=?'); vals.push(code || null); }
  if (type !== undefined) { fields.push('type=?'); vals.push(type); }
  if (sort_order !== undefined) { fields.push('sort_order=?'); vals.push(sort_order); }
  if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Tidak ada perubahan' });
  try {
    vals.push(req.params.id);
    await db.query(`UPDATE expense_categories SET ${fields.join(',')} WHERE id=?`, vals);
    const [[cat]] = await db.query('SELECT * FROM expense_categories WHERE id=?', [req.params.id]);
    if (!cat) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    res.json({ category: cat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/categories/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[cat]] = await db.query('SELECT id FROM expense_categories WHERE id=?', [req.params.id]);
    if (!cat) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM expenses WHERE category_id=?', [req.params.id]);
    if (cnt > 0) return res.status(400).json({ error: `Kategori digunakan oleh ${cnt} pengeluaran` });
    await db.query('DELETE FROM expense_categories WHERE id=?', [req.params.id]);
    res.json({ message: 'Kategori dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses — list with filters
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { page = 1, limit = 20, category_id, date_from, date_to, status, search } = req.query;
    const branch_id = req.query.branch_id || req.user.branch_id || null;
    let where = 'WHERE 1=1', params = [];
    if (branch_id)   { where += ' AND e.branch_id=?'; params.push(branch_id); }
    if (category_id) { where += ' AND e.category_id=?'; params.push(category_id); }
    if (date_from)   { where += ' AND e.expense_date >= ?'; params.push(date_from); }
    if (date_to)     { where += ' AND e.expense_date <= ?'; params.push(date_to); }
    if (status)      { where += ' AND e.status=?'; params.push(status); }
    if (search)      { where += ' AND (e.title LIKE ? OR e.reference LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM expenses e ${where}`, params);
    const [[{ total_amount }]] = await db.query(`SELECT COALESCE(SUM(amount), 0) AS total_amount FROM expenses e ${where} AND e.status != 'rejected'`, params);

    const [rows] = await db.query(
      `SELECT e.*, ec.name AS category_name, ec.type AS category_type, u.name AS created_by_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON ec.id = e.category_id
       LEFT JOIN users u ON u.id = e.created_by
       ${where}
       ORDER BY e.expense_date DESC, e.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ expenses: rows, total_amount, pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/summary — monthly P&L summary
router.get('/summary', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { year, month } = req.query;
    const branch_id = req.query.branch_id || req.user.branch_id || null;
    const y = year || new Date().getFullYear();
    const m = month || (new Date().getMonth() + 1);
    const dateFrom = `${y}-${String(m).padStart(2, '0')}-01`;
    const dateTo = new Date(y, m, 0).toISOString().slice(0, 10);

    const branchWhere = branch_id ? ' AND o.branch_id = ?' : '';
    const branchParams = branch_id ? [branch_id] : [];
    const expBranchWhere = branch_id ? ' AND e.branch_id = ?' : '';
    const expBranchParams = branch_id ? [branch_id] : [];

    const [[revenue]] = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM orders o
       WHERE DATE(o.created_at) BETWEEN ? AND ?
         AND o.payment_status = 'paid' AND o.order_status != 'cancelled'${branchWhere}`,
      [dateFrom, dateTo, ...branchParams]
    );
    const [[expenseTotal]] = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses e
       WHERE e.expense_date BETWEEN ? AND ? AND e.status = 'approved'${expBranchWhere}`,
      [dateFrom, dateTo, ...expBranchParams]
    );
    const [byCategory] = await db.query(
      `SELECT ec.name AS category, ec.type, COALESCE(SUM(e.amount), 0) AS total
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       WHERE e.expense_date BETWEEN ? AND ? AND e.status = 'approved'${expBranchWhere}
       GROUP BY ec.id ORDER BY total DESC`,
      [dateFrom, dateTo, ...expBranchParams]
    );
    const [[cogs]] = await db.query(
      `SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_cogs
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       WHERE DATE(o.created_at) BETWEEN ? AND ?
         AND o.order_status != 'cancelled'${branchWhere}`,
      [dateFrom, dateTo, ...branchParams]
    );

    const grossProfit = revenue.total - (cogs.total_cogs || 0);
    const netProfit = revenue.total - expenseTotal.total;

    res.json({
      period: { year: y, month: m, date_from: dateFrom, date_to: dateTo },
      branch_id,
      revenue: parseFloat(revenue.total),
      cogs: parseFloat(cogs.total_cogs || 0),
      gross_profit: grossProfit,
      total_expenses: parseFloat(expenseTotal.total),
      net_profit: netProfit,
      by_category: byCategory,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/:id
router.get('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[exp]] = await db.query(
      `SELECT e.*, ec.name AS category_name, ec.type AS category_type, u.name AS created_by_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON ec.id = e.category_id
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = ?`,
      [req.params.id]
    );
    if (!exp) return res.status(404).json({ error: 'Pengeluaran tidak ditemukan' });
    res.json({ expense: exp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/expenses
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { category_id, title, amount, expense_date, payment_method, reference, description } = req.body;
  const branch_id = req.body.branch_id || req.user.branch_id || null;
  if (!title || !amount || !expense_date) return res.status(400).json({ error: 'title, amount, expense_date wajib' });
  try {
    const expNumber = await nextExpenseNumber();
    const [r] = await db.query(
      `INSERT INTO expenses (expense_number, category_id, branch_id, title, amount, expense_date, payment_method, reference, description, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,'approved',?)`,
      [expNumber, category_id || null, branch_id, title, parseFloat(amount), expense_date, payment_method || 'cash', reference || null, description || null, req.user.id]
    );
    await audit({ userId: req.user.id, action: 'create_expense', tableName: 'expenses', recordId: r.insertId, newValues: { title, amount }, description: `Catat pengeluaran: ${title} ${amount}`, severity: 'info' });
    const [[exp]] = await db.query('SELECT * FROM expenses WHERE id=?', [r.insertId]);
    res.status(201).json({ expense: exp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/expenses/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { category_id, title, amount, expense_date, payment_method, reference, description, status } = req.body;
  const fields = [], vals = [];
  if (category_id !== undefined) { fields.push('category_id=?'); vals.push(category_id); }
  if (title !== undefined) { fields.push('title=?'); vals.push(title); }
  if (amount !== undefined) { fields.push('amount=?'); vals.push(parseFloat(amount)); }
  if (expense_date !== undefined) { fields.push('expense_date=?'); vals.push(expense_date); }
  if (payment_method !== undefined) { fields.push('payment_method=?'); vals.push(payment_method); }
  if (reference !== undefined) { fields.push('reference=?'); vals.push(reference); }
  if (description !== undefined) { fields.push('description=?'); vals.push(description); }
  if (status !== undefined) { fields.push('status=?'); vals.push(status); if (status === 'approved') { fields.push('approved_by=?'); vals.push(req.user.id); } }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    vals.push(req.params.id);
    await db.query(`UPDATE expenses SET ${fields.join(',')} WHERE id=?`, vals);
    const [[exp]] = await db.query('SELECT * FROM expenses WHERE id=?', [req.params.id]);
    res.json({ expense: exp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/expenses/:id
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM expenses WHERE id=?', [req.params.id]);
    res.json({ message: 'Pengeluaran dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
