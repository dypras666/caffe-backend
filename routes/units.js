const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');

// ─── LIST ALL ACTIVE UNITS (public) ──────────────────────────────────────────
// GET /
router.get('/', async (req, res) => {
  try {
    const [units] = await db.query(
      `SELECT u.id, u.name, u.symbol, u.type, u.conversion_factor, u.is_active,
              b.name AS base_unit_name, b.symbol AS base_unit_symbol
       FROM units u
       LEFT JOIN units b ON b.id = u.base_unit_id
       WHERE u.is_active = 1
       ORDER BY u.type ASC, u.name ASC`
    );
    res.json({ units });
  } catch (error) {
    console.error('Get units error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── UNIT CONVERSION ──────────────────────────────────────────────────────────
// GET /:id/convert?qty=5&to_unit_id=2
// Logic: both units must share the same base_unit_id
// result = qty * from.conversion_factor / to.conversion_factor
router.get('/:id/convert',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid unit ID'),
    query('qty').isFloat({ min: 0 }).withMessage('qty must be a non-negative number'),
    query('to_unit_id').isInt({ min: 1 }).withMessage('to_unit_id must be a positive integer'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const fromId = req.params.id;
      const toId = req.query.to_unit_id;
      const qty = parseFloat(req.query.qty);

      const [[fromUnit]] = await db.query(
        'SELECT id, name, symbol, base_unit_id, conversion_factor FROM units WHERE id = ? AND is_active = 1',
        [fromId]
      );
      if (!fromUnit) {
        return res.status(404).json({ error: 'Source unit not found or inactive' });
      }

      const [[toUnit]] = await db.query(
        'SELECT id, name, symbol, base_unit_id, conversion_factor FROM units WHERE id = ? AND is_active = 1',
        [toId]
      );
      if (!toUnit) {
        return res.status(404).json({ error: 'Target unit not found or inactive' });
      }

      if (fromUnit.base_unit_id === null || toUnit.base_unit_id === null || fromUnit.base_unit_id !== toUnit.base_unit_id) {
        return res.status(400).json({
          error: 'Units are not compatible (different base unit or no base unit set)',
        });
      }

      const factor = parseFloat(fromUnit.conversion_factor) / parseFloat(toUnit.conversion_factor);
      const toQty = parseFloat((qty * factor).toFixed(6));

      res.json({
        from_qty: qty,
        from_unit: { id: fromUnit.id, name: fromUnit.name, symbol: fromUnit.symbol },
        to_qty: toQty,
        to_unit: { id: toUnit.id, name: toUnit.name, symbol: toUnit.symbol },
        factor,
      });
    } catch (error) {
      console.error('Unit convert error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── CREATE UNIT ──────────────────────────────────────────────────────────────
// POST /
router.post('/',
  authenticate,
  authorize('admin', 'station'),
  sanitizeInput,
  [
    body('name').notEmpty().trim().withMessage('Name is required'),
    body('symbol').notEmpty().trim().withMessage('Symbol is required'),
    body('type').optional().trim(),
    body('base_unit_id').optional({ nullable: true }).isInt({ min: 1 }),
    body('conversion_factor').optional().isFloat({ min: 0 }).withMessage('conversion_factor must be a non-negative number'),
    body('is_active').optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, symbol, type, base_unit_id, conversion_factor, is_active } = req.body;

      const [result] = await db.query(
        `INSERT INTO units (name, symbol, type, base_unit_id, conversion_factor, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          name,
          symbol,
          type || null,
          base_unit_id || null,
          conversion_factor !== undefined ? conversion_factor : 1,
          is_active !== undefined ? (is_active ? 1 : 0) : 1,
        ]
      );

      res.status(201).json({ message: 'Unit created', id: result.insertId });
    } catch (error) {
      console.error('Create unit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── UPDATE UNIT ──────────────────────────────────────────────────────────────
// PUT /:id
router.put('/:id',
  authenticate,
  authorize('admin', 'station'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid unit ID'),
    body('name').optional().trim(),
    body('symbol').optional().trim(),
    body('type').optional().trim(),
    body('base_unit_id').optional({ nullable: true }),
    body('conversion_factor').optional().isFloat({ min: 0 }),
    body('is_active').optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const unitId = req.params.id;

      const [[unit]] = await db.query('SELECT id FROM units WHERE id = ?', [unitId]);
      if (!unit) {
        return res.status(404).json({ error: 'Unit not found' });
      }

      const fields = ['name', 'symbol', 'type', 'base_unit_id', 'conversion_factor', 'is_active'];
      const updates = [];
      const values = [];

      for (const field of fields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          if (field === 'is_active') {
            values.push(req.body[field] ? 1 : 0);
          } else {
            values.push(req.body[field]);
          }
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      values.push(unitId);
      await db.query(`UPDATE units SET ${updates.join(', ')} WHERE id = ?`, values);

      res.json({ message: 'Unit updated' });
    } catch (error) {
      console.error('Update unit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── SOFT DELETE UNIT ─────────────────────────────────────────────────────────
// DELETE /:id  (sets is_active = 0)
router.delete('/:id',
  authenticate,
  authorize('admin', 'station'),
  param('id').isInt({ min: 1 }).withMessage('Invalid unit ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const unitId = req.params.id;

      const [[unit]] = await db.query('SELECT id, is_active FROM units WHERE id = ?', [unitId]);
      if (!unit) {
        return res.status(404).json({ error: 'Unit not found' });
      }

      await db.query('UPDATE units SET is_active = 0 WHERE id = ?', [unitId]);

      res.json({ message: 'Unit deactivated (soft deleted)' });
    } catch (error) {
      console.error('Delete unit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
