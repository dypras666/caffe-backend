const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');

// Helper: log activity
const logActivity = async (userId, action, recordId, oldValues, newValues) => {
  await db.query(
    'INSERT INTO activity_logs (user_id, action, table_name, record_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)',
    [
      userId,
      action,
      'users',
      recordId || null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ]
  );
};

// GET / — admin, with pagination
router.get('/',
  authenticate,
  authorize('admin'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('role').optional().isIn(['admin', 'kasir', 'waiter', 'member']),
    query('status').optional().isIn(['active', 'inactive']),
    query('search').optional().trim(),
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
      const { role, status, search, branch_id } = req.query;

      let baseQuery = 'FROM users u LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN stations s ON s.id = u.station_id WHERE 1=1';
      const params = [];

      if (role) {
        baseQuery += ' AND u.role = ?';
        params.push(role);
      }

      if (status) {
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
        baseQuery += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);

      const [users] = await db.query(
        `SELECT u.id, u.name, u.email, u.role, u.status, u.avatar, u.phone,
                u.balance, u.is_priority, u.branch_id, b.name AS branch_name,
                u.station_id, s.name AS station_name,
                u.created_at, u.updated_at
         ${baseQuery} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      res.json({
        users,
        pagination: {
          total,
          page,
          limit,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /search-member — kasir/waiter/admin can search members for POS
router.get('/search-member', authenticate, authorize('admin', 'kasir', 'waiter'), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ users: [] });

    const keyword = `%${q.trim()}%`;
    const [users] = await db.query(
      `SELECT id, name, email, phone, balance, is_priority, status
       FROM users
       WHERE role = 'member' AND status = 'active'
         AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)
       ORDER BY name LIMIT 10`,
      [keyword, keyword, keyword]
    );
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /register-quick — kasir/waiter bisa daftarkan member baru langsung dari POS
router.post('/register-quick', authenticate, authorize('admin', 'kasir', 'waiter'), async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { name, email, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name dan phone wajib' });

  try {
    // Check if phone already registered
    const [existing] = await db.query(
      'SELECT id, name, email, phone, balance, is_priority FROM users WHERE phone = ? AND role = "member"',
      [phone]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Nomor HP sudah terdaftar', user: existing[0] });
    }

    // If email provided, check duplicate
    if (email) {
      const [emailCheck] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (emailCheck.length > 0) return res.status(409).json({ error: 'Email sudah terdaftar' });
    }

    // Auto-generate password from phone last 6 digits
    const autoPass = phone.slice(-6);
    const hashed = await bcrypt.hash(autoPass, 10);
    const finalEmail = email || `${phone.replace(/\D/g, '')}@member.cafeazzura.com`;

    const [r] = await db.query(
      'INSERT INTO users (name, email, phone, password, role, status) VALUES (?,?,?,?,?,?)',
      [name, finalEmail, phone, hashed, 'member', 'active']
    );

    const [[user]] = await db.query(
      'SELECT id, name, email, phone, balance, is_priority FROM users WHERE id = ?',
      [r.insertId]
    );

    await db.query(
      'INSERT INTO activity_logs (user_id, action, table_name, record_id, new_values) VALUES (?,?,?,?,?)',
      [req.user.id, 'quick_register_member', 'users', r.insertId, JSON.stringify({ name, phone, by: req.user.id })]
    );

    res.status(201).json({ user, auto_password: autoPass, message: 'Member berhasil didaftarkan' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /me/activity — own activity logs (must be before /:id)
router.get('/me/activity', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM activity_logs WHERE user_id = ?',
      [req.user.id]
    );

    const [logs] = await db.query(
      `SELECT id, action, table_name, record_id, created_at
       FROM activity_logs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    res.json({
      logs,
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id — admin
router.get('/:id',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }).withMessage('Invalid user ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const [users] = await db.query(
        'SELECT id, name, email, role, status, avatar, phone, balance, is_priority, created_at, updated_at FROM users WHERE id = ?',
        [req.params.id]
      );

      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Recent activity for this user
      const [recentActivity] = await db.query(
        'SELECT action, table_name, record_id, created_at FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
        [req.params.id]
      );

      res.json({ user: users[0], recent_activity: recentActivity });
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id — admin, update name/phone/role/status/avatar
router.put('/:id',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid user ID'),
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('phone').optional({ nullable: true }).trim(),
    body('role').optional().isIn(['admin', 'kasir', 'waiter', 'member']).withMessage('role must be admin, kasir, waiter, or member'),
    body('status').optional().isIn(['active', 'inactive']).withMessage('status must be active or inactive'),
    body('avatar').optional({ nullable: true }).trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.params.id;

      const [existing] = await db.query(
        'SELECT id, name, email, role, status, avatar, phone FROM users WHERE id = ?',
        [userId]
      );

      if (existing.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const old = existing[0];
      const allowedFields = ['name', 'phone', 'role', 'status', 'avatar', 'is_priority', 'branch_id', 'station_id'];
      const updates = [];
      const values = [];

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field] === '' ? null : req.body[field]);
        }
      }

      // Handle password change separately (needs bcrypt hash)
      if (req.body.password && req.body.password.length >= 6) {
        const bcrypt = require('bcryptjs');
        const hashed = await bcrypt.hash(req.body.password, 10);
        updates.push('password = ?');
        values.push(hashed);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      values.push(userId);
      await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

      await logActivity(req.user.id, 'update_user', userId, old, req.body);

      res.json({ message: 'User updated successfully' });
    } catch (error) {
      console.error('Update user error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /:id — admin, can't delete self
router.delete('/:id',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }).withMessage('Invalid user ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.params.id;

      if (Number(userId) === Number(req.user.id)) {
        return res.status(400).json({ error: 'You cannot delete your own account' });
      }

      const [existing] = await db.query(
        'SELECT id, name, email, role FROM users WHERE id = ?',
        [userId]
      );

      if (existing.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      await db.query('DELETE FROM users WHERE id = ?', [userId]);

      await logActivity(req.user.id, 'delete_user', userId, existing[0], null);

      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
