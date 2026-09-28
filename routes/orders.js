const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize, can } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');
const { triggerOrderEvent } = require('../services/integrations');
const { sendOrderNotification, clearBadgeForUser } = require('../services/pushNotification');

// Lazy-load multer & storageService — only when proof upload endpoint is hit
// (avoids pulling in sharp at startup which requires Node >= 20)
function getProofUpload() {
  const multer = require('multer');
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
      else cb(new Error('Hanya JPEG/PNG/WebP'));
    },
  });
}

// Valid order status transitions
const ORDER_STATUS_TRANSITIONS = {
  pending: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

// Helper: generate sequential order number (global, never resets)
// Format: ORD-YYYYMMDD-XXXXX (5-digit global sequence)
const generateOrderNumber = async () => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE order_sequences SET last_number = last_number + 1 WHERE seq_key = "order"');
    const [[row]] = await conn.query('SELECT last_number FROM order_sequences WHERE seq_key = "order"');
    await conn.commit();
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `ORD-${datePart}-${String(row.last_number).padStart(5, '0')}`;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
};

// Helper: get tax rate from settings
const getTaxRate = async () => {
  const [rows] = await db.query(
    'SELECT setting_value FROM system_settings WHERE setting_key = "tax_rate" LIMIT 1'
  );
  if (rows.length > 0) {
    const val = parseFloat(rows[0].setting_value);
    return isNaN(val) ? 0 : val;
  }
  return 0;
};

// Helper: resolve and validate order items array (shared by create & edit)
const resolveItems = async (items) => {
  const resolvedItems = [];
  for (const item of items) {
    const [[product]] = await db.query(
      'SELECT id, name, price, status, product_type, service_type FROM products WHERE id = ?',
      [item.product_id]
    );
    if (!product) throw Object.assign(new Error(`Product ${item.product_id} tidak ditemukan`), { statusCode: 400 });
    if (product.status !== 'active') throw Object.assign(new Error(`Produk "${product.name}" tidak aktif`), { statusCode: 400 });

    let variantModifier = 0;
    let addonsTotalPerUnit = 0;
    const variantsSelected = [];
    const addonsSelected = [];

    if (item.variants && Array.isArray(item.variants)) {
      for (const v of item.variants) {
        const [[opt]] = await db.query(
          `SELECT vo.id, vo.name, vo.price_modifier, vg.name AS group_name
           FROM product_variant_options vo
           JOIN product_variant_groups vg ON vg.id = vo.group_id
           WHERE vo.id = ? AND vg.product_id = ? AND vo.is_active = 1`,
          [v.option_id, item.product_id]
        );
        if (!opt) throw Object.assign(new Error(`Varian option #${v.option_id} tidak valid untuk produk ini`), { statusCode: 400 });
        variantModifier += parseFloat(opt.price_modifier || 0);
        variantsSelected.push({ group_id: v.group_id, group_name: opt.group_name, option_id: opt.id, option_name: opt.name, price_modifier: parseFloat(opt.price_modifier || 0) });
      }
    }

    if (item.addons && Array.isArray(item.addons)) {
      for (const a of item.addons) {
        const [[addon]] = await db.query(
          `SELECT pa.id, pa.name, pa.price, pa.max_qty, ag.name AS group_name
           FROM product_addons pa
           JOIN product_addon_groups ag ON ag.id = pa.group_id
           WHERE pa.id = ? AND ag.product_id = ? AND pa.is_active = 1`,
          [a.addon_id, item.product_id]
        );
        if (!addon) throw Object.assign(new Error(`Addon #${a.addon_id} tidak valid untuk produk ini`), { statusCode: 400 });
        const qty = Math.min(parseInt(a.qty || 1), addon.max_qty);
        addonsTotalPerUnit += parseFloat(addon.price) * qty;
        addonsSelected.push({ addon_id: addon.id, addon_name: addon.name, group_name: addon.group_name, qty, unit_price: parseFloat(addon.price) });
      }
    }

    const basePrice = parseFloat(product.price);
    const unitPrice = basePrice + variantModifier;
    const itemSubtotal = (unitPrice + addonsTotalPerUnit) * item.quantity;
    const variantSuffix = variantsSelected.map(v => v.option_name).join(', ');
    const displayName = variantSuffix ? `${product.name} (${variantSuffix})` : product.name;

    resolvedItems.push({
      product_id: product.id,
      product_name: displayName,
      product_price: basePrice,
      unit_price: unitPrice,
      addons_total: addonsTotalPerUnit * item.quantity,
      quantity: item.quantity,
      subtotal: itemSubtotal,
      notes: item.notes || null,
      variants_selected: variantsSelected.length ? JSON.stringify(variantsSelected) : null,
      addons_selected: addonsSelected.length ? JSON.stringify(addonsSelected) : null,
      product_type: product.product_type || 'product',
      service_type: product.service_type || null,
      service_date: item.service_date || null,
      service_time: item.service_time || null,
      service_details: item.service_details ? (typeof item.service_details === 'object' ? JSON.stringify(item.service_details) : String(item.service_details)) : null,
    });
  }
  return resolvedItems;
};

