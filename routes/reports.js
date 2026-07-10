const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// Helper: get today's date string YYYY-MM-DD
const today = () => new Date().toISOString().slice(0, 10);

// Helper: parse and default date range + filters
const parseDateRange = (query) => {
  const date_from = query.date_from || today();
  const date_to = query.date_to || today();
  const branch_id = query.branch_id || null;
  const cashier_id = query.cashier_id || null;
  return { date_from, date_to, branch_id, cashier_id };
};

// Append branch + cashier conditions to a WHERE clause fragment
const applyFilters = (params, branch_id, cashier_id) => {
  let sql = '';
  if (branch_id) { sql += ' AND o.branch_id = ?'; params.push(branch_id); }
  if (cashier_id) { sql += ' AND o.served_by = ?'; params.push(cashier_id); }
  return sql;
};

// Revenue filter: exclude cancelled, include paid + partial
const REVENUE_FILTER = `o.order_status NOT IN ('cancelled') AND o.payment_status IN ('paid', 'partial')`;

// ─── GET /api/reports/summary ─────────────────────────────────────────────────
router.get('/summary',
  authenticate,
  authorize('admin', 'kasir'),
  async (req, res) => {
    try {
      const { date_from, date_to, branch_id, cashier_id } = parseDateRange(req.query);

      // Calculate previous period of same length
      const from = new Date(date_from);
      const to = new Date(date_to);
      const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
      const prevTo = new Date(from);
      prevTo.setDate(prevTo.getDate() - 1);
      const prevFrom = new Date(prevTo);
      prevFrom.setDate(prevFrom.getDate() - diffDays);
      const prev_date_from = prevFrom.toISOString().slice(0, 10);
      const prev_date_to = prevTo.toISOString().slice(0, 10);

      const f1 = []; const extra1 = applyFilters(f1, branch_id, cashier_id);
      const f2 = []; const extra2 = applyFilters(f2, branch_id, cashier_id);
      const f3 = []; const extra3 = applyFilters(f3, branch_id, cashier_id);
      const f4 = []; const extra4 = applyFilters(f4, branch_id, cashier_id);
      const f5 = []; const extra5 = applyFilters(f5, branch_id, cashier_id);
      const f6 = []; const extra6 = applyFilters(f6, branch_id, cashier_id);
      const f7 = []; const extra7 = applyFilters(f7, branch_id, cashier_id);
      const f8 = []; const extra8 = applyFilters(f8, branch_id, cashier_id);

      const [
        [revenueRows],
        [cashRows],
        [pendingRows],
        [dailyRows],
        [paymentRows],
        [topProductRows],
        [prevRows],
        [itemsRows],
      ] = await Promise.all([
        // Total revenue + total orders
        db.query(
          `SELECT
             COALESCE(SUM(o.total), 0) AS total_revenue,
             COUNT(*) AS total_orders
           FROM orders o
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}${extra1}`,
          [date_from, date_to, ...f1]
        ),

        // Cash revenue
        db.query(
          `SELECT COALESCE(SUM(o.total), 0) AS cash_revenue
           FROM orders o
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}
             AND o.payment_method = 'cash'${extra2}`,
          [date_from, date_to, ...f2]
        ),

        // Pending orders (no payment_status filter)
        db.query(
          `SELECT COUNT(*) AS pending_orders
           FROM orders o
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND o.order_status IN ('pending', 'preparing', 'ready')${extra3}`,
          [date_from, date_to, ...f3]
        ),

        // Daily data
        db.query(
          `SELECT
             DATE(o.created_at) AS date,
             COALESCE(SUM(o.total), 0) AS revenue,
             COUNT(*) AS orders
           FROM orders o
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}${extra4}
           GROUP BY DATE(o.created_at)
           ORDER BY DATE(o.created_at) ASC`,
          [date_from, date_to, ...f4]
        ),

        // Payment breakdown
        db.query(
          `SELECT
             o.payment_method,
             COUNT(*) AS count,
             COALESCE(SUM(o.total), 0) AS total
           FROM orders o
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}${extra5}
           GROUP BY o.payment_method
           ORDER BY total DESC`,
          [date_from, date_to, ...f5]
        ),

        // Top 5 products
        db.query(
          `SELECT
             oi.product_name,
             SUM(oi.quantity) AS qty_sold,
             COALESCE(SUM(oi.subtotal), 0) AS revenue
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}${extra6}
           GROUP BY oi.product_name
           ORDER BY qty_sold DESC
           LIMIT 5`,
          [date_from, date_to, ...f6]
        ),

        // Comparison: previous period
        db.query(
          `SELECT
             COALESCE(SUM(o.total), 0) AS prev_revenue,
             COUNT(*) AS prev_orders
           FROM orders o
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}${extra7}`,
          [prev_date_from, prev_date_to, ...f7]
        ),

        // Items sold
        db.query(
          `SELECT COALESCE(SUM(oi.quantity), 0) AS items_sold
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}${extra8}`,
          [date_from, date_to, ...f8]
        ),
      ]);

      const total_revenue = parseFloat(revenueRows[0].total_revenue);
      const total_orders = parseInt(revenueRows[0].total_orders, 10);
      const avg_order_value = total_orders > 0
        ? parseFloat((total_revenue / total_orders).toFixed(2))
        : 0;

      res.json({
        total_revenue,
        total_orders,
        avg_order_value,
        items_sold: parseInt(itemsRows[0].items_sold, 10),
        cash_revenue: parseFloat(cashRows[0].cash_revenue),
        pending_orders: parseInt(pendingRows[0].pending_orders, 10),
        daily_data: dailyRows.map(r => ({
          date: r.date instanceof Date
            ? r.date.toISOString().slice(0, 10)
            : r.date,
          revenue: parseFloat(r.revenue),
          orders: parseInt(r.orders, 10),
        })),
        payment_breakdown: paymentRows.map(r => ({
          payment_method: r.payment_method,
          count: parseInt(r.count, 10),
          total: parseFloat(r.total),
        })),
        top_products: topProductRows.map(r => ({
          product_name: r.product_name,
          qty_sold: parseInt(r.qty_sold, 10),
          revenue: parseFloat(r.revenue),
        })),
        comparison: {
          prev_revenue: parseFloat(prevRows[0].prev_revenue),
          prev_orders: parseInt(prevRows[0].prev_orders, 10),
        },
      });
    } catch (error) {
      console.error('Reports summary error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── GET /api/reports/products ────────────────────────────────────────────────
router.get('/products',
  authenticate,
  authorize('admin', 'kasir'),
  async (req, res) => {
    try {
      const { date_from, date_to, branch_id, cashier_id } = parseDateRange(req.query);
      const limit = parseInt(req.query.limit) || 20;
      const { category_id } = req.query;

      let sql = `
        SELECT
          p.id AS product_id,
          oi.product_name,
          c.name AS category_name,
          p.sku,
          SUM(oi.quantity) AS qty_sold,
          COALESCE(SUM(oi.subtotal), 0) AS revenue,
          COALESCE(AVG(oi.unit_price), 0) AS avg_price,
          COUNT(DISTINCT oi.order_id) AS order_count
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE DATE(o.created_at) BETWEEN ? AND ?
          AND ${REVENUE_FILTER}
      `;
      const params = [date_from, date_to];

      if (category_id) {
        sql += ' AND p.category_id = ?';
        params.push(category_id);
      }
      if (branch_id) { sql += ' AND o.branch_id = ?'; params.push(branch_id); }
      if (cashier_id) { sql += ' AND o.served_by = ?'; params.push(cashier_id); }

      sql += `
        GROUP BY p.id, oi.product_name, c.name, p.sku
        ORDER BY qty_sold DESC
        LIMIT ?
      `;
      params.push(limit);

      const [products] = await db.query(sql, params);

      res.json({
        products: products.map(r => ({
          product_id: r.product_id,
          product_name: r.product_name,
          category_name: r.category_name,
          sku: r.sku,
          qty_sold: parseInt(r.qty_sold, 10),
          revenue: parseFloat(r.revenue),
          avg_price: parseFloat(r.avg_price),
          order_count: parseInt(r.order_count, 10),
        })),
      });
    } catch (error) {
      console.error('Reports products error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── GET /api/reports/hourly ──────────────────────────────────────────────────
router.get('/hourly',
  authenticate,
  authorize('admin', 'kasir'),
  async (req, res) => {
    try {
      const { date_from, date_to, branch_id, cashier_id } = parseDateRange(req.query);
      const fp = []; const extra = applyFilters(fp, branch_id, cashier_id);

      const [rows] = await db.query(
        `SELECT
           HOUR(o.created_at) AS hour,
           COUNT(*) AS orders,
           COALESCE(SUM(o.total), 0) AS revenue,
           COALESCE(AVG(o.total), 0) AS avg_order
         FROM orders o
         WHERE DATE(o.created_at) BETWEEN ? AND ?
           AND ${REVENUE_FILTER}${extra}
         GROUP BY HOUR(o.created_at)
         ORDER BY hour ASC`,
        [date_from, date_to, ...fp]
      );

      // Fill in all 24 hours (0–23), defaulting missing hours to zero
      const hourMap = {};
      rows.forEach(r => { hourMap[r.hour] = r; });

      const hours = Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        orders: parseInt(hourMap[h]?.orders || 0, 10),
        revenue: parseFloat(hourMap[h]?.revenue || 0),
        avg_order: parseFloat(hourMap[h]?.avg_order || 0),
      }));

      res.json({ hours });
    } catch (error) {
      console.error('Reports hourly error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── GET /api/reports/tables ──────────────────────────────────────────────────
router.get('/tables',
  authenticate,
  authorize('admin', 'kasir'),
  async (req, res) => {
    try {
      const { date_from, date_to, branch_id, cashier_id } = parseDateRange(req.query);
      const fp = []; const extra = applyFilters(fp, branch_id, cashier_id);

      const [rows] = await db.query(
        `SELECT
           o.table_number,
           r.name AS room_name,
           COUNT(DISTINCT o.id) AS orders,
           COALESCE(SUM(o.total), 0) AS revenue,
           COALESCE(AVG(o.total), 0) AS avg_order,
           COALESCE(SUM(oi.quantity), 0) AS total_items
         FROM orders o
         LEFT JOIN tables t ON t.table_number = o.table_number
         LEFT JOIN rooms r ON r.id = t.room_id
         LEFT JOIN order_items oi ON oi.order_id = o.id
         WHERE DATE(o.created_at) BETWEEN ? AND ?
           AND ${REVENUE_FILTER}
           AND o.table_number IS NOT NULL${extra}
         GROUP BY o.table_number, r.name
         ORDER BY revenue DESC`,
        [date_from, date_to, ...fp]
      );

      res.json({
        tables: rows.map(r => ({
          table_number: r.table_number,
          room_name: r.room_name || null,
          orders: parseInt(r.orders, 10),
          revenue: parseFloat(r.revenue),
          avg_order: parseFloat(r.avg_order),
          total_items: parseInt(r.total_items, 10),
        })),
      });
    } catch (error) {
      console.error('Reports tables error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── GET /api/reports/staff ───────────────────────────────────────────────────
router.get('/staff',
  authenticate,
  authorize('admin', 'kasir'),
  async (req, res) => {
    try {
      const { date_from, date_to, branch_id } = parseDateRange(req.query);
      const fp = [];
      let extra = '';
      if (branch_id) { extra += ' AND o.branch_id = ?'; fp.push(branch_id); }

      const [rows] = await db.query(
        `SELECT
           u.id AS user_id,
           u.name,
           u.role,
           COUNT(DISTINCT o.id) AS orders_handled,
           COALESCE(SUM(o.total), 0) AS revenue_handled,
           COALESCE(AVG(o.total), 0) AS avg_order
         FROM orders o
         JOIN users u ON u.id = o.served_by
         WHERE DATE(o.created_at) BETWEEN ? AND ?
           AND ${REVENUE_FILTER}${extra}
         GROUP BY u.id, u.name, u.role
         ORDER BY revenue_handled DESC`,
        [date_from, date_to, ...fp]
      );

      res.json({
        staff: rows.map(r => ({
          user_id: r.user_id,
          name: r.name,
          role: r.role,
          orders_handled: parseInt(r.orders_handled, 10),
          revenue_handled: parseFloat(r.revenue_handled),
          avg_order: parseFloat(r.avg_order),
        })),
      });
    } catch (error) {
      console.error('Reports staff error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── GET /api/reports/shifts ──────────────────────────────────────────────────
router.get('/shifts',
  authenticate,
  authorize('admin', 'kasir'),
  async (req, res) => {
    try {
      const { date_from, date_to } = parseDateRange(req.query);

      const [rows] = await db.query(
        `SELECT
           s.*,
           u.name AS opened_by_name,
           uc.name AS closed_by_name,
           COUNT(DISTINCT o.id) AS total_orders,
           COALESCE(SUM(o.total), 0) AS total_revenue,
           COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN o.total ELSE 0 END), 0) AS cash_revenue
         FROM shifts s
         LEFT JOIN users u ON u.id = s.opened_by
         LEFT JOIN users uc ON uc.id = s.closed_by
         LEFT JOIN orders o ON o.shift_id = s.id
           AND ${REVENUE_FILTER}
         WHERE DATE(s.started_at) BETWEEN ? AND ?
         GROUP BY s.id
         ORDER BY s.started_at DESC`,
        [date_from, date_to]
      );

      res.json({
        shifts: rows.map(r => ({
          ...r,
          total_orders: parseInt(r.total_orders, 10),
          total_revenue: parseFloat(r.total_revenue),
          cash_revenue: parseFloat(r.cash_revenue),
        })),
      });
    } catch (error) {
      console.error('Reports shifts error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
