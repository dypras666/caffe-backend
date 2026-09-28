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
      
      const fBooking = [];
      let extraBooking = '';
      if (branch_id) { extraBooking += ' AND branch_id = ?'; fBooking.push(branch_id); }

      const [
        [revenueRows],
        [cashRows],
        [pendingRows],
        [dailyRows],
        [paymentRows],
        [topProductRows],
        [prevRows],
        [itemsRows],
        [bookingRevRows],
      ] = await Promise.all([
        // Total revenue + total orders
        db.query(
          `SELECT
             COALESCE(SUM(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS total_revenue,
             COUNT(*) AS total_orders
           FROM orders o
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}${extra1}`,
          [date_from, date_to, ...f1]
        ),

        // Cash revenue
        db.query(
          `SELECT COALESCE(SUM(CASE 
             WHEN o.payment_status = 'paid' AND o.payment_method = 'cash' THEN COALESCE(o.paid_amount, o.total)
             WHEN o.payment_status = 'partial' AND (o.dp_payment_method = 'cash' OR (o.dp_payment_method IS NULL AND o.payment_method = 'cash')) THEN COALESCE(o.paid_amount, o.dp_amount, 0)
             ELSE 0
           END), 0) AS cash_revenue
           FROM orders o
           WHERE DATE(o.created_at) BETWEEN ? AND ?
             AND ${REVENUE_FILTER}${extra2}`,
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
             COALESCE(SUM(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS revenue,
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
             COALESCE(SUM(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS total
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
             COALESCE(SUM(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS prev_revenue,
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

        // Booking revenue
        db.query(
          `SELECT COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE dp_amount END), 0) AS booking_revenue
           FROM bookings
           WHERE DATE(created_at) BETWEEN ? AND ?
             AND payment_status IN ('paid', 'partial') AND status != 'cancelled' ${extraBooking}`,
          [date_from, date_to, ...fBooking]
        ),
      ]);

      let total_revenue = parseFloat(revenueRows[0].total_revenue);
      const booking_revenue = parseFloat(bookingRevRows[0].booking_revenue);
      total_revenue += booking_revenue;
      
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
           COALESCE(SUM(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS revenue,
           COALESCE(AVG(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS avg_order
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
           COALESCE(SUM(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS revenue,
           COALESCE(AVG(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS avg_order,
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
      const { date_from, date_to, branch_id, cashier_id } = parseDateRange(req.query);
      const fp = [];
      let extra = '';
      if (branch_id && branch_id !== 'all') { extra += ' AND o.branch_id = ?'; fp.push(branch_id); }
      if (cashier_id && cashier_id !== 'all') { extra += ' AND o.served_by = ?'; fp.push(cashier_id); }

      const [rows] = await db.query(
        `SELECT
           u.id AS user_id,
           u.name,
           u.role,
           COUNT(DISTINCT o.id) AS orders_handled,
           COALESCE(SUM(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS revenue_handled,
           COALESCE(AVG(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS avg_order
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
           COALESCE(SUM(COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END)), 0) AS calculated_revenue,
           COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN COALESCE(o.paid_amount, CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END) ELSE 0 END), 0) AS calculated_cash_revenue
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
          total_revenue: r.status === 'closed' && parseFloat(r.total_revenue || 0) > 0 ? parseFloat(r.total_revenue) : parseFloat(r.calculated_revenue),
          cash_revenue: r.status === 'closed' && parseFloat(r.cash_revenue || 0) > 0 ? parseFloat(r.cash_revenue) : parseFloat(r.calculated_cash_revenue),
        })),
      });
    } catch (error) {
      console.error('Reports shifts error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── GET /api/reports/services ────────────────────────────────────────────────
router.get('/services',
  authenticate,
  authorize('admin', 'kasir'),
  async (req, res) => {
    try {
      const { date_from, date_to, branch_id, cashier_id } = parseDateRange(req.query);
      const { service_type, service_status } = req.query;

      let whereClause = `
        o.order_status != 'deleted'
        AND (o.order_type IN ('booking', 'preorder', 'service') OR o.service_date IS NOT NULL)
        AND DATE(o.created_at) BETWEEN ? AND ?
      `;
      const baseParams = [date_from, date_to];

      if (branch_id && branch_id !== 'all') {
        whereClause += ' AND o.branch_id = ?';
        baseParams.push(branch_id);
      }
      if (cashier_id && cashier_id !== 'all') {
        whereClause += ' AND o.served_by = ?';
        baseParams.push(cashier_id);
      }
      if (service_type && service_type !== 'all') {
        whereClause += ' AND o.order_type = ?';
        baseParams.push(service_type);
      }
      if (service_status && service_status !== 'all') {
        whereClause += ' AND o.service_status = ?';
        baseParams.push(service_status);
      }

      // 1. Summary Metrics
      const [[summary]] = await db.query(
        `SELECT
           COUNT(*) AS total_orders,
           COALESCE(SUM(o.total), 0) AS total_value,
           COALESCE(SUM(o.paid_amount), 0) AS total_paid,
           COALESCE(SUM(COALESCE(o.remaining_amount, GREATEST(0, o.total - COALESCE(o.paid_amount, 0)))), 0) AS total_remaining,
           COALESCE(SUM(CASE WHEN o.order_type = 'booking' THEN 1 ELSE 0 END), 0) AS total_booking,
           COALESCE(SUM(CASE WHEN o.order_type = 'preorder' THEN 1 ELSE 0 END), 0) AS total_preorder,
           COALESCE(SUM(CASE WHEN o.order_type = 'service' OR (o.order_type NOT IN ('booking', 'preorder') AND o.service_date IS NOT NULL) THEN 1 ELSE 0 END), 0) AS total_service,
           COALESCE(SUM(CASE WHEN o.service_status = 'pending' OR o.service_status IS NULL THEN 1 ELSE 0 END), 0) AS status_pending,
           COALESCE(SUM(CASE WHEN o.service_status = 'confirmed' THEN 1 ELSE 0 END), 0) AS status_confirmed,
           COALESCE(SUM(CASE WHEN o.service_status = 'in_progress' THEN 1 ELSE 0 END), 0) AS status_in_progress,
           COALESCE(SUM(CASE WHEN o.service_status = 'completed' THEN 1 ELSE 0 END), 0) AS status_completed,
           COALESCE(SUM(CASE WHEN o.service_status = 'cancelled' THEN 1 ELSE 0 END), 0) AS status_cancelled
         FROM orders o
         WHERE ${whereClause}`,
        baseParams
      );

      // 2. Daily Trend for chart
      const [dailyTrend] = await db.query(
        `SELECT
           DATE_FORMAT(COALESCE(o.service_date, o.created_at), '%Y-%m-%d') AS date,
           DATE_FORMAT(COALESCE(o.service_date, o.created_at), '%d/%m') AS label,
           COUNT(*) AS total_orders,
           COALESCE(SUM(o.total), 0) AS total_value,
           COALESCE(SUM(o.paid_amount), 0) AS total_paid,
           COALESCE(SUM(CASE WHEN o.order_type = 'booking' THEN 1 ELSE 0 END), 0) AS booking_count,
           COALESCE(SUM(CASE WHEN o.order_type = 'preorder' THEN 1 ELSE 0 END), 0) AS preorder_count,
           COALESCE(SUM(CASE WHEN o.order_type = 'service' THEN 1 ELSE 0 END), 0) AS service_count
         FROM orders o
         WHERE ${whereClause}
         GROUP BY DATE_FORMAT(COALESCE(o.service_date, o.created_at), '%Y-%m-%d'), DATE_FORMAT(COALESCE(o.service_date, o.created_at), '%d/%m')
         ORDER BY date ASC`,
        baseParams
      );

      // 3. Status Breakdown for chart
      const [statusBreakdown] = await db.query(
        `SELECT
           COALESCE(o.service_status, 'pending') AS status,
           COUNT(*) AS count,
           COALESCE(SUM(o.total), 0) AS value
         FROM orders o
         WHERE ${whereClause}
         GROUP BY COALESCE(o.service_status, 'pending')`,
        baseParams
      );

      // 4. Type Breakdown for chart
      const [typeBreakdown] = await db.query(
        `SELECT
           CASE 
             WHEN o.order_type = 'booking' THEN 'Booking / Reservasi'
             WHEN o.order_type = 'preorder' THEN 'Pre-Order'
             ELSE 'Layanan Jasa'
           END AS type_label,
           o.order_type,
           COUNT(*) AS count,
           COALESCE(SUM(o.total), 0) AS value
         FROM orders o
         WHERE ${whereClause}
         GROUP BY o.order_type`,
        baseParams
      );

      // 5. Detailed Orders List
      const [orders] = await db.query(
        `SELECT
           o.id, o.order_number, o.customer_name, o.customer_phone, o.customer_email,
           o.order_type, o.service_date, o.service_time, o.service_person_count, o.service_status,
           o.total, o.paid_amount, o.dp_amount, o.remaining_amount,
           o.payment_method, o.payment_status, o.notes, o.created_at,
           b.name AS branch_name,
           u.name AS cashier_name
         FROM orders o
         LEFT JOIN branches b ON b.id = o.branch_id
         LEFT JOIN users u ON u.id = o.served_by
         WHERE ${whereClause}
         ORDER BY COALESCE(o.service_date, o.created_at) DESC, o.id DESC
         LIMIT 200`,
        baseParams
      );

      res.json({
        summary: {
          total_orders: parseInt(summary.total_orders || 0),
          total_value: parseFloat(summary.total_value || 0),
          total_paid: parseFloat(summary.total_paid || 0),
          total_remaining: parseFloat(summary.total_remaining || 0),
          total_booking: parseInt(summary.total_booking || 0),
          total_preorder: parseInt(summary.total_preorder || 0),
          total_service: parseInt(summary.total_service || 0),
          status_counts: {
            pending: parseInt(summary.status_pending || 0),
            confirmed: parseInt(summary.status_confirmed || 0),
            in_progress: parseInt(summary.status_in_progress || 0),
            completed: parseInt(summary.status_completed || 0),
            cancelled: parseInt(summary.status_cancelled || 0),
          }
        },
        daily_trend: dailyTrend.map(d => ({
          ...d,
          total_orders: parseInt(d.total_orders),
          total_value: parseFloat(d.total_value),
          total_paid: parseFloat(d.total_paid),
          booking_count: parseInt(d.booking_count),
          preorder_count: parseInt(d.preorder_count),
          service_count: parseInt(d.service_count),
        })),
        status_breakdown: statusBreakdown.map(s => ({
          status: s.status,
          count: parseInt(s.count),
          value: parseFloat(s.value),
        })),
        type_breakdown: typeBreakdown.map(t => ({
          type_label: t.type_label,
          order_type: t.order_type,
          count: parseInt(t.count),
          value: parseFloat(t.value),
        })),
        orders,
      });
    } catch (error) {
      console.error('Reports services error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;