// Helper: insert resolved items into order_items
const insertOrderItems = async (orderId, resolvedItems) => {
  for (const item of resolvedItems) {
    const [[ps]] = await db.query('SELECT station_id FROM product_stations WHERE product_id = ? LIMIT 1', [item.product_id]);
    let stationId = ps?.station_id || null;
    if (!stationId) {
      const [[cs]] = await db.query(
        `SELECT cs.station_id FROM category_stations cs
         JOIN products p ON p.category_id = cs.category_id
         WHERE p.id = ? LIMIT 1`,
        [item.product_id]
      );
      stationId = cs?.station_id || null;
    }
    await db.query(
      `INSERT INTO order_items
         (order_id, product_id, product_name, product_price, unit_price, addons_total,
          quantity, subtotal, notes, variants_selected, addons_selected, station_id, station_status,
          service_date, service_time, service_details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, item.product_id, item.product_name, item.product_price, item.unit_price,
       item.addons_total, item.quantity, item.subtotal, item.notes,
       item.variants_selected, item.addons_selected,
       stationId, stationId ? 'pending' : null,
       item.service_date || null, item.service_time || null, item.service_details || null]
    );
  }
};

// Helper: log activity
const logActivity = async (userId, action, recordId, oldValues, newValues) => {
  await db.query(
    'INSERT INTO activity_logs (user_id, action, table_name, record_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)',
    [
      userId,
      action,
      'orders',
      recordId || null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ]
  );
};

// GET / — admin sees all, kasir/waiter sees own; filter by status, date, order_type
router.get('/',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 500 }),
    query('status').optional().isIn(['pending', 'preparing', 'ready', 'completed', 'cancelled']),
    query('payment_status').optional().isIn(['pending', 'paid', 'partial', 'refund']),
    query('order_type').optional().isIn(['dine-in', 'takeaway', 'delivery', 'booking', 'preorder', 'service']),
    query('service_status').optional().isIn(['pending', 'confirmed', 'in_progress', 'completed', 'cancelled']),
    query('service_date').optional().isISO8601(),
    query('date_from').optional().isISO8601(),
    query('date_to').optional().isISO8601(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const offset = (page - 1) * limit;
      const { status, payment_status, order_type, date_from, date_to, served_by, search, branch_id, service_status, service_date } = req.query;

      let baseQuery = 'FROM orders o LEFT JOIN users u ON u.id = o.served_by LEFT JOIN branches b ON b.id = o.branch_id WHERE o.order_status != "deleted"';
      const params = [];

      if (service_status) {
        baseQuery += ' AND o.service_status = ?';
        params.push(service_status);
      }

      if (service_date) {
        baseQuery += ' AND o.service_date = ?';
        params.push(service_date);
      }

      // RBAC: kasir sees all orders in their branch, waiter sees their own only
      if (req.user.role === 'kasir') {
        if (req.user.branch_id) {
          baseQuery += ' AND o.branch_id = ?';
          params.push(req.user.branch_id);
        }
      } else if (req.user.role === 'waiter') {
        baseQuery += ' AND o.served_by = ?';
        params.push(req.user.id);
        if (req.user.branch_id) {
          baseQuery += ' AND o.branch_id = ?';
          params.push(req.user.branch_id);
        }
      } else {
        if (served_by) {
          baseQuery += ' AND o.served_by = ?';
          params.push(served_by);
        }
        if (branch_id) {
          baseQuery += ' AND o.branch_id = ?';
          params.push(branch_id);
        }
      }

      if (search) {
        baseQuery += ' AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.table_number LIKE ?)';
        const s = `%${search}%`;
        params.push(s, s, s);
      }

      if (status) {
        baseQuery += ' AND o.order_status = ?';
        params.push(status);
      }

      if (payment_status) {
        baseQuery += ' AND o.payment_status = ?';
        params.push(payment_status);
      }

      if (order_type) {
        baseQuery += ' AND o.order_type = ?';
        params.push(order_type);
      }

      if (date_from) {
        baseQuery += ' AND DATE(o.created_at) >= ?';
        params.push(date_from);
      }

      if (date_to) {
        baseQuery += ' AND DATE(o.created_at) <= ?';
        params.push(date_to);
      }

      const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
      const [[{ total_revenue, total_revenue_paid }]] = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN o.order_status = 'completed' THEN o.total ELSE 0 END), 0) AS total_revenue,
           COALESCE(SUM(o.paid_amount), 0) AS total_revenue_paid
         ${baseQuery}`,
        params
      );

      const [orders] = await db.query(
        `SELECT o.id, o.order_number, o.customer_name, o.customer_email, o.customer_phone,
                o.table_id, o.table_number, o.order_type, o.subtotal, o.tax, o.discount, o.total,
                o.paid_amount, o.dp_amount, o.remaining_amount, o.dp_payment_method, o.dp_paid_at,
                o.settlement_payment_method, o.settlement_paid_at,
                o.service_date, o.service_time, o.service_person_count, o.service_status,
                o.payment_method, o.payment_status, o.order_status, o.notes,
                o.served_by, u.name AS served_by_name, o.branch_id, b.name AS branch_name,
                o.created_at, o.updated_at
         ${baseQuery} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      res.json({
        orders,
        total_revenue: parseFloat(total_revenue),
        total_revenue_paid: parseFloat(total_revenue_paid),
        pagination: {
          total,
          page,
          limit,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('Get orders error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /services/stats — summary counts for ServicesPage card totals
router.get('/services/stats',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  async (req, res) => {
    try {
      const { order_type, branch_id } = req.query;
      let sql = `
        SELECT 
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN o.service_status = 'pending' OR o.service_status IS NULL THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN o.service_status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
          COALESCE(SUM(CASE WHEN o.service_status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress,
          COALESCE(SUM(CASE WHEN o.service_status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COALESCE(SUM(CASE WHEN o.service_status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
          COALESCE(SUM(o.total), 0) AS total_value,
          COALESCE(SUM(o.paid_amount), 0) AS total_paid,
          COALESCE(SUM(COALESCE(o.remaining_amount, GREATEST(0, o.total - COALESCE(o.paid_amount, 0)))), 0) AS total_remaining
        FROM orders o
        WHERE o.order_status != "deleted"
          AND (o.order_type IN ('booking', 'preorder', 'service') OR o.service_date IS NOT NULL)
      `;
      const params = [];

      if (order_type && order_type !== 'all') {
        sql += ' AND o.order_type = ?';
        params.push(order_type);
      }

      // Branch RBAC / filter
      if (req.user.role === 'kasir' || req.user.role === 'waiter') {
        if (req.user.branch_id) {
          sql += ' AND o.branch_id = ?';
          params.push(req.user.branch_id);
        }
      } else if (branch_id && branch_id !== 'all') {
        sql += ' AND o.branch_id = ?';
        params.push(branch_id);
      }

      const [[stats]] = await db.query(sql, params);

      res.json({
        total: parseInt(stats.total || 0),
        pending: parseInt(stats.pending || 0),
        confirmed: parseInt(stats.confirmed || 0),
        in_progress: parseInt(stats.in_progress || 0),
        completed: parseInt(stats.completed || 0),
        cancelled: parseInt(stats.cancelled || 0),
        total_value: parseFloat(stats.total_value || 0),
        total_paid: parseFloat(stats.total_paid || 0),
        total_remaining: parseFloat(stats.total_remaining || 0),
      });
    } catch (error) {
      console.error('Get services stats error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /cancel-requests — MUST be before /:id to avoid route conflict
router.get('/cancel-requests',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const [requests] = await db.query(
        `SELECT cr.*, o.order_number, o.order_status,
                u.name AS requested_by_name, rv.name AS reviewed_by_name
         FROM order_cancel_requests cr
         JOIN orders o ON o.id = cr.order_id
         LEFT JOIN users u ON u.id = cr.requested_by
         LEFT JOIN users rv ON rv.id = cr.reviewed_by
         WHERE cr.status = 'pending'
         ORDER BY cr.created_at DESC`
      );
      res.json({ requests });
    } catch (error) {
      console.error('Get cancel requests error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /cancel-requests/:requestId — MUST be before /:id
router.put('/cancel-requests/:requestId',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { action, note } = req.body;
      const status = req.body.status || (action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : null);

      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'status harus "approved" atau "rejected"' });
      }

      const [[cancelReq]] = await db.query('SELECT * FROM order_cancel_requests WHERE id = ?', [requestId]);
      if (!cancelReq) return res.status(404).json({ error: 'Cancel request tidak ditemukan' });
      if (cancelReq.status !== 'pending') return res.status(400).json({ error: 'Cancel request sudah diproses' });

      await db.query(
        'UPDATE order_cancel_requests SET status=?, reviewed_by=?, reviewed_at=NOW(), note=? WHERE id=?',
        [status, req.user.id, note || null, requestId]
      );

      if (status === 'approved') {
        await db.query('UPDATE orders SET order_status="cancelled" WHERE id=?', [cancelReq.order_id]);
        await logActivity(req.user.id, 'cancel_request_approved', cancelReq.order_id, null, { request_id: requestId, note });
      } else {
        await logActivity(req.user.id, 'cancel_request_rejected', cancelReq.order_id, null, { request_id: requestId, note });
      }

      res.json({ message: `Permintaan pembatalan ${status === 'approved' ? 'disetujui' : 'ditolak'}`, status });
    } catch (error) {
      console.error('Cancel request review error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /:id — with items
router.get('/:id',
  authenticate,
  authorize('admin', 'kasir'),
  param('id').isInt({ min: 1 }).withMessage('Invalid order ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const orderId = req.params.id;

      const [orders] = await db.query(
        `SELECT o.*, u.name AS served_by_name
         FROM orders o
         LEFT JOIN users u ON o.served_by = u.id
         WHERE o.id = ? AND o.order_status != 'deleted'`,
        [orderId]
      );

      if (orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // RBAC: kasir can view any order in their branch
      if (req.user.role === 'kasir' && req.user.branch_id && orders[0].branch_id !== req.user.branch_id) {
        return res.status(403).json({ error: 'Access denied: not your branch' });
      }

      const [items] = await db.query(
        'SELECT * FROM order_items WHERE order_id = ?',
        [orderId]
      );

      const [payments] = await db.query(
        `SELECT op.*, u.name AS cashier_name
         FROM order_payments op
         LEFT JOIN users u ON op.cashier_id = u.id
         WHERE op.order_id = ?
         ORDER BY op.created_at ASC`,
        [orderId]
      );

      res.json({ order: { ...orders[0], items, payments } });
    } catch (error) {
      console.error('Get order error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /qris/unique-code — Generate daily sequential unique code globally
router.get('/qris/unique-code', authenticate, async (req, res) => {
  try {
    // Count today's orders globally to determine sequence without branch prefix
    const [[{ count }]] = await db.query(
      'SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = CURDATE()'
    );
    const sequence = count + 1;
    res.json({ kode_unik: sequence });
  } catch (error) {
    console.error('Get QRIS unique code error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / — create with items array, auto-generate order_number, calculate totals
router.post('/',
  authenticate,
  authorize('admin', 'kasir', 'waiter', 'member'),
  sanitizeInput,
  [
    body('customer_name').optional().trim(),
    body('customer_email').optional({ nullable: true, checkFalsy: true }).isEmail().withMessage('Invalid customer email'),
    body('customer_phone').optional().trim(),
    body('table_number').optional().trim(),
    body('table_id').optional({ nullable: true }).isInt({ min: 1 }),
    body('order_type').isIn(['dine-in', 'takeaway', 'delivery', 'booking', 'preorder', 'service']).withMessage('Invalid order type'),
    body('service_date').optional({ nullable: true }),
    body('service_time').optional({ nullable: true }),
    body('service_person_count').optional({ nullable: true }),
    body('service_status').optional({ nullable: true }),
    body('dp_amount').optional({ nullable: true }).isFloat({ min: 0 }),
    body('payment_method').optional(),
    body('notes').optional().trim(),
    body('discount').optional().isFloat({ min: 0 }).withMessage('Discount must be a non-negative number'),
    body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
    body('items.*.product_id').isInt({ min: 1 }).withMessage('Each item must have a valid product_id'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Each item quantity must be at least 1'),
    body('items.*.notes').optional().trim(),
    // variants: [{ group_id, option_id }]
    // addons:   [{ addon_id, qty }]
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        customer_name,
        customer_email,
        customer_phone,
        table_number,
        table_id,
        order_type,
        service_date,
        service_time,
        service_person_count,
        service_status,
        payment_method,
        notes,
        discount,
        items,
        voucher_code,
      } = req.body;

      if (payment_method && !isNaN(Number(payment_method))) {
        const [pmRows] = await db.query('SELECT code FROM payment_methods WHERE id = ?', [Number(payment_method)]);
        if (pmRows.length > 0) payment_method = pmRows[0].code;
      }

      // If table_id provided, fetch table_number and mark table as occupied
      let resolvedTableNumber = table_number || null;
      if (table_id) {
        const [[tbl]] = await db.query('SELECT id, table_number, name, status FROM tables WHERE id = ?', [table_id]);
        if (tbl) {
          resolvedTableNumber = tbl.table_number;
          // Mark table occupied
          await db.query('UPDATE tables SET status = "occupied" WHERE id = ?', [table_id]);
        }
      }

      // Validate products and build items (with variants + addons)
      let resolvedItems;
      try {
        resolvedItems = await resolveItems(items);
      } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
      }

      // Calculate totals
      const subtotal = resolvedItems.reduce((sum, i) => sum + i.subtotal, 0);
      const taxRate = await getTaxRate();
      const discountAmount = parseFloat(discount) || 0;

      // Process voucher atomically (validate + lock + increment in one transaction)
      let voucherDiscount = 0;
      let appliedVoucherCode = null;
      let appliedVoucherId = null;
      let freeItemFromVoucher = null;
      let voucherBonusMultiplier = 1;

      if (voucher_code) {
        const { redeemVoucher } = require('./vouchers');
        const effectiveBranchId = req.body.branch_id || req.user.branch_id || 1;
        const memberId = req.user.role === 'member' ? req.user.id : null;
        // orderId not yet known — pass null, will update usage record after INSERT
        const vResult = await redeemVoucher(
          voucher_code, subtotal, effectiveBranchId, memberId, null, req.user.id, resolvedItems
        );
        if (!vResult.ok) {
          return res.status(400).json({ error: `Voucher: ${vResult.error}` });
        }
        voucherDiscount = vResult.discount_amount || 0;
        appliedVoucherCode = vResult.code;
        appliedVoucherId = vResult.voucher_id;
        freeItemFromVoucher = vResult.free_item;
        voucherBonusMultiplier = vResult.bonus_points_multiplier || 1;
      }

      const totalDiscountAmount = discountAmount + voucherDiscount;

      const taxAmount = parseFloat(((subtotal - totalDiscountAmount) * taxRate / 100).toFixed(2));
      const total = parseFloat((subtotal - totalDiscountAmount + taxAmount).toFixed(2));

      const orderNumber = await generateOrderNumber();
      const branchId = req.body.branch_id || req.user.branch_id || 1;

      // Determine payment and DP breakdown
      let dpAmountVal = parseFloat(req.body.dp_amount) || 0;
      let paymentMethodVal = payment_method || null;
      let paymentStatusVal = 'pending';
      let paidAmountVal = 0;
      let remainingAmountVal = total;
      let dpPaymentMethod = null;
      let dpPaidAt = null;

      const isPendingMethod = !paymentMethodVal ||
        paymentMethodVal === 'pending' ||
        paymentMethodVal === 'unpaid' ||
        req.body.payment_status === 'pending' ||
        req.body.payment_status === 'unpaid' ||
        Boolean(req.body.is_pending);

      if (!isPendingMethod) {
        if (dpAmountVal > 0 && dpAmountVal < total) {
          paymentStatusVal = 'partial';
          paidAmountVal = dpAmountVal;
          remainingAmountVal = parseFloat((total - dpAmountVal).toFixed(2));
          dpPaymentMethod = paymentMethodVal;
          dpPaidAt = new Date();
        } else {
          paymentStatusVal = 'paid';
          paidAmountVal = total;
          remainingAmountVal = 0;
          dpAmountVal = 0;
        }
      }

      // If payment by balance — check & deduct actual amount paid
      if (paymentMethodVal === 'balance' && paidAmountVal > 0) {
        const [[actor]] = await db.query('SELECT id, balance FROM users WHERE id = ?', [req.user.id]);
        if (!actor || parseFloat(actor.balance) < paidAmountVal) {
          return res.status(400).json({ error: `Saldo tidak cukup. Saldo Anda: ${actor?.balance || 0}` });
        }
        const balBefore = parseFloat(actor.balance);
        const balAfter = parseFloat((balBefore - paidAmountVal).toFixed(2));
        await db.query('UPDATE users SET balance = ? WHERE id = ?', [balAfter, req.user.id]);
        await db.query(
          `INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, reference_type, note, created_by)
           VALUES (?, 'deduct', ?, ?, ?, 'order', ?, ?)`,
          [req.user.id, paidAmountVal, balBefore, balAfter, `Pembayaran ${dpAmountVal > 0 ? 'DP ' : ''}order ${orderNumber}`, req.user.id]
        );
      }

      // Auto-assign active shift for this user
      let activeShiftId = null;
      try {
        const [[openShift]] = await db.query(
          'SELECT id FROM shifts WHERE status = "open" AND opened_by = ? ORDER BY opened_at DESC LIMIT 1',
          [req.user.id]
        );
        activeShiftId = openShift?.id || null;
      } catch (_) {}

      const effectiveServiceStatus = service_status || (['booking', 'preorder', 'service'].includes(order_type) ? 'pending' : null);

      const [orderResult] = await db.query(
        `INSERT INTO orders
          (order_number, customer_name, customer_email, customer_phone, table_number, table_id,
           order_type, subtotal, tax, discount, total, paid_amount, dp_amount, remaining_amount,
           dp_payment_method, dp_paid_at, payment_method, payment_status,
           order_status, notes, served_by, branch_id, voucher_code, voucher_discount, shift_id,
           service_date, service_time, service_person_count, service_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNumber,
          customer_name || null,
          customer_email || null,
          customer_phone || null,
          resolvedTableNumber,
          table_id || null,
          order_type,
          subtotal,
          taxAmount,
          discountAmount,
          total,
          paidAmountVal,
          dpAmountVal,
          remainingAmountVal,
          dpPaymentMethod,
          dpPaidAt,
          paymentMethodVal,
          paymentStatusVal,
          notes || null,
          req.user.id,
          branchId,
          appliedVoucherCode,
          voucherDiscount,
          activeShiftId,
          service_date || null,
          service_time || null,
          service_person_count ? parseInt(service_person_count) : null,
          effectiveServiceStatus,
        ]
      );

      const orderId = orderResult.insertId;

      // Record payment into order_payments & update shift running totals
      if (paidAmountVal > 0) {
        try {
          await db.query(
            `INSERT INTO order_payments (order_id, payment_type, amount, payment_method, payment_status, notes, shift_id, cashier_id, created_at)
             VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, NOW())`,
            [
              orderId,
              paymentStatusVal === 'partial' ? 'dp' : 'full',
              paidAmountVal,
              paymentMethodVal || 'cash',
              paymentStatusVal === 'partial' ? 'Uang Muka / DP' : 'Pembayaran Penuh',
              activeShiftId,
              req.user.id,
            ]
          );
        } catch (e) {
          console.error('Record order_payment error:', e);
        }
      }

      if (activeShiftId) {
        try {
          await db.query(
            `UPDATE shifts SET
               total_orders  = total_orders + 1,
               total_revenue = total_revenue + ?,
               cash_revenue  = cash_revenue + ?
             WHERE id = ?`,
            [paidAmountVal, paymentMethodVal === 'cash' ? paidAmountVal : 0, activeShiftId]
          );
        } catch (_) {}
      }

      await insertOrderItems(orderId, resolvedItems);

      // Back-fill order_id on the voucher_usages row (was inserted with NULL during lock)
      if (appliedVoucherId) {
        await db.query(
          'UPDATE voucher_usages SET order_id = ? WHERE voucher_id = ? AND order_id IS NULL ORDER BY id DESC LIMIT 1',
          [orderId, appliedVoucherId]
        );
      }

      // Insert free item from voucher
      if (freeItemFromVoucher && appliedVoucherId) {
        try {
          const [[fp]] = await db.query('SELECT id, name, price, status FROM products WHERE id = ?', [freeItemFromVoucher.product_id]);
          if (fp && fp.status === 'active') {
            await db.query(
              `INSERT INTO order_items (order_id, product_id, product_name, product_price, unit_price, quantity, subtotal, notes, station_status)
               VALUES (?, ?, ?, ?, 0, ?, 0, ?, NULL)`,
              [orderId, fp.id, `[GRATIS] ${fp.name}`, parseFloat(fp.price), freeItemFromVoucher.qty, 'Voucher: ' + appliedVoucherCode]
            );
          }
        } catch (_) {}
      }

      // Deduct per-branch stock for each product ordered (skip services)
      if (branchId) {
        for (const item of resolvedItems) {
          if (!item.product_id) continue;
          if (item.product_type === 'service') continue; // Services don't deduct physical stock
          const qty = parseInt(item.quantity || item.qty || 0);
          if (qty <= 0) continue;
          try {
            // Ensure row exists
            await db.query(
              'INSERT INTO product_branch_stock (product_id, branch_id, stock, min_stock) VALUES (?,?,0,0) ON DUPLICATE KEY UPDATE stock=stock',
              [item.product_id, branchId]
            );
            await db.query(
              'UPDATE product_branch_stock SET stock = GREATEST(0, stock - ?) WHERE product_id=? AND branch_id=?',
              [qty, item.product_id, branchId]
            );
          } catch (_) { /* non-blocking — stock tracking optional */ }
        }
      }

      await logActivity(req.user.id, 'create_order', orderId, null, { order_number: orderNumber, total });

      // Send push notification to kasir/admin devices
      sendOrderNotification({
        id: orderId,
        order_number: orderNumber,
        order_type,
        table_number: resolvedTableNumber,
        total,
      }).catch(() => {});

      if (req.io) {
        req.io.to('all').emit('order_created', {
          id: orderId,
          order_number: orderNumber,
          order_type,
          table_number: resolvedTableNumber,
          total,
          branch_id: branchId
        });
      }

      res.status(201).json({
        message: 'Order created successfully',
        order: {
          id: orderId,
          order_number: orderNumber,
          subtotal,
          tax: taxAmount,
          discount: discountAmount,
          total,
          paid_amount: paidAmountVal,
          dp_amount: dpAmountVal,
          remaining_amount: remainingAmountVal,
          payment_method: paymentMethodVal,
          payment_status: paymentStatusVal,
          voucher_code: appliedVoucherCode,
          voucher_discount: voucherDiscount,
          items: resolvedItems,
        },
      });
    } catch (error) {
      console.error('Create order error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id/status — valid transitions only
router.put('/:id/status',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  can('update_status', 'orders'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid order ID'),
    body('status')
      .isIn(['pending', 'preparing', 'ready', 'completed', 'cancelled'])
      .withMessage('Invalid order status'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const orderId = req.params.id;
      const newStatus = req.body.status;

      const [orders] = await db.query(
        'SELECT id, order_status, served_by FROM orders WHERE id = ? AND order_status != "deleted"',
        [orderId]
      );

      if (orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = orders[0];

      // Kasir can only update own orders
      if (req.user.role === 'kasir' && order.served_by !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const allowedNext = ORDER_STATUS_TRANSITIONS[order.order_status] || [];
      if (!allowedNext.includes(newStatus)) {
        return res.status(400).json({
          error: 'Invalid status transition',
          message: `Cannot move from "${order.order_status}" to "${newStatus}". Allowed: ${allowedNext.join(', ') || 'none'}`,
        });
      }

      await db.query('UPDATE orders SET order_status = ? WHERE id = ?', [newStatus, orderId]);

      if (req.io) {
        req.io.to('all').emit('order_updated', { id: orderId, status: newStatus });
      }

      // Clear push notification badge when kasir starts processing order (pending → *)
      if (order.order_status === 'pending') {
        clearBadgeForUser(req.user.id).catch(() => {});
      }

      // Free table when order completed or cancelled
      if (newStatus === 'completed' || newStatus === 'cancelled') {
        const [[fullOrder]] = await db.query('SELECT table_id, customer_email, total FROM orders WHERE id = ?', [orderId]);
        if (fullOrder?.table_id) {
          // Only free if no other active orders on same table
          const [[{ activeCount }]] = await db.query(
            `SELECT COUNT(*) AS activeCount FROM orders
             WHERE table_id = ? AND id != ? AND order_status NOT IN ('completed','cancelled')`,
            [fullOrder.table_id, orderId]
          );
          if (activeCount === 0) {
            await db.query('UPDATE tables SET status = "available" WHERE id = ?', [fullOrder.table_id]);
          }
        }

        // Update member stats when order is completed
        if (newStatus === 'completed' && fullOrder?.customer_email) {
          await db.query(
            `UPDATE users
             SET total_orders = total_orders + 1,
                 total_spent  = total_spent  + ?
             WHERE email = ? AND role = 'member'`,
            [parseFloat(fullOrder.total) || 0, fullOrder.customer_email]
          );
        }
      }

      await logActivity(
        req.user.id, 'update_order_status', orderId,
        { order_status: order.order_status }, { order_status: newStatus }
      );

      if (newStatus === 'completed') {
        const [[fullOrder]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
        triggerOrderEvent('order.completed', fullOrder).catch((err) =>
          console.error('[Integration] order.completed failed:', err.message)
        );
      }

      res.json({ message: 'Order status updated', order_status: newStatus });
    } catch (error) {
      console.error('Update order status error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id/service-status — admin/kasir/waiter update service order status
router.put('/:id/service-status',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid order ID'),
    body('service_status')
      .isIn(['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'])
      .withMessage('Invalid service status'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const orderId = req.params.id;
      const { service_status } = req.body;

      const [orders] = await db.query(
        'SELECT id, service_status, order_status FROM orders WHERE id = ?',
        [orderId]
      );
      if (orders.length === 0) return res.status(404).json({ error: 'Order not found' });

      await db.query(
        'UPDATE orders SET service_status = ?, updated_at = NOW() WHERE id = ?',
        [service_status, orderId]
      );

      // If service completed, optionally update order_status to completed if ready
      if (service_status === 'completed') {
        await db.query(
          'UPDATE orders SET order_status = "completed" WHERE id = ? AND order_status IN ("pending", "preparing", "ready")',
          [orderId]
        );
      } else if (service_status === 'cancelled') {
        await db.query(
          'UPDATE orders SET order_status = "cancelled" WHERE id = ?',
          [orderId]
        );
      }

      res.json({ message: 'Service status updated', service_status });
    } catch (error) {
      console.error('Update service status error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id/payment — admin/kasir
router.put('/:id/payment',
  authenticate,
  authorize('admin', 'kasir'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid order ID'),
    body('payment_status')
      .isIn(['pending', 'paid', 'partial', 'refund'])
      .withMessage('Invalid payment status'),
    body('payment_method').optional().isLength({ max: 50 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const orderId = req.params.id;
      const { payment_status, payment_method } = req.body;

      const [orders] = await db.query(
        'SELECT id, order_number, total, paid_amount, remaining_amount, payment_status, payment_method, order_type, service_status, served_by, branch_id FROM orders WHERE id = ? AND order_status != "deleted"',
        [orderId]
      );

      if (orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = orders[0];

      // RBAC: kasir can pay any order in their branch
      if (req.user.role === 'kasir' && req.user.branch_id && order.branch_id !== req.user.branch_id) {
        return res.status(403).json({ error: 'Access denied: not your branch' });
      }

      const { cash_received, change_amount } = req.body;
      const effectiveMethod = payment_method || order.payment_method || 'cash';
      const currentPaid = parseFloat(order.paid_amount || 0);
      const orderTotal = parseFloat(order.total || 0);
      const toPay = parseFloat((orderTotal - currentPaid).toFixed(2));

      const updates = ['payment_status = ?'];
      const values = [payment_status];

      if (payment_method) {
        updates.push('payment_method = ?');
        values.push(payment_method);
      }

      // If marked paid, update paid_amount and remaining_amount
      if (payment_status === 'paid') {
        updates.push('paid_amount = ?', 'remaining_amount = 0.00', 'settlement_payment_method = ?', 'settlement_paid_at = NOW()');
        values.push(orderTotal, effectiveMethod);

        // Auto-complete order when payment is made (unless it is a scheduled service/booking)
        if (!['booking', 'preorder', 'service'].includes(order.order_type)) {
          updates.push('order_status = ?');
          values.push('completed');
        } else if (order.service_status === 'pending') {
          updates.push('service_status = ?');
          values.push('confirmed');
        }
      }

      if (cash_received != null) {
        updates.push('cash_received = ?');
        values.push(Number(cash_received));
      }
      if (change_amount != null) {
        updates.push('change_amount = ?');
        values.push(Number(change_amount));
      }

      values.push(orderId);
      await db.query(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, values);

      // Record in order_payments and update shift if money was paid
      if (payment_status === 'paid' && toPay > 0) {
        let activeShiftId = null;
        try {
          const [[openShift]] = await db.query(
            'SELECT id FROM shifts WHERE status = "open" AND opened_by = ? ORDER BY opened_at DESC LIMIT 1',
            [req.user.id]
          );
          activeShiftId = openShift?.id || null;
        } catch (_) {}

        try {
          await db.query(
            `INSERT INTO order_payments (order_id, payment_type, amount, payment_method, payment_status, notes, shift_id, cashier_id, created_at)
             VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, NOW())`,
            [
              orderId,
              currentPaid > 0 ? 'settlement' : 'full',
              toPay,
              effectiveMethod,
              currentPaid > 0 ? 'Pelunasan Tagihan' : 'Pembayaran Penuh',
              activeShiftId,
              req.user.id
            ]
          );

          if (activeShiftId) {
            await db.query(
              `UPDATE shifts SET
                 total_revenue = total_revenue + ?,
                 cash_revenue  = cash_revenue + ?
               WHERE id = ?`,
              [toPay, effectiveMethod === 'cash' ? toPay : 0, activeShiftId]
            );
          }
        } catch (e) {
          console.error('Record order_payment in payment update error:', e);
        }
      }

      await logActivity(
        req.user.id,
        'update_order_payment',
        orderId,
        { payment_status: order.payment_status, payment_method: order.payment_method },
        { payment_status, payment_method: effectiveMethod }
      );

      res.json({ message: 'Payment updated', payment_status });
    } catch (error) {
      console.error('Update order payment error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /:id/settle — Pelunasan sisa tagihan (DP settlement)
router.post('/:id/settle',
  authenticate,
  authorize('admin', 'kasir'),
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid order ID'),
    body('payment_method').notEmpty().withMessage('Metode pembayaran wajib diisi'),
    body('amount').optional({ nullable: true }).isFloat({ min: 1 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const orderId = req.params.id;
      let { payment_method, amount, notes } = req.body;

      if (payment_method && !isNaN(Number(payment_method))) {
        const [pmRows] = await db.query('SELECT code FROM payment_methods WHERE id = ?', [Number(payment_method)]);
        if (pmRows.length > 0) payment_method = pmRows[0].code;
      }

      const [[order]] = await db.query(
        'SELECT * FROM orders WHERE id = ? AND order_status != "deleted"',
        [orderId]
      );
      if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

      // RBAC: kasir can only settle orders in their branch
      if (req.user.role === 'kasir' && req.user.branch_id && order.branch_id !== req.user.branch_id) {
        return res.status(403).json({ error: 'Access denied: not your branch' });
      }

      const currentRemaining = parseFloat(order.remaining_amount != null ? order.remaining_amount : order.total);
      if (currentRemaining <= 0) {
        return res.status(400).json({ error: 'Pesanan ini sudah lunas' });
      }

      let payAmount = amount != null ? parseFloat(amount) : currentRemaining;
      if (payAmount <= 0) return res.status(400).json({ error: 'Nominal pembayaran tidak valid' });
      if (payAmount > currentRemaining) {
        payAmount = currentRemaining; // cap at remaining balance
      }

      // If payment by balance
      if (payment_method === 'balance') {
        const [[actor]] = await db.query('SELECT id, balance FROM users WHERE id = ?', [req.user.id]);
        if (!actor || parseFloat(actor.balance) < payAmount) {
          return res.status(400).json({ error: `Saldo tidak cukup. Saldo: ${actor?.balance || 0}` });
        }
        const balBefore = parseFloat(actor.balance);
        const balAfter = parseFloat((balBefore - payAmount).toFixed(2));
        await db.query('UPDATE users SET balance = ? WHERE id = ?', [balAfter, req.user.id]);
        await db.query(
          `INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, reference_type, note, created_by)
           VALUES (?, 'deduct', ?, ?, ?, 'order', ?, ?)`,
          [req.user.id, payAmount, balBefore, balAfter, `Pelunasan order #${order.order_number}`, req.user.id]
        );
      }

      const newPaid = parseFloat((parseFloat(order.paid_amount || 0) + payAmount).toFixed(2));
      const newRemaining = Math.max(0, parseFloat((order.total - newPaid).toFixed(2)));
      const isFullyPaid = newRemaining <= 0.01;

      // Find active shift for current cashier
      let activeShiftId = null;
      try {
        const [[openShift]] = await db.query(
          'SELECT id FROM shifts WHERE status = "open" AND opened_by = ? ORDER BY opened_at DESC LIMIT 1',
          [req.user.id]
        );
        activeShiftId = openShift?.id || null;
      } catch (_) {}

      // Insert to order_payments
      await db.query(
        `INSERT INTO order_payments (order_id, payment_type, amount, payment_method, payment_status, notes, shift_id, cashier_id, created_at)
         VALUES (?, 'settlement', ?, ?, 'paid', ?, ?, ?, NOW())`,
        [orderId, payAmount, payment_method, notes || 'Pelunasan', activeShiftId, req.user.id]
      );

      // Update orders table
      const orderUpdates = [
        'paid_amount = ?',
        'remaining_amount = ?',
        'settlement_payment_method = ?',
        'settlement_paid_at = NOW()',
      ];
      const orderParams = [newPaid, newRemaining, payment_method];

      if (isFullyPaid) {
        orderUpdates.push('payment_status = "paid"');
        if (!['booking', 'preorder', 'service'].includes(order.order_type)) {
          orderUpdates.push('order_status = "completed"');
        } else if (order.service_status === 'pending') {
          orderUpdates.push('service_status = "confirmed"');
        }
      } else {
        orderUpdates.push('payment_status = "partial"');
      }

      await db.query(
        `UPDATE orders SET ${orderUpdates.join(', ')} WHERE id = ?`,
        [...orderParams, orderId]
      );

      // Increment active shift totals
      if (activeShiftId) {
        try {
          await db.query(
            `UPDATE shifts SET
               total_revenue = total_revenue + ?,
               cash_revenue  = cash_revenue + ?
             WHERE id = ?`,
            [payAmount, payment_method === 'cash' ? payAmount : 0, activeShiftId]
          );
        } catch (_) {}
      }

      await logActivity(
        req.user.id,
        'settle_order_payment',
        orderId,
        { paid_amount: order.paid_amount, remaining_amount: order.remaining_amount },
        { paid_amount: newPaid, remaining_amount: newRemaining, payment_method, amount: payAmount }
      );

      const [[updatedOrder]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      res.json({
        success: true,
        message: isFullyPaid ? 'Pesanan berhasil dilunasi' : `Pembayaran pelunasan sebesar Rp ${payAmount.toLocaleString('id')} berhasil dicatat`,
        order: updatedOrder
      });
    } catch (error) {
      console.error('Settle order payment error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /:id/payments/:paymentId — admin only, hapus riwayat pembayaran
router.delete('/:id/payments/:paymentId',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const orderId = req.params.id;
      const paymentId = req.params.paymentId;

      const [[payment]] = await db.query('SELECT * FROM order_payments WHERE id = ? AND order_id = ?', [paymentId, orderId]);
      if (!payment) return res.status(404).json({ error: 'Payment not found' });

      await db.query('DELETE FROM order_payments WHERE id = ?', [paymentId]);

      // Recalculate
      const [[{ total_paid }]] = await db.query('SELECT SUM(amount) as total_paid FROM order_payments WHERE order_id = ?', [orderId]);
      const [[order]] = await db.query('SELECT total FROM orders WHERE id = ?', [orderId]);
      
      const newPaid = parseFloat(total_paid || 0);
      const newRemaining = Math.max(0, parseFloat((order.total - newPaid).toFixed(2)));
      let paymentStatus = newPaid >= order.total ? 'paid' : (newPaid > 0 ? 'partial' : 'pending');
      
      await db.query(
        'UPDATE orders SET paid_amount = ?, remaining_amount = ?, payment_status = ? WHERE id = ?',
        [newPaid, newRemaining, paymentStatus, orderId]
      );
      
      if (payment.shift_id) {
         try {
           await db.query(
             'UPDATE shifts SET total_revenue = total_revenue - ?, cash_revenue = cash_revenue - ? WHERE id = ?',
             [payment.amount, payment.payment_method === 'cash' ? payment.amount : 0, payment.shift_id]
           );
         } catch (_) {}
      }

      await logActivity(req.user.id, 'delete_order_payment', orderId, { payment_id: paymentId, amount: payment.amount }, {});

      res.json({ success: true, message: 'Riwayat pembayaran berhasil dihapus' });
    } catch (error) {
      console.error('Delete payment error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /:id — admin only, soft delete (set status=cancelled)
router.delete('/:id',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }).withMessage('Invalid order ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const orderId = req.params.id;

      const [orders] = await db.query(
        'SELECT id, order_status, order_number FROM orders WHERE id = ? AND order_status != "deleted"',
        [orderId]
      );

      if (orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = orders[0];

      // Soft delete: set status to cancelled
      await db.query(
        'UPDATE orders SET order_status = "cancelled" WHERE id = ?',
        [orderId]
      );

      await logActivity(
        req.user.id,
        'delete_order',
        orderId,
        { order_status: order.order_status, order_number: order.order_number },
        { order_status: 'cancelled' }
      );

      res.json({ message: 'Order cancelled (soft deleted)' });
    } catch (error) {
      console.error('Delete order error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── Feature: Pindah Meja ─────────────────────────────────────────────────────

// PUT /:id/table — transfer order to a different table
router.put('/:id/table',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  async (req, res) => {
    try {
      const orderId = req.params.id;
      const { table_id } = req.body;

      const [[order]] = await db.query(
        'SELECT id, order_status, table_id FROM orders WHERE id = ? AND order_status NOT IN ("cancelled","completed","deleted")',
        [orderId]
      );
      if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

      let tableNumber = null;
      if (table_id) {
        const [[table]] = await db.query(
          'SELECT id, table_number, name, status FROM tables WHERE id = ?',
          [table_id]
        );
        if (!table) return res.status(404).json({ error: 'Meja tidak ditemukan' });

        // Free old table if occupied by this order only
        if (order.table_id && order.table_id !== table_id) {
          const [[{ cnt }]] = await db.query(
            'SELECT COUNT(*) AS cnt FROM orders WHERE table_id=? AND order_status NOT IN ("cancelled","completed","deleted") AND id!=?',
            [order.table_id, orderId]
          );
          if (cnt === 0) {
            await db.query('UPDATE tables SET status="available" WHERE id=?', [order.table_id]);
          }
        }

        // Mark new table occupied
        await db.query('UPDATE tables SET status="occupied" WHERE id=?', [table_id]);
        tableNumber = table.table_number ?? table.name;
      }

      await db.query(
        'UPDATE orders SET table_id=?, table_number=? WHERE id=?',
        [table_id || null, tableNumber, orderId]
      );

      res.json({ success: true, table_id, table_number: tableNumber });
    } catch (e) {
      console.error('Transfer table error:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── Feature 2: Order Edit API ────────────────────────────────────────────────

// PUT /:id/items — replace all items on a pending order
router.put('/:id/items',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  async (req, res) => {
    try {
      const orderId = req.params.id;
      const { items, discount } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items harus array tidak kosong' });
      }

      const [[order]] = await db.query(
        'SELECT id, order_status, served_by, discount, branch_id FROM orders WHERE id = ? AND order_status != "deleted"',
        [orderId]
      );
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.order_status !== 'pending') {
        return res.status(403).json({ error: 'Order sudah diproses, tidak bisa diedit' });
      }
      // RBAC: kasir only edits orders in their branch
      if (req.user.role === 'kasir' && req.user.branch_id && order.branch_id !== req.user.branch_id) {
        return res.status(403).json({ error: 'Access denied: not your branch' });
      }

      let resolvedItems;
      try {
        resolvedItems = await resolveItems(items);
      } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
      }

      // Replace items
      await db.query('DELETE FROM order_items WHERE order_id = ?', [orderId]);
      await insertOrderItems(orderId, resolvedItems);

      // Recalculate totals
      const subtotal = resolvedItems.reduce((sum, i) => sum + i.subtotal, 0);
      const taxRate = await getTaxRate();
      const discountAmount = discount !== undefined ? parseFloat(discount) : parseFloat(order.discount) || 0;
      const taxAmount = parseFloat(((subtotal - discountAmount) * taxRate / 100).toFixed(2));
      const total = parseFloat((subtotal - discountAmount + taxAmount).toFixed(2));

      await db.query(
        'UPDATE orders SET subtotal=?, tax=?, discount=?, total=? WHERE id=?',
        [subtotal, taxAmount, discountAmount, total, orderId]
      );

      await logActivity(req.user.id, 'edit_order_items', orderId, { order_status: 'pending' }, { subtotal, tax: taxAmount, discount: discountAmount, total });

      const [newItems] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
      const [[updatedOrder]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      res.json({ message: 'Order items updated', order: { ...updatedOrder, items: newItems } });
    } catch (error) {
      console.error('Edit order items error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /:id/add-item — add a single item (pending or preparing)
router.post('/:id/add-item',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  async (req, res) => {
    try {
      const orderId = req.params.id;
      const { product_id, quantity, notes, variants, addons } = req.body;

      if (!product_id || !quantity) {
        return res.status(400).json({ error: 'product_id dan quantity wajib diisi' });
      }

      const [[order]] = await db.query(
        'SELECT id, order_status, subtotal, tax, discount, total FROM orders WHERE id = ? AND order_status != "deleted"',
        [orderId]
      );
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (!['pending', 'preparing'].includes(order.order_status)) {
        return res.status(403).json({ error: 'Order sudah diproses, tidak bisa ditambah item' });
      }

      let resolvedItems;
      try {
        resolvedItems = await resolveItems([{ product_id, quantity, notes, variants, addons }]);
      } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
      }

      await insertOrderItems(orderId, resolvedItems);

      // Recalculate totals
      const [existingItems] = await db.query('SELECT subtotal FROM order_items WHERE order_id = ?', [orderId]);
      const subtotal = existingItems.reduce((sum, i) => sum + parseFloat(i.subtotal), 0);
      const taxRate = await getTaxRate();
      const discountAmount = parseFloat(order.discount) || 0;
      const taxAmount = parseFloat(((subtotal - discountAmount) * taxRate / 100).toFixed(2));
      const total = parseFloat((subtotal - discountAmount + taxAmount).toFixed(2));

      await db.query(
        'UPDATE orders SET subtotal=?, tax=?, discount=?, total=? WHERE id=?',
        [subtotal, taxAmount, discountAmount, total, orderId]
      );

      await logActivity(req.user.id, 'add_order_item', orderId, null, resolvedItems[0]);

      const [allItems] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
      const [[updatedOrder]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      res.json({ message: 'Item ditambahkan', order: { ...updatedOrder, items: allItems } });
    } catch (error) {
      console.error('Add order item error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── Feature 3: Cancel with owner approval ────────────────────────────────────

// Create cancel_requests table at module load
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS order_cancel_requests (
        id INT PRIMARY KEY AUTO_INCREMENT,
        order_id INT NOT NULL,
        requested_by INT,
        reason TEXT,
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        reviewed_by INT,
        reviewed_at TIMESTAMP NULL,
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        INDEX idx_status (status)
      ) ENGINE=InnoDB
    `);
  } catch (e) {
    console.error('order_cancel_requests table init error:', e.message);
  }
})();

// (cancel-requests GET moved above /:id to prevent route conflict)

// POST /:id/cancel-request — request cancellation
router.post('/:id/cancel-request',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  async (req, res) => {
    try {
      const orderId = req.params.id;
      const { reason } = req.body;

      const [[order]] = await db.query(
        'SELECT id, order_status FROM orders WHERE id = ? AND order_status != "deleted"',
        [orderId]
      );
      if (!order) return res.status(404).json({ error: 'Order not found' });

      // Pending orders: cancel directly
      if (order.order_status === 'pending') {
        await db.query('UPDATE orders SET order_status = "cancelled" WHERE id = ?', [orderId]);
        await logActivity(req.user.id, 'cancel_order_direct', orderId, { order_status: 'pending' }, { order_status: 'cancelled', reason });
        return res.json({ message: 'Order dibatalkan', order_status: 'cancelled' });
      }

      if (!['preparing', 'ready'].includes(order.order_status)) {
        return res.status(400).json({ error: `Order dengan status "${order.order_status}" tidak bisa dibatalkan` });
      }

      const [result] = await db.query(
        'INSERT INTO order_cancel_requests (order_id, requested_by, reason) VALUES (?, ?, ?)',
        [orderId, req.user.id, reason || null]
      );
      await logActivity(req.user.id, 'cancel_request_created', orderId, null, { reason, request_id: result.insertId });
      res.json({ message: 'Permintaan pembatalan dikirim', request_id: result.insertId });
    } catch (error) {
      console.error('Cancel request error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// (PUT /cancel-requests/:requestId moved above /:id — see line 305)

// ─── Feature 4: Split Bill ────────────────────────────────────────────────────

// POST /:id/split — calculate and store split bill
router.post('/:id/split',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  async (req, res) => {
    try {
      const orderId = req.params.id;
      const { splits } = req.body;

      if (!Array.isArray(splits) || splits.length === 0) {
        return res.status(400).json({ error: 'splits harus array tidak kosong' });
      }

      const [[order]] = await db.query(
        'SELECT id, subtotal, tax, discount, total FROM orders WHERE id = ? AND order_status != "deleted"',
        [orderId]
      );
      if (!order) return res.status(404).json({ error: 'Order not found' });

      const [allItems] = await db.query(
        'SELECT id, product_name, subtotal FROM order_items WHERE order_id = ?',
        [orderId]
      );

      const itemMap = {};
      allItems.forEach(i => { itemMap[i.id] = i; });

      const orderSubtotal = parseFloat(order.subtotal) || 0;
      const orderTax = parseFloat(order.tax) || 0;
      const orderDiscount = parseFloat(order.discount) || 0;
      const orderTotal = parseFloat(order.total) || 0;

      const result = splits.map(split => {
        const splitItems = (split.item_ids || []).map(id => itemMap[id]).filter(Boolean);
        const splitSubtotal = splitItems.reduce((sum, i) => sum + parseFloat(i.subtotal), 0);
        const ratio = orderSubtotal > 0 ? splitSubtotal / orderSubtotal : 0;
        const splitDiscount = parseFloat((orderDiscount * ratio).toFixed(2));
        const splitTax = parseFloat((orderTax * ratio).toFixed(2));
        const extraAmount = parseFloat(split.extra_amount) || 0;
        const splitTotal = parseFloat((splitSubtotal - splitDiscount + splitTax + extraAmount).toFixed(2));

        return {
          name: split.name || '',
          items: splitItems.map(i => ({ id: i.id, product_name: i.product_name, subtotal: parseFloat(i.subtotal) })),
          subtotal: splitSubtotal,
          tax: splitTax,
          discount: splitDiscount,
          extra_amount: extraAmount,
          total: splitTotal,
        };
      });

      // Store in meta_data
      const [[currentOrder]] = await db.query('SELECT meta_data FROM orders WHERE id = ?', [orderId]);
      let meta = {};
      try { meta = JSON.parse(currentOrder.meta_data || '{}'); } catch (_) {}
      meta.split_bill = { splits: result, calculated_at: new Date().toISOString() };
      await db.query('UPDATE orders SET meta_data = ? WHERE id = ?', [JSON.stringify(meta), orderId]);

      res.json({ splits: result });
    } catch (error) {
      console.error('Split bill error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /:id/split — retrieve saved split
router.get('/:id/split',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  async (req, res) => {
    try {
      const [[order]] = await db.query(
        'SELECT id, meta_data FROM orders WHERE id = ? AND order_status != "deleted"',
        [req.params.id]
      );
      if (!order) return res.status(404).json({ error: 'Order not found' });

      let meta = {};
      try { meta = JSON.parse(order.meta_data || '{}'); } catch (_) {}

      if (!meta.split_bill) {
        return res.status(404).json({ error: 'Split bill belum dibuat untuk order ini' });
      }

      res.json(meta.split_bill);
    } catch (error) {
      console.error('Get split bill error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /:id/claim-points — kasir klaim poin untuk member setelah transaksi
router.post('/:id/claim-points',
  authenticate,
  authorize('admin', 'kasir'),
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      // Cek points_enabled
      const [[pEnabled]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='points_enabled'");
      if (!pEnabled || pEnabled.setting_value !== 'true') {
        return res.status(400).json({ error: 'Fitur poin tidak aktif. Aktifkan di Pengaturan.' });
      }

      const [[order]] = await db.query(
        'SELECT id, order_number, total, branch_id, order_status, customer_email, payment_status FROM orders WHERE id = ?',
        [req.params.id]
      );
      if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
      if (order.order_status === 'cancelled') return res.status(400).json({ error: 'Order sudah dibatalkan' });
      if (!order.customer_email) return res.status(400).json({ error: 'Order tidak terhubung ke member (tidak ada email pelanggan)' });

      // Cari member berdasarkan email
      const [[member]] = await db.query(
        "SELECT id, name, email, points, role FROM users WHERE email = ? AND role = 'member' AND status = 'active'",
        [order.customer_email]
      );
      if (!member) return res.status(404).json({ error: 'Member tidak ditemukan untuk email order ini' });

      // Cek apakah poin untuk order ini sudah pernah diklaim
      const [[existing]] = await db.query(
        "SELECT id FROM point_transactions WHERE order_id = ? AND type = 'earn'",
        [order.id]
      );
      if (existing) return res.status(409).json({ error: 'Poin untuk order ini sudah diklaim sebelumnya' });

      // Ambil rule poin: cek branch rule dulu, fallback ke global setting
      let pointsPerAmount = 0;
      let multiplier = 1;
      let ruleName = 'Global';

      if (order.branch_id) {
        const [branchRules] = await db.query(
          'SELECT * FROM branch_point_rules WHERE branch_id = ? AND is_active = 1 AND min_transaction <= ? ORDER BY min_transaction DESC LIMIT 1',
          [order.branch_id, order.total]
        );
        if (branchRules.length > 0) {
          pointsPerAmount = parseFloat(branchRules[0].points_per_amount);
          multiplier = parseFloat(branchRules[0].multiplier);
          ruleName = branchRules[0].name;
        }
      }

      // Fallback ke global setting jika tidak ada branch rule
      if (pointsPerAmount === 0) {
        const [[globalRate]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='points_per_amount'");
        pointsPerAmount = parseFloat(globalRate?.setting_value || 1);
      }

      // Hitung poin: floor(total * points_per_amount * multiplier)
      const earnedPoints = Math.floor(parseFloat(order.total) * pointsPerAmount * multiplier);
      if (earnedPoints <= 0) return res.status(400).json({ error: 'Poin yang diperoleh adalah 0. Periksa konfigurasi rule poin.' });

      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const pointsBefore = parseInt(member.points || 0);
        const pointsAfter = pointsBefore + earnedPoints;

        await conn.query('UPDATE users SET points = ? WHERE id = ?', [pointsAfter, member.id]);
        await conn.query(
          `INSERT INTO point_transactions (user_id, order_id, branch_id, type, points, points_before, points_after, note, created_by)
           VALUES (?, ?, ?, 'earn', ?, ?, ?, ?, ?)`,
          [member.id, order.id, order.branch_id, earnedPoints, pointsBefore, pointsAfter,
           `Klaim poin dari order ${order.order_number} (rule: ${ruleName})`, req.user.id]
        );
        await conn.commit();

        res.json({
          message: `${earnedPoints} poin berhasil diklaim untuk ${member.name}`,
          member: { id: member.id, name: member.name, points_before: pointsBefore, points_after: pointsAfter },
          earned_points: earnedPoints,
          order_number: order.order_number,
          rule: ruleName,
        });
      } catch (e) { await conn.rollback(); throw e; }
      finally { conn.release(); }
    } catch (error) {
      console.error('Claim points error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /:id/points-preview — preview berapa poin yang akan didapat
router.get('/:id/points-preview',
  authenticate,
  authorize('admin', 'kasir'),
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const [[pEnabled]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='points_enabled'");
      if (!pEnabled || pEnabled.setting_value !== 'true') {
        return res.json({ enabled: false, points: 0 });
      }

      const [[order]] = await db.query('SELECT id, total, branch_id, customer_email FROM orders WHERE id = ?', [req.params.id]);
      if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

      // Cek sudah diklaim
      const [[existing]] = await db.query("SELECT id FROM point_transactions WHERE order_id = ? AND type = 'earn'", [order.id]);
      if (existing) return res.json({ enabled: true, points: 0, already_claimed: true });

      let pointsPerAmount = 0, multiplier = 1, ruleName = 'Global';
      if (order.branch_id) {
        const [branchRules] = await db.query(
          'SELECT * FROM branch_point_rules WHERE branch_id = ? AND is_active = 1 AND min_transaction <= ? ORDER BY min_transaction DESC LIMIT 1',
          [order.branch_id, order.total]
        );
        if (branchRules.length > 0) {
          pointsPerAmount = parseFloat(branchRules[0].points_per_amount);
          multiplier = parseFloat(branchRules[0].multiplier);
          ruleName = branchRules[0].name;
        }
      }
      if (pointsPerAmount === 0) {
        const [[globalRate]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='points_per_amount'");
        pointsPerAmount = parseFloat(globalRate?.setting_value || 1);
      }

      const points = Math.floor(parseFloat(order.total) * pointsPerAmount * multiplier);
      res.json({ enabled: true, points, rule: ruleName, already_claimed: false });
    } catch (error) {
      console.error('Points preview error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /:id/payment-proof — upload bukti pembayaran
router.post('/:id/payment-proof',
  authenticate,
  (req, res, next) => getProofUpload().single('proof')(req, res, next),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!req.file) return res.status(400).json({ error: 'File wajib diupload' });

      const [[order]] = await db.query('SELECT id FROM orders WHERE id = ?', [id]);
      if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

      const ext = req.file.mimetype === 'image/png' ? '.png' : '.jpg';
      const filename = `proof_${id}_${uuidv4()}${ext}`;

      const storageService = require('../services/StorageService');
      let saved;
      try {
        saved = await storageService.save(filename, req.file.buffer, req.file.mimetype);
      } catch (e) {
        saved = await storageService.saveLocal(filename, req.file.buffer);
      }

      await db.query(
        'UPDATE orders SET payment_proof_url = ?, payment_proof_storage = ? WHERE id = ?',
        [saved.url, saved.storage_type, id]
      );

      res.json({ proof_url: saved.url, storage_type: saved.storage_type });
    } catch (e) {
      console.error('payment-proof error:', e);
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
