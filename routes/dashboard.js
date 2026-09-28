const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { optionalAuth } = require('../middleware/auth');

// Cache schema column checks
let _columnsChecked = false;
let _hasPaidAmount = false;
let _hasServiceStatus = false;
let _hasTotalAmount = false;
let _hasIsActiveUsers = false;
let _productImageCol = 'NULL AS image_url';
let _productImageGroupBy = 'oi.product_id';

async function checkColumns() {
  if (_columnsChecked) return;
  try {
    const [cols] = await db.query("SHOW COLUMNS FROM orders");
    const colNames = cols.map(c => c.Field);
    _hasPaidAmount = colNames.includes('paid_amount');
    _hasServiceStatus = colNames.includes('service_status');
    _hasTotalAmount = colNames.includes('total_amount');

    const [uCols] = await db.query("SHOW COLUMNS FROM users");
    const uColNames = uCols.map(c => c.Field);
    _hasIsActiveUsers = uColNames.includes('is_active');

    const [pCols] = await db.query("SHOW COLUMNS FROM products");
    const pColNames = pCols.map(c => c.Field);
    if (pColNames.includes('image_url')) {
      _productImageCol = 'p.image_url';
      _productImageGroupBy = 'p.image_url';
    } else if (pColNames.includes('image')) {
      _productImageCol = 'p.image AS image_url';
      _productImageGroupBy = 'p.image';
    }
    _columnsChecked = true;
  } catch (_) {
    _hasPaidAmount = false;
    _hasServiceStatus = false;
    _hasTotalAmount = false;
    _hasIsActiveUsers = false;
  }
}

