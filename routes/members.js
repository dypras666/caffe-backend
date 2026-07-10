const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');

// Helper: get system setting with optional default
const getSetting = async (key, defaultValue = null) => {
  const [rows] = await db.query(
    'SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1',
    [key]
  );
  return rows.length > 0 ? rows[0].setting_value : defaultValue;
};

// Helper: log activity
const logActivity = async (userId, action, tableName, recordId, oldValues, newValues) => {
  await db.query(
    'INSERT INTO activity_logs (user_id, action, table_name, record_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)',
    [
      userId,
      action,
      tableName,
      recordId || null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ]
  );
};

// ── Member self-service endpoints ──

// GET /profile — own profile with stats (any authenticated role)
router.get('/profile',
  authenticate,
  async (req, res) => {
    try {
      const [[user]] = await db.query(
        `SELECT id, name, email, phone, role, balance, is_priority,
                member_number, member_since, total_orders, total_spent, points
         FROM users WHERE id = ? AND status = 'active'`,
        [req.user.id]
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ user });
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /qr — generate QR data for member card
router.get('/qr',
  authenticate,
  async (req, res) => {
    try {
      const [[user]] = await db.query(
        'SELECT id, name, member_number FROM users WHERE id = ? AND status = "active"',
        [req.user.id]
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!user.member_number) {
        return res.status(400).json({ error: 'No member number assigned to this account' });
      }

      const baseUrl = await getSetting('member_qr_base_url', 'http://localhost:5174');
      const qr_url = `${baseUrl}/member?m=${user.member_number}`;

      res.json({ qr_url, member_number: user.member_number, name: user.name });
    } catch (error) {
      console.error('Get QR error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /search — kasir/admin/waiter search member by name/email/phone/member_number
router.get('/search',
  authenticate,
  authorize('admin', 'kasir', 'waiter'),
  [query('q').optional().trim()],
  async (req, res) => {
    try {
      const q = req.query.q || '';
      const search = `%${q}%`;
      const [members] = await db.query(
        `SELECT id, name, email, phone, member_number, balance, is_priority, total_orders
         FROM users
         WHERE role = 'member' AND status = 'active'
           AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR member_number LIKE ?)
         ORDER BY name ASC
         LIMIT 20`,
        [search, search, search, search]
      );
      res.json({ members });
    } catch (error) {
      console.error('Search members error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /topup-requests — own topup request history (any authenticated user)
router.get('/topup-requests',
  authenticate,
  async (req, res) => {
    try {
      const [requests] = await db.query(
        `SELECT tr.*, u.name AS approved_by_name
         FROM topup_requests tr
         LEFT JOIN users u ON u.id = tr.approved_by
         WHERE tr.user_id = ?
         ORDER BY tr.created_at DESC`,
        [req.user.id]
      );
      res.json({ requests });
    } catch (error) {
      console.error('Get topup requests error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /topup-requests/pending — admin list pending topup requests
// NOTE: must be defined before PUT /topup-requests/:id to avoid param capture on GET
router.get('/topup-requests/pending',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const [requests] = await db.query(
        `SELECT tr.*, u.name AS user_name, u.email AS user_email, u.member_number
         FROM topup_requests tr
         JOIN users u ON u.id = tr.user_id
         WHERE tr.status = 'pending'
         ORDER BY tr.created_at ASC`
      );
      res.json({ requests });
    } catch (error) {
      console.error('Get pending topup requests error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /orders — own order history
router.get('/orders',
  authenticate,
  async (req, res) => {
    try {
      const [orders] = await db.query(
        `SELECT o.id, o.order_number, o.customer_name, o.customer_email, o.order_type,
                o.subtotal, o.tax, o.discount, o.total, o.payment_method, o.payment_status,
                o.order_status, o.notes, o.table_number, o.branch_id, b.name AS branch_name,
                o.created_at
         FROM orders o
         LEFT JOIN branches b ON b.id = o.branch_id
         WHERE (o.customer_email = ? OR o.served_by = ?) AND o.order_status != 'deleted'
         ORDER BY o.created_at DESC`,
        [req.user.email, req.user.id]
      );
      res.json({ orders });
    } catch (error) {
      console.error('Get member orders error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /topup-request — member submits a topup request
router.post('/topup-request',
  authenticate,
  sanitizeInput,
  [
    body('amount').isFloat({ min: 1 }).withMessage('Jumlah harus lebih dari 0'),
    body('payment_method').notEmpty().withMessage('Pilih metode pembayaran'),
    body('reference').optional().trim(),
    body('note').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // Check topup feature toggle
      const topupEnabled = await getSetting('topup_enabled', 'true');
      if (topupEnabled !== 'true') {
        return res.status(400).json({ error: 'Topup is currently disabled' });
      }

      const { amount, payment_method, reference, note } = req.body;
      const minAmount = parseFloat(await getSetting('topup_min_amount', '10000'));

      if (parseFloat(amount) < minAmount) {
        return res.status(400).json({ error: `Minimum topup amount is ${minAmount}` });
      }

      const [result] = await db.query(
        `INSERT INTO topup_requests (user_id, amount, payment_method, reference, note, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [req.user.id, amount, payment_method, reference || null, note || null]
      );

      res.status(201).json({
        message: 'Topup request submitted successfully',
        request_id: result.insertId,
      });
    } catch (error) {
      console.error('Topup request error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /check-priority — admin check if a member qualifies for auto-priority
router.post('/check-priority',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [body('user_id').isInt({ min: 1 }).withMessage('Invalid user_id')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { user_id } = req.body;

      const [[user]] = await db.query(
        'SELECT id, name, total_orders, total_spent, is_priority FROM users WHERE id = ? AND status = "active"',
        [user_id]
      );
      if (!user) return res.status(404).json({ error: 'User not found' });

      const minOrders = parseInt(await getSetting('priority_min_orders', '10'));
      const minSpent = parseFloat(await getSetting('priority_min_spent', '500000'));

      const qualifies =
        parseInt(user.total_orders) >= minOrders &&
        parseFloat(user.total_spent) >= minSpent;

      if (qualifies && !user.is_priority) {
        await db.query('UPDATE users SET is_priority = 1 WHERE id = ?', [user_id]);
        await logActivity(req.user.id, 'auto_set_priority', 'users', user_id,
          { is_priority: 0 }, { is_priority: 1 });
        return res.json({
          message: 'Member automatically promoted to priority',
          is_priority: true,
          qualifies: true,
        });
      }

      res.json({
        message: 'Priority check complete',
        qualifies,
        is_priority: !!user.is_priority,
      });
    } catch (error) {
      console.error('Check priority error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── Admin endpoints ──

// GET / — admin list all members with stats; filter ?status=priority|active|inactive&search=
router.get('/',
  authenticate,
  authorize('admin'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['priority', 'active', 'inactive']),
    query('search').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;
      const { status, search, branch_id } = req.query;

      let baseQuery = "FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.role = 'member'";
      const params = [];

      if (status === 'priority') {
        baseQuery += ' AND u.is_priority = 1';
      } else if (status === 'regular') {
        baseQuery += ' AND u.is_priority = 0';
      } else if (status === 'active' || status === 'inactive') {
        baseQuery += ' AND u.status = ?';
        params.push(status);
      }

      if (branch_id === 'none') {
        baseQuery += ' AND u.branch_id IS NULL';
      } else if (branch_id) {
        baseQuery += ' AND u.branch_id = ?';
        params.push(branch_id);
      }

      if (search) {
        baseQuery += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.member_number LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      }

      const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);

      // Summary aggregates (untuk display di summary cards)
      const [[summary]] = await db.query(
        `SELECT
           COUNT(*) AS total_members,
           SUM(u.is_priority) AS priority_members,
           COALESCE(SUM(u.balance), 0) AS total_balance,
           (SELECT COUNT(*) FROM topup_requests WHERE status='pending') AS pending_topup
         ${baseQuery}`,
        params
      );

      const [members] = await db.query(
        `SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.balance, u.is_priority,
                u.member_number, u.member_since, u.total_orders, u.total_spent, u.points,
                u.branch_id, b.name AS branch_name, u.created_at
         ${baseQuery} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      res.json({
        members,
        summary,
        pagination: {
          total,
          page,
          limit,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('List members error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /:id/orders — admin view member's orders (more specific, must come before /:id)
router.get('/:id/orders',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;
      const [[member]] = await db.query('SELECT id, email FROM users WHERE id = ? AND role = ?', [req.params.id, 'member']);
      if (!member) return res.status(404).json({ error: 'Member tidak ditemukan' });
      const [[{ total }]] = await db.query(
        'SELECT COUNT(*) AS total FROM orders WHERE customer_email = ? AND order_status != ?',
        [member.email, 'deleted']
      );
      const [orders] = await db.query(
        `SELECT id, order_number, order_type, order_status, payment_status, total, created_at
         FROM orders WHERE customer_email = ? AND order_status != ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [member.email, 'deleted', limit, offset]
      );
      res.json({ orders, pagination: { total, page, limit, total_pages: Math.ceil(total / limit) } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// GET /:id — admin view single member
router.get('/:id',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const [[member]] = await db.query(
        `SELECT id, name, email, phone, role, status, balance, is_priority,
                member_number, member_since, total_orders, total_spent, created_at
         FROM users WHERE id = ? AND role = 'member'`,
        [req.params.id]
      );
      if (!member) return res.status(404).json({ error: 'Member tidak ditemukan' });
      res.json({ member });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// PUT /topup-requests/:id — admin approve or reject a topup request
router.put('/topup-requests/:id',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid topup request ID'),
    body('status').isIn(['approved', 'rejected']).withMessage('Status must be "approved" or "rejected"'),
    body('note').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const requestId = req.params.id;
      const { status, note } = req.body;

      const [[topup]] = await db.query(
        'SELECT * FROM topup_requests WHERE id = ?',
        [requestId]
      );
      if (!topup) return res.status(404).json({ error: 'Topup request not found' });
      if (topup.status !== 'pending') {
        return res.status(400).json({ error: 'This request has already been processed' });
      }

      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        await conn.query(
          `UPDATE topup_requests
           SET status = ?, approved_by = ?, approved_at = NOW(), note = COALESCE(?, note)
           WHERE id = ?`,
          [status, req.user.id, note || null, requestId]
        );

        if (status === 'approved') {
          const [[user]] = await conn.query(
            'SELECT id, balance FROM users WHERE id = ?',
            [topup.user_id]
          );
          const balBefore = parseFloat(user.balance);
          const balAfter = parseFloat((balBefore + parseFloat(topup.amount)).toFixed(2));

          await conn.query('UPDATE users SET balance = ? WHERE id = ?', [balAfter, topup.user_id]);

          await conn.query(
            `INSERT INTO balance_transactions
               (user_id, type, amount, balance_before, balance_after, reference_type, note, created_by)
             VALUES (?, 'topup', ?, ?, ?, 'topup_request', ?, ?)`,
            [
              topup.user_id,
              topup.amount,
              balBefore,
              balAfter,
              `Topup approved - ref: ${topup.reference || requestId}`,
              req.user.id,
            ]
          );
        }

        await conn.commit();

        await logActivity(
          req.user.id, `topup_${status}`, 'topup_requests', requestId,
          { status: 'pending' }, { status, approved_by: req.user.id }
        );

        res.json({ message: `Topup request ${status}` });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error('Process topup request error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id/priority — admin set or unset priority status
router.put('/:id/priority',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid user ID'),
    body('is_priority').isBoolean().withMessage('is_priority must be a boolean'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.params.id;
      const is_priority = req.body.is_priority ? 1 : 0;

      const [[user]] = await db.query(
        'SELECT id, is_priority FROM users WHERE id = ?',
        [userId]
      );
      if (!user) return res.status(404).json({ error: 'User not found' });

      await db.query('UPDATE users SET is_priority = ? WHERE id = ?', [is_priority, userId]);

      await logActivity(
        req.user.id, 'set_priority', 'users', userId,
        { is_priority: user.is_priority }, { is_priority }
      );

      res.json({ message: 'Priority status updated', is_priority: !!is_priority });
    } catch (error) {
      console.error('Set priority error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id/balance — admin adjust member balance directly
router.put('/:id/balance',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid user ID'),
    body('amount').isFloat({ min: 0 }).withMessage('Amount must be a non-negative number'),
    body('type').isIn(['topup', 'deduct', 'adjustment']).withMessage('type must be topup, deduct, or adjustment'),
    body('note').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.params.id;
      const { amount, type, note } = req.body;

      const [[user]] = await db.query(
        'SELECT id, name, balance FROM users WHERE id = ?',
        [userId]
      );
      if (!user) return res.status(404).json({ error: 'User not found' });

      const balBefore = parseFloat(user.balance);
      let balAfter;

      if (type === 'topup' || type === 'adjustment') {
        balAfter = parseFloat((balBefore + parseFloat(amount)).toFixed(2));
      } else {
        // deduct
        balAfter = parseFloat((balBefore - parseFloat(amount)).toFixed(2));
        if (balAfter < 0) {
          return res.status(400).json({ error: 'Insufficient balance for this deduction' });
        }
      }

      await db.query('UPDATE users SET balance = ? WHERE id = ?', [balAfter, userId]);

      await db.query(
        `INSERT INTO balance_transactions
           (user_id, type, amount, balance_before, balance_after, reference_type, note, created_by)
         VALUES (?, ?, ?, ?, ?, 'admin_adjustment', ?, ?)`,
        [userId, type, amount, balBefore, balAfter, note || null, req.user.id]
      );

      await logActivity(
        req.user.id, 'adjust_balance', 'users', userId,
        { balance: balBefore }, { balance: balAfter, type, amount }
      );

      res.json({
        message: 'Balance adjusted successfully',
        balance_before: balBefore,
        balance_after: balAfter,
      });
    } catch (error) {
      console.error('Adjust balance error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
