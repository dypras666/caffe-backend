const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

// ─── Seq helper ──────────────────────────────────────────────
async function nextShiftNumber() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO order_sequences (seq_key, last_number) VALUES ("shift", 1) ON DUPLICATE KEY UPDATE last_number = last_number + 1'
    );
    const [[row]] = await conn.query('SELECT last_number FROM order_sequences WHERE seq_key = "shift"');
    await conn.commit();
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `SHIFT-${d}-${String(row.last_number).padStart(5, '0')}`;
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
}

// ─── GET /api/shifts — list shifts (admin/kasir) ─────────────
// Query params: status, date_from, date_to, page, limit
router.get('/', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  try {
    const { status, date_from, date_to, page = 1, limit = 20 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    // Kasir hanya lihat shift sendiri
    if (req.user.role === 'kasir') {
      where += ' AND s.opened_by = ?';
      params.push(req.user.id);
    }

    if (status)    { where += ' AND s.status = ?';                  params.push(status); }
    if (date_from) { where += ' AND DATE(s.opened_at) >= ?';        params.push(date_from); }
    if (date_to)   { where += ' AND DATE(s.opened_at) <= ?';        params.push(date_to); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM shifts s ${where}`,
      params
    );

    const [rows] = await db.query(
      `SELECT s.*, u.name AS opened_by_name,
              uc.name AS closed_by_name
       FROM shifts s
       LEFT JOIN users u  ON u.id  = s.opened_by
       LEFT JOIN users uc ON uc.id = s.closed_by
       ${where}
       ORDER BY s.opened_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      shifts: rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/shifts/current — get open shift with live stats ─
router.get('/current', authenticate, async (req, res) => {
  try {
    let query, params;
    if (req.user.role === 'admin') {
      query = `SELECT s.*, u.name AS opened_by_name FROM shifts s
               LEFT JOIN users u ON u.id = s.opened_by
               WHERE s.status = 'open' ORDER BY s.opened_at DESC LIMIT 1`;
      params = [];
    } else {
      query = `SELECT s.*, u.name AS opened_by_name FROM shifts s
               LEFT JOIN users u ON u.id = s.opened_by
               WHERE s.status = 'open' AND s.opened_by = ?
               ORDER BY s.opened_at DESC LIMIT 1`;
      params = [req.user.id];
    }

    const [[shift]] = await db.query(query, params);
    if (!shift) return res.json({ shift: null });

    // Live stats from actual orders
    const [[live]] = await db.query(
      `SELECT
         COUNT(*)                                                                AS total_orders,
         COALESCE(SUM(total), 0)                                                 AS total_revenue,
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END), 0) AS cash_revenue,
         COALESCE(SUM(CASE WHEN payment_status='pending' THEN total ELSE 0 END), 0) AS pending_revenue
       FROM orders
       WHERE shift_id = ? AND order_status NOT IN ('cancelled')`,
      [shift.id]
    );

    const cashRevenue   = parseFloat(live.cash_revenue);
    const expectedCash  = parseFloat(shift.opening_cash) + cashRevenue;

    res.json({
      shift: {
        ...shift,
        live_total_orders:  parseInt(live.total_orders),
        live_total_revenue: parseFloat(live.total_revenue),
        live_cash_revenue:  cashRevenue,
        live_expected_cash: expectedCash,
        live_pending:       parseFloat(live.pending_revenue),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/shifts/open — open a new shift ────────────────
// body: { opening_cash, station_id?, notes }
router.post('/open', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  const { opening_cash, station_id, notes } = req.body;
  if (opening_cash === undefined || opening_cash === null) {
    return res.status(400).json({ error: 'opening_cash wajib' });
  }

  try {
    // Prevent duplicate open shift for the same user
    const [[existing]] = await db.query(
      'SELECT id FROM shifts WHERE status = "open" AND opened_by = ?',
      [req.user.id]
    );
    if (existing) {
      return res.status(409).json({ error: 'Sudah ada shift yang sedang berjalan', shift_id: existing.id });
    }

    const shiftNumber = await nextShiftNumber();
    const [r] = await db.query(
      `INSERT INTO shifts (shift_number, user_id, opened_by, opening_cash, station_id, notes, status, opened_at, shift_date, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, 'open', NOW(), CURDATE(), CURTIME(), CURTIME())`,
      [shiftNumber, req.user.id, req.user.id, parseFloat(opening_cash), station_id || null, notes || null]
    );

    await audit({
      userId: req.user.id,
      action: 'open_shift',
      tableName: 'shifts',
      recordId: r.insertId,
      newValues: { shift_number: shiftNumber, opening_cash },
      description: `Buka shift ${shiftNumber} dengan modal ${opening_cash}`,
      severity: 'info',
    });

    // Auto clock-in to HR module if enabled
    try {
      const [[hrSetting]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'hr_enabled'");
      if (hrSetting && hrSetting.setting_value === 'true') {
        const [[emp]] = await db.query("SELECT id FROM employees WHERE user_id = ?", [req.user.id]);
        if (emp) {
          const [[existingAtt]] = await db.query(
            "SELECT id FROM attendance WHERE employee_id = ? AND work_date = CURDATE()",
            [emp.id]
          );
          if (!existingAtt) {
            await db.query(
              `INSERT INTO attendance (employee_id, work_date, clock_in, status, notes)
               VALUES (?, CURDATE(), CURTIME(), 'present', 'Auto clock-in dari Open Shift')`,
              [emp.id]
            );
          }
        }
      }
    } catch (err) {
      console.error("Auto clock-in error:", err);
    }

    const [[shift]] = await db.query('SELECT * FROM shifts WHERE id = ?', [r.insertId]);
    res.status(201).json({ shift });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/shifts/:id/close — close a shift ───────────────
// body: { closing_cash, notes, handover_cash? }
router.put('/:id/close', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  const { closing_cash, notes, handover_cash } = req.body;
  if (closing_cash === undefined || closing_cash === null) {
    return res.status(400).json({ error: 'closing_cash wajib' });
  }
  try {
    const [[shift]] = await db.query('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
    if (!shift) return res.status(404).json({ error: 'Shift tidak ditemukan' });
    if (shift.status !== 'open') return res.status(400).json({ error: 'Shift sudah ditutup' });
    if (req.user.role !== 'admin' && shift.opened_by !== req.user.id) {
      return res.status(403).json({ error: 'Anda tidak berhak menutup shift ini' });
    }

    // Recalculate from actual orders linked to shift
    const [[actuals]] = await db.query(
      `SELECT
         COUNT(*)                                                                AS total_orders,
         COALESCE(SUM(total), 0)                                                 AS total_revenue,
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END), 0) AS cash_revenue
       FROM orders
       WHERE shift_id = ? AND order_status NOT IN ('cancelled')
         AND payment_status IN ('paid','partial')`,
      [shift.id]
    );

    const cashRevenue    = parseFloat(actuals.cash_revenue);
    const expectedCash   = parseFloat(shift.opening_cash) + cashRevenue;
    const cashDifference = parseFloat(closing_cash) - expectedCash;

    await db.query(
      `UPDATE shifts SET
         status = 'closed', closed_by = ?, closing_cash = ?,
         expected_cash = ?, cash_difference = ?,
         total_orders = ?, total_revenue = ?, cash_revenue = ?,
         handover_cash = ?, closed_at = NOW(),
         notes = CASE WHEN ? IS NOT NULL THEN ? ELSE notes END
       WHERE id = ?`,
      [
        req.user.id, parseFloat(closing_cash),
        expectedCash, cashDifference,
        parseInt(actuals.total_orders), parseFloat(actuals.total_revenue), cashRevenue,
        handover_cash !== undefined ? parseFloat(handover_cash) : null,
        notes || null, notes || null,
        shift.id,
      ]
    );

    await audit({
      userId: req.user.id, action: 'close_shift', tableName: 'shifts', recordId: shift.id,
      newValues: { closing_cash, expected_cash: expectedCash, cash_difference: cashDifference },
      description: `Tutup shift ${shift.shift_number}, selisih kas: ${cashDifference}`,
      severity: Math.abs(cashDifference) > 50000 ? 'warning' : 'info',
    });

    const [[updatedShift]] = await db.query(
      `SELECT s.*, u.name AS opened_by_name, uc.name AS closed_by_name
       FROM shifts s
       LEFT JOIN users u  ON u.id = s.opened_by
       LEFT JOIN users uc ON uc.id = s.closed_by
       WHERE s.id = ?`, [shift.id]
    );

    const [paymentBreakdown] = await db.query(
      `SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(total),0) AS total
       FROM orders WHERE shift_id = ? AND order_status NOT IN ('cancelled')
         AND payment_status IN ('paid','partial')
       GROUP BY payment_method ORDER BY total DESC`,
      [shift.id]
    );

    const [topItems] = await db.query(
      `SELECT oi.product_name, SUM(oi.quantity) AS qty, COALESCE(SUM(oi.subtotal),0) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.shift_id = ? AND o.order_status NOT IN ('cancelled')
       GROUP BY oi.product_name ORDER BY qty DESC LIMIT 5`,
      [shift.id]
    );

    res.json({
      shift: updatedShift,
      summary: {
        total_orders:      parseInt(actuals.total_orders),
        total_revenue:     parseFloat(actuals.total_revenue),
        cash_revenue:      cashRevenue,
        non_cash_revenue:  parseFloat(actuals.total_revenue) - cashRevenue,
        opening_cash:      parseFloat(shift.opening_cash),
        closing_cash:      parseFloat(closing_cash),
        expected_cash:     expectedCash,
        cash_difference:   cashDifference,
        handover_cash:     handover_cash !== undefined ? parseFloat(handover_cash) : null,
        payment_breakdown: paymentBreakdown.map(p => ({ payment_method: p.payment_method, count: parseInt(p.count), total: parseFloat(p.total) })),
        top_items:         topItems.map(i => ({ product_name: i.product_name, qty: parseInt(i.qty), revenue: parseFloat(i.revenue) })),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/shifts/:id/report — detailed shift report ──────
router.get('/:id/report', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  try {
    const [[shift]] = await db.query(
      `SELECT s.*, u.name AS opened_by_name, uc.name AS closed_by_name
       FROM shifts s
       LEFT JOIN users u  ON u.id  = s.opened_by
       LEFT JOIN users uc ON uc.id = s.closed_by
       WHERE s.id = ?`,
      [req.params.id]
    );
    if (!shift) return res.status(404).json({ error: 'Shift tidak ditemukan' });

    const revenueFilter = `order_status NOT IN ('cancelled') AND payment_status IN ('paid', 'partial')`;

    // Order summary
    const [[orderSummary]] = await db.query(
      `SELECT
         COUNT(*) AS total_orders,
         COALESCE(SUM(total), 0) AS total_revenue,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0) AS cash_revenue,
         COALESCE(SUM(CASE WHEN payment_method != 'cash' THEN total ELSE 0 END), 0) AS non_cash_revenue
       FROM orders
       WHERE shift_id = ? AND ${revenueFilter}`,
      [shift.id]
    );

    // Payment breakdown
    const [paymentBreakdown] = await db.query(
      `SELECT payment_method,
              COUNT(*) AS count,
              COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE shift_id = ? AND ${revenueFilter}
       GROUP BY payment_method
       ORDER BY total DESC`,
      [shift.id]
    );

    // Top items sold (top 5)
    const [topItems] = await db.query(
      `SELECT oi.product_name,
              SUM(oi.quantity) AS qty,
              COALESCE(SUM(oi.subtotal), 0) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.shift_id = ? AND o.order_status NOT IN ('cancelled')
       GROUP BY oi.product_name
       ORDER BY qty DESC
       LIMIT 5`,
      [shift.id]
    );

    // Orders list
    const [orders] = await db.query(
      `SELECT o.id, o.order_number, o.total, o.payment_method, o.created_at, o.customer_name
       FROM orders o
       WHERE o.shift_id = ? AND o.order_status NOT IN ('cancelled')
       ORDER BY o.created_at ASC`,
      [shift.id]
    );

    const opening_cash = parseFloat(shift.opening_cash) || 0;
    const cash_revenue = parseFloat(orderSummary.cash_revenue);
    const expected_closing_cash = parseFloat((opening_cash + cash_revenue).toFixed(2));
    const closing_cash = parseFloat(shift.closing_cash) || 0;
    const cash_difference = parseFloat(shift.cash_difference) || (closing_cash - expected_closing_cash);

    res.json({
      shift,
      summary: {
        total_orders:          parseInt(orderSummary.total_orders, 10),
        total_revenue:         parseFloat(orderSummary.total_revenue),
        cash_revenue,
        non_cash_revenue:      parseFloat(orderSummary.non_cash_revenue),
        opening_cash,
        closing_cash,
        expected_closing_cash,
        cash_difference,
        handover_cash:         shift.handover_cash ? parseFloat(shift.handover_cash) : null,
        payment_breakdown: paymentBreakdown.map(r => ({
          payment_method: r.payment_method,
          count: parseInt(r.count, 10),
          total: parseFloat(r.total),
        })),
        top_items: topItems.map(r => ({
          product_name: r.product_name,
          qty: parseInt(r.qty, 10),
          revenue: parseFloat(r.revenue),
        })),
      },
      orders: orders.map(o => ({
        id: o.id,
        order_number: o.order_number,
        total: parseFloat(o.total),
        payment_method: o.payment_method,
        created_at: o.created_at,
        customer_name: o.customer_name || null,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─── GET /api/shifts/:id/pre-close-summary ─────────────────
router.get('/:id/pre-close-summary', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  try {
    const [[shift]] = await db.query('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
    if (!shift) return res.status(404).json({ error: 'Shift tidak ditemukan' });

    // 1. Revenue
    const [[actuals]] = await db.query(
      `SELECT
         COUNT(*)                                                                AS total_orders,
         COALESCE(SUM(total), 0)                                                 AS total_revenue,
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END), 0) AS cash_revenue
       FROM orders
       WHERE shift_id = ? AND order_status NOT IN ('cancelled', 'deleted')
         AND payment_status IN ('paid','partial')`,
      [shift.id]
    );

    const cashRevenue = parseFloat(actuals.cash_revenue);
    const expectedCash = parseFloat(shift.opening_cash) + cashRevenue;

    // 2. Unpaid Orders
    const [unpaid_orders] = await db.query(
      `SELECT id, order_number, total, customer_name, table_number
       FROM orders
       WHERE shift_id = ? AND order_status NOT IN ('cancelled', 'deleted') AND payment_status = 'pending'`,
      [shift.id]
    );

    // 3. In-Progress Orders
    const [in_progress_orders] = await db.query(
      `SELECT id, order_number, order_status, customer_name, table_number
       FROM orders
       WHERE shift_id = ? AND order_status IN ('pending', 'preparing', 'ready')`,
      [shift.id]
    );

    // 4. Active Tables
    const [active_tables] = await db.query(
      `SELECT DISTINCT table_number, id, order_number
       FROM orders
       WHERE shift_id = ? AND table_id IS NOT NULL AND order_status NOT IN ('completed', 'cancelled', 'deleted')`,
      [shift.id]
    );

    res.json({
      summary: {
        opening_cash: parseFloat(shift.opening_cash),
        total_revenue: parseFloat(actuals.total_revenue),
        cash_revenue: cashRevenue,
        expected_cash: expectedCash,
        unpaid_orders,
        in_progress_orders,
        active_tables
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── GET /api/shifts/:id — single shift ──────────────────────
router.get('/:id', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  try {
    const [[shift]] = await db.query(
      `SELECT s.*, u.name AS opened_by_name, uc.name AS closed_by_name
       FROM shifts s
       LEFT JOIN users u  ON u.id  = s.opened_by
       LEFT JOIN users uc ON uc.id = s.closed_by
       WHERE s.id = ?`,
      [req.params.id]
    );
    if (!shift) return res.status(404).json({ error: 'Shift tidak ditemukan' });
    res.json({ shift });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