// GET /api/dashboard/stats
router.get('/stats',
  optionalAuth,
  async (req, res) => {
    try {
      await checkColumns();

      // Timezone-aware date for Asia/Jakarta (WIB)
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
      
      // Admin can filter by branch_id if provided via query; non-admin defaults to their assigned branch
      const branch_id = req.query.branch_id || (req.user && req.user.role !== 'admin' ? req.user.branch_id : null);
      const branchWhere = branch_id ? ' AND branch_id = ?' : '';
      const branchParam = branch_id ? [branch_id] : [];

      // Safe expressions based on table columns
      const revenueExpr = _hasPaidAmount
        ? 'COALESCE(paid_amount, total, 0)'
        : (_hasTotalAmount ? 'COALESCE(total, total_amount, 0)' : 'COALESCE(total, 0)');

      const bookingPendingWhere = _hasServiceStatus
        ? "order_type IN ('booking', 'preorder') AND (service_status = 'pending' OR order_status = 'pending')"
        : "order_type IN ('booking', 'preorder') AND order_status = 'pending'";

      const [
        [ordersToday],
        [revenueToday],
        [pendingOrdersBookings],
        [pendingBookingsTable],
        [totalProducts],
        [ordersByStatus],
        [revenueLast7Days],
        [recentOrders],
        [topProducts],
        [totalUsers],
        [ordersCount],
        [totalRevenueAll],
        [totalTables],
      ] = await Promise.all([
        // Total orders today (scoped to branch, non-cancelled)
        db.query(
          `SELECT COUNT(*) AS total_orders
           FROM orders
           WHERE (DATE(created_at) = ? OR DATE(created_at) = CURDATE())
             AND order_status != 'cancelled'${branchWhere}`,
          [today, ...branchParam]
        ),

        // Total revenue today (paid orders + partial DP, scoped to branch)
        db.query(
          `SELECT COALESCE(SUM(${revenueExpr}), 0) AS total_revenue
           FROM orders
           WHERE (DATE(created_at) = ? OR DATE(created_at) = CURDATE())
             AND payment_status IN ('paid', 'partial')
             AND order_status != 'cancelled'${branchWhere}`,
          [today, ...branchParam]
        ),

        // Total pending bookings/preorders from orders table
        db.query(
          `SELECT COUNT(*) AS total_bookings_pending
           FROM orders
           WHERE ${bookingPendingWhere}
             AND order_status != 'cancelled'${branchWhere}`,
          [...branchParam]
        ),

        // Total pending bookings from bookings table (if table exists)
        db.query(
          `SELECT COUNT(*) AS count
           FROM bookings
           WHERE status = 'pending'${branchWhere}`
        ).catch(() => [[{ count: 0 }]]),

        // Total active products
        db.query(
          `SELECT COUNT(*) AS total_products
           FROM products
           WHERE status = 'active'`
        ),

        // Orders by status (today, scoped to branch)
        db.query(
          `SELECT order_status AS status, COUNT(*) AS count
           FROM orders
           WHERE (DATE(created_at) = ? OR DATE(created_at) = CURDATE())
             ${branchWhere}
           GROUP BY order_status`,
          [today, ...branchParam]
        ),

        // Revenue last 7 days (scoped to branch)
        db.query(
          `SELECT DATE(created_at) AS date,
                  COALESCE(SUM(${revenueExpr}), 0) AS revenue,
                  COUNT(*) AS orders
           FROM orders
           WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
             AND payment_status IN ('paid', 'partial')
             AND order_status != 'cancelled'${branchWhere}
           GROUP BY DATE(created_at)
           ORDER BY date ASC`,
          [...branchParam]
        ),

        // Recent Orders (scoped to branch)
        db.query(
          `SELECT id, order_number, customer_name, order_type,
                  ${revenueExpr} AS total,
                  payment_status, order_status, created_at
           FROM orders
           WHERE 1=1 ${branchWhere}
           ORDER BY id DESC LIMIT 5`,
          [...branchParam]
        ),

        // Top Products (scoped to branch)
        db.query(
          `SELECT oi.product_id AS id,
                  oi.product_name AS name, 
                  SUM(oi.quantity) AS total_sold, 
                  COALESCE(SUM(oi.subtotal), SUM(COALESCE(oi.product_price, 0) * oi.quantity)) AS revenue,
                  ${_productImageCol}
           FROM order_items oi 
           JOIN orders o ON o.id = oi.order_id 
           LEFT JOIN products p ON p.id = oi.product_id 
           WHERE o.order_status != 'cancelled' ${branchWhere.replace('branch_id', 'o.branch_id')}
           GROUP BY oi.product_id, oi.product_name, ${_productImageGroupBy}
           ORDER BY total_sold DESC LIMIT 6`,
          [...branchParam]
        ),

        // Total active / registered users
        db.query(
          `SELECT COUNT(*) AS total_users
           FROM users
           WHERE ${_hasIsActiveUsers ? "(status = 'active' OR is_active = 1)" : "status = 'active'"}`
        ).catch(() => [[{ total_users: 0 }]]),

        // All time orders count (for public/compatibility)
        db.query(`SELECT COUNT(*) AS count FROM orders`).catch(() => [[{ count: 0 }]]),

        // All time revenue (for public/compatibility)
        db.query(`SELECT COALESCE(SUM(${revenueExpr}), 0) AS total_revenue FROM orders WHERE payment_status IN ('paid', 'partial') AND order_status != 'cancelled'`).catch(() => [[{ total_revenue: 0 }]]),

        // Total tables
        db.query(`SELECT COUNT(*) AS count FROM \`tables\``).catch(() => [[{ count: 0 }]]),
      ]);

      const totalRevenueTodayNum = parseFloat(revenueToday[0]?.total_revenue || 0);
      const totalBookingsPendingNum = (pendingOrdersBookings[0]?.total_bookings_pending || 0) + (pendingBookingsTable[0]?.count || 0);
      const totalProductsNum = totalProducts[0]?.total_products || 0;
      const totalUsersNum = totalUsers[0]?.total_users || 0;
      const totalOrdersTodayNum = ordersToday[0]?.total_orders || 0;

      res.json({
        // Primary fields for Admin Panel Dashboard (DashboardPage.jsx)
        total_orders: totalOrdersTodayNum,
        total_revenue: totalRevenueTodayNum,
        total_bookings_pending: totalBookingsPendingNum,
        total_products: totalProductsNum,
        total_users: totalUsersNum,
        orders_by_status: ordersByStatus,
        revenue_last_7_days: revenueLast7Days,
        recent_orders: recentOrders,
        top_products: topProducts,
        branch_id,

        // Backward compatibility & Public stats (Gallery, SaaS, landing)
        orders: totalOrdersTodayNum,
        revenue_today: totalRevenueTodayNum.toString(),
        revenue_month: '0.00',
        tables: totalTables[0]?.count || 0,
        products: totalProductsNum,
        users: totalUsersNum,
        total_orders_count: ordersCount[0]?.count || 0,
        total_all_revenue: totalRevenueAll[0]?.total_revenue?.toString() || '0.00',
        tier: process.env.PRICING_TIER || 'free',
        ram_mb: parseInt(process.env.RAM_MB || '64'),
        cpu_cores: parseFloat(process.env.CPU_CORES || '0.25'),
        customers: totalUsersNum || 150,
        varieties: totalProductsNum || 24,
        experience: 5,
        rating: 4.9,
      });
    } catch (error) {
      console.error('Dashboard stats error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
