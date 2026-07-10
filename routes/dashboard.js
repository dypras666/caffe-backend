const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/dashboard/stats
router.get('/stats',
  authenticate,
  authorize('admin', 'kasir'),
  async (req, res) => {
    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const branch_id = req.user.role !== 'admin' ? (req.query.branch_id || req.user.branch_id || null) : null;
      const branchWhere = branch_id ? ' AND branch_id = ?' : '';
      const branchParam = branch_id ? [branch_id] : [];

      const [
        [ordersToday],
        [revenueToday],
        [pendingBookings],
        [totalProducts],
        [ordersByStatus],
        [revenueLast7Days],
      ] = await Promise.all([
        // Total orders today (scoped to branch)
        db.query(
          `SELECT COUNT(*) AS total_orders
           FROM orders
           WHERE DATE(created_at) = ? AND order_status != 'cancelled'${branchWhere}`,
          [today, ...branchParam]
        ),

        // Total revenue today (paid orders only, scoped to branch)
        db.query(
          `SELECT COALESCE(SUM(total), 0) AS total_revenue
           FROM orders
           WHERE DATE(created_at) = ?
             AND payment_status = 'paid'
             AND order_status != 'cancelled'${branchWhere}`,
          [today, ...branchParam]
        ),

        // Total pending bookings (scoped to branch)
        db.query(
          `SELECT COUNT(*) AS total_bookings_pending
           FROM bookings
           WHERE status = 'pending'${branchWhere}`,
          [...branchParam]
        ),

        // Total active products (scoped to branch — via product_branch_stock if branch_id)
        branch_id
          ? db.query(
              `SELECT COUNT(*) AS total_products
               FROM product_branch_stock
               WHERE branch_id = ? AND stock > 0`,
              [branch_id]
            )
          : db.query(
              `SELECT COUNT(*) AS total_products
               FROM products
               WHERE status = 'active'`
            ),

        // Orders by status (today, scoped to branch)
        db.query(
          `SELECT order_status AS status, COUNT(*) AS count
           FROM orders
           WHERE DATE(created_at) = ?${branchWhere}
           GROUP BY order_status`,
          [today, ...branchParam]
        ),

        // Revenue last 7 days (scoped to branch)
        db.query(
          `SELECT DATE(created_at) AS date,
                  COALESCE(SUM(total), 0) AS revenue,
                  COUNT(*) AS orders
           FROM orders
           WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
             AND payment_status = 'paid'
             AND order_status != 'cancelled'${branchWhere}
           GROUP BY DATE(created_at)
           ORDER BY date ASC`,
          [...branchParam]
        ),
      ]);

      res.json({
        total_orders: ordersToday[0].total_orders,
        total_revenue: parseFloat(revenueToday[0].total_revenue),
        total_bookings_pending: pendingBookings[0]?.total_bookings_pending || 0,
        total_products: totalProducts[0].total_products,
        orders_by_status: ordersByStatus,
        revenue_last_7_days: revenueLast7Days,
        branch_id,
      });
    } catch (error) {
      console.error('Dashboard stats error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
