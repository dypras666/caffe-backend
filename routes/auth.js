const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { authLimiter, sanitizeInput } = require('../middleware/security');
const { authenticate } = require('../middleware/auth');

// Generate JWT Token
const generateToken = (user) => {
  return jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );
};

// Register Member (public — self-registration)
router.post('/register/member',
  authLimiter,
  sanitizeInput,
  [
    body('name').trim().notEmpty().withMessage('Nama wajib diisi'),
    body('email').isEmail().withMessage('Email tidak valid'),
    body('password').isLength({ min: 6 }).withMessage('Password minimal 6 karakter'),
    body('phone').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      // Check member_registration setting
      const [[setting]] = await db.query(
        'SELECT setting_value FROM system_settings WHERE setting_key = "member_registration"'
      );
      if (setting && setting.setting_value === 'false') {
        return res.status(403).json({ error: 'Pendaftaran member sedang ditutup' });
      }

      const { name, email, password, phone } = req.body;
      const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing.length > 0) return res.status(409).json({ error: 'Email sudah terdaftar' });

      const hashed = await bcrypt.hash(password, 10);
      const [result] = await db.query(
        'INSERT INTO users (name, email, password, role, phone, status) VALUES (?, ?, ?, "member", ?, "active")',
        [name, email, hashed, phone || null]
      );

      const token = generateToken({ id: result.insertId, role: 'member' });
      res.status(201).json({
        message: 'Registrasi berhasil',
        token,
        user: { id: result.insertId, name, email, role: 'member', balance: 0 }
      });
    } catch (err) {
      console.error('Member register error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Register Staff (Admin only)
router.post('/register',
  authenticate,
  sanitizeInput,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['admin', 'kasir', 'waiter']).withMessage('Invalid role'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can create users' });
      }

      const { name, email, password, role, phone, branch_id, station_id } = req.body;

      const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing.length > 0) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const [result] = await db.query(
        'INSERT INTO users (name, email, password, role, phone, branch_id, station_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [name, email, hashedPassword, role, phone || null, branch_id || null, station_id || null]
      );
      const newUserId = result.insertId;

      await db.query(
        'INSERT INTO activity_logs (user_id, action, table_name, record_id, new_values) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, 'create_user', 'users', newUserId, JSON.stringify({ name, email, role })]
      );

      // Auto-create employee record for non-admin staff if HR module is enabled
      if (['kasir', 'waiter'].includes(role)) {
        try {
          const [[hrSetting]] = await db.query(
            "SELECT setting_value FROM system_settings WHERE setting_key = 'hr_enabled'"
          );
          if (hrSetting?.setting_value === 'true') {
            const [[existing]] = await db.query(
              'SELECT id FROM employees WHERE user_id = ?', [newUserId]
            );
            if (!existing) {
              const code = `EMP-${newUserId.toString().padStart(5, '0')}`;
              await db.query(
                `INSERT INTO employees (user_id, employee_code, full_name, phone, branch_id, status)
                 VALUES (?, ?, ?, ?, ?, 'active')`,
                [newUserId, code, name, phone || null, branch_id || null]
              );
            }
          }
        } catch (_) { /* HR module optional — silently skip */ }
      }

      res.status(201).json({
        message: 'User created successfully',
        user: { id: newUserId, name, email, role }
      });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Login
router.post('/login',
  authLimiter,
  sanitizeInput,
  [
    body('email').notEmpty().withMessage('Email atau nomor HP wajib diisi'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email: identifier, password } = req.body;

      // Support login dengan email ATAU nomor HP
      const [users] = await db.query(
        `SELECT id, name, email, password, role, status, avatar, balance, is_priority, phone
         FROM users WHERE email = ? OR phone = ?`,
        [identifier, identifier]
      );

      if (users.length === 0) {
        return res.status(401).json({ error: 'Email/HP atau password salah' });
      }

      const user = users[0];

      // Check if user is active
      if (user.status !== 'active') {
        return res.status(403).json({ error: 'Account is inactive' });
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Email/HP atau password salah' });
      }

      // Generate token
      const token = generateToken(user);

      // Log activity
      await db.query(
        'INSERT INTO activity_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
        [user.id, 'login', req.ip, req.headers['user-agent']]
      );

      res.json({
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: user.avatar,
          balance: parseFloat(user.balance || 0),
          is_priority: !!user.is_priority,
          phone: user.phone,
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Get current user
router.get('/me', authenticate, async (req, res) => {
  let user = { ...req.user };
  if (user.station_id) {
    const [[station]] = await db.query('SELECT code, name FROM stations WHERE id = ?', [user.station_id]);
    if (station) {
      user.station = station;
    }
  }
  res.json({ user });
});

// Change password
router.post('/change-password',
  authenticate,
  sanitizeInput,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { currentPassword, newPassword } = req.body;

      // Get user with password
      const [users] = await db.query(
        'SELECT password FROM users WHERE id = ?',
        [req.user.id]
      );

      // Verify current password
      const isValid = await bcrypt.compare(currentPassword, users[0].password);
      if (!isValid) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password
      await db.query(
        'UPDATE users SET password = ? WHERE id = ?',
        [hashedPassword, req.user.id]
      );

      // Log activity
      await db.query(
        'INSERT INTO activity_logs (user_id, action) VALUES (?, ?)',
        [req.user.id, 'change_password']
      );

      res.json({ message: 'Password changed successfully' });
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    // Log activity
    await db.query(
      'INSERT INTO activity_logs (user_id, action) VALUES (?, ?)',
      [req.user.id, 'logout']
    );

    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
