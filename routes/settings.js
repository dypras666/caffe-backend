const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
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
      'system_settings',
      recordId || null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ]
  );
};

// GET /api/settings — public returns is_public settings; admin returns all
router.get('/', async (req, res) => {
  try {
    // Peek at auth header without hard-failing
    let isAdmin = false;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const jwt = require('jsonwebtoken');
        const token = authHeader.replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [users] = await db.query(
          'SELECT role FROM users WHERE id = ? AND status = "active"',
          [decoded.userId]
        );
        if (users.length > 0 && users[0].role === 'admin') {
          isAdmin = true;
        }
      } catch (_) {
        // ignore invalid token — treat as public
      }
    }

    let query = 'SELECT id, setting_key, setting_value, setting_type, setting_group, label, description, is_public FROM system_settings';
    const params = [];

    if (!isAdmin) {
      query += ' WHERE is_public = 1';
    }

    query += ' ORDER BY setting_group, setting_key';

    const [settings] = await db.query(query, params);

    // Parse JSON-typed values
    const parsed = settings.map((s) => ({
      ...s,
      setting_value: s.setting_type === 'json' ? (() => { try { return JSON.parse(s.setting_value); } catch (_) { return s.setting_value; } })() : s.setting_value,
    }));

    res.json({ settings: parsed, count: parsed.length });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/settings/:key
router.get('/:key',
  param('key').trim().notEmpty(),
  async (req, res) => {
    try {
      const [rows] = await db.query(
        'SELECT id, setting_key, setting_value, setting_type, setting_group, label, description, is_public FROM system_settings WHERE setting_key = ?',
        [req.params.key]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Setting not found' });
      }

      const setting = rows[0];

      // Non-public settings require auth
      if (!setting.is_public) {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(403).json({ error: 'This setting is not public' });
        }
        try {
          const jwt = require('jsonwebtoken');
          const token = authHeader.replace('Bearer ', '');
          jwt.verify(token, process.env.JWT_SECRET);
        } catch (_) {
          return res.status(401).json({ error: 'Invalid token' });
        }
      }

      if (setting.setting_type === 'json') {
        try { setting.setting_value = JSON.parse(setting.setting_value); } catch (_) {}
      }

      res.json({ setting });
    } catch (error) {
      console.error('Get setting error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /api/settings — admin, accepts array of {key, value}
router.put('/',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    body('settings').isArray({ min: 1 }).withMessage('settings must be a non-empty array'),
    body('settings.*.key').trim().notEmpty().withMessage('Each setting must have a key'),
    body('settings.*.value').exists().withMessage('Each setting must have a value'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { settings } = req.body;
      const updated = [];
      const notFound = [];

      for (const item of settings) {
        const [existing] = await db.query(
          'SELECT id, setting_key, setting_value, setting_type FROM system_settings WHERE setting_key = ?',
          [item.key]
        );

        if (existing.length === 0) {
          notFound.push(item.key);
          continue;
        }

        const row = existing[0];
        const oldValue = row.setting_value;
        const newValue = typeof item.value === 'object' ? JSON.stringify(item.value) : String(item.value);

        await db.query(
          'UPDATE system_settings SET setting_value = ? WHERE setting_key = ?',
          [newValue, item.key]
        );

        await logActivity(
          req.user.id,
          'update_setting',
          row.id,
          { key: item.key, value: oldValue },
          { key: item.key, value: newValue }
        );

        updated.push(item.key);
      }

      res.json({
        message: 'Settings updated',
        updated,
        not_found: notFound,
      });
    } catch (error) {
      console.error('Update settings error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/settings — admin, create new setting
router.post('/',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    body('setting_key').trim().notEmpty().withMessage('setting_key is required'),
    body('setting_value').exists().withMessage('setting_value is required'),
    body('setting_type')
      .isIn(['text', 'number', 'boolean', 'json', 'image', 'color'])
      .withMessage('setting_type must be one of: text, number, boolean, json, image, color'),
    body('setting_group').optional().trim(),
    body('label').optional().trim(),
    body('description').optional().trim(),
    body('display_order').optional().isInt({ min: 0 }),
    body('is_public').optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        setting_key,
        setting_value,
        setting_type,
        setting_group,
        label,
        description,
        display_order,
        is_public,
      } = req.body;

      // Check for duplicate key
      const [existing] = await db.query(
        'SELECT id FROM system_settings WHERE setting_key = ?',
        [setting_key]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Setting key already exists' });
      }

      const valueToStore = typeof setting_value === 'object'
        ? JSON.stringify(setting_value)
        : String(setting_value);

      const [result] = await db.query(
        `INSERT INTO system_settings
          (setting_key, setting_value, setting_type, setting_group, label, description, display_order, is_public)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          setting_key,
          valueToStore,
          setting_type || 'text',
          setting_group || null,
          label || null,
          description || null,
          display_order != null ? display_order : 0,
          is_public != null ? is_public : false,
        ]
      );

      await logActivity(
        req.user.id,
        'create_setting',
        result.insertId,
        null,
        { setting_key, setting_type, setting_group }
      );

      res.status(201).json({
        message: 'Setting created successfully',
        setting: { id: result.insertId, setting_key, setting_type },
      });
    } catch (error) {
      console.error('Create setting error:', error);
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Setting key already exists' });
      }
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
