const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');

// ─── DISPLAY SCREEN (no auth — polled by kitchen/bar screens) ────────────────
// GET /display/:stationCode
// Returns active orders with items for this station (pending or preparing), FIFO
router.get('/display/:stationCode', async (req, res) => {
  try {
    const { stationCode } = req.params;

    const [[station]] = await db.query(
      `SELECT s.id, s.name, s.code, s.type, s.display_color, s.branch_id, b.name AS branch_name
       FROM stations s LEFT JOIN branches b ON b.id = s.branch_id
       WHERE s.code = ? AND s.is_active = 1`,
      [stationCode]
    );

    if (!station) {
      return res.status(404).json({ error: 'Station not found or inactive' });
    }

    // Fetch all order_items for this station that are pending/preparing,
    // joined with non-cancelled/completed orders, oldest first (FIFO)
    const [rows] = await db.query(
      `SELECT
         o.id          AS order_id,
         o.order_number,
         o.table_number,
         o.order_type,
         o.created_at  AS order_created_at,
         oi.id         AS item_id,
         oi.product_name,
         oi.quantity,
         oi.notes,
         oi.station_status,
         oi.addons_selected,
         oi.created_at AS item_created_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.station_id = ?
         AND oi.station_status IN ('pending', 'preparing')
         AND o.order_status NOT IN ('cancelled', 'completed', 'deleted')
       ORDER BY oi.created_at ASC`,
      [station.id]
    );

    // Group items by order
    const ordersMap = new Map();
    for (const row of rows) {
      if (!ordersMap.has(row.order_id)) {
        ordersMap.set(row.order_id, {
          id: row.order_id,
          order_number: row.order_number,
          table_number: row.table_number,
          order_type: row.order_type,
          created_at: row.order_created_at,
          items: [],
        });
      }
      ordersMap.get(row.order_id).items.push({
        id: row.item_id,
        product_name: row.product_name,
        quantity: row.quantity,
        notes: row.notes,
        station_status: row.station_status,
        addons_selected: row.addons_selected ? JSON.parse(row.addons_selected) : [],
      });
    }

    res.json({
      station,
      orders: Array.from(ordersMap.values()),
    });
  } catch (error) {
    console.error('Station display error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── UPDATE STATION STATUS FOR ONE ORDER ITEM ────────────────────────────────
// PATCH /items/:orderItemId/status
// body: { status: 'preparing'|'ready' }
// When ALL items of an order reach 'ready', auto-advance order to 'ready' if currently 'preparing'
router.patch('/items/:orderItemId/status',
  authenticate,
  [
    param('orderItemId').isInt({ min: 1 }).withMessage('Invalid order item ID'),
    body('status').isIn(['preparing', 'ready']).withMessage('Status must be "preparing" or "ready"'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const orderItemId = req.params.orderItemId;
      const { status } = req.body;

      // Fetch the item to validate it exists
      const [[item]] = await db.query(
        'SELECT id, order_id, station_status FROM order_items WHERE id = ?',
        [orderItemId]
      );

      if (!item) {
        return res.status(404).json({ error: 'Order item not found' });
      }

      // Update station_status
      await db.query('UPDATE order_items SET station_status = ? WHERE id = ?', [status, orderItemId]);

      // If status is 'ready', check if ALL items of this order are now 'ready'
      if (status === 'ready') {
        const [[{ notReady }]] = await db.query(
          `SELECT COUNT(*) AS notReady FROM order_items
           WHERE order_id = ? AND station_id IS NOT NULL AND station_status != 'ready'`,
          [item.order_id]
        );

        if (notReady === 0) {
          // All station-routed items are ready — advance order_status if currently 'preparing'
          await db.query(
            `UPDATE orders SET order_status = 'ready'
             WHERE id = ? AND order_status = 'preparing'`,
            [item.order_id]
          );
        }
      }

      res.json({ message: 'Item status updated', order_item_id: orderItemId, station_status: status });
    } catch (error) {
      console.error('Update item station status error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── LIST ALL STATIONS ────────────────────────────────────────────────────────
// GET /
router.get('/', authenticate, async (req, res) => {
  try {
    const branch_id = req.query.branch_id || req.user.branch_id || null;
    let sql = 'SELECT * FROM stations WHERE 1=1';
    const params = [];
    if (branch_id) { sql += ' AND branch_id = ?'; params.push(branch_id); }
    sql += ' ORDER BY sort_order ASC, id ASC';
    const [stations] = await db.query(sql, params);
    res.json({ stations });
  } catch (error) {
    console.error('Get stations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CREATE STATION ───────────────────────────────────────────────────────────
// POST /
router.post('/',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    body('name').notEmpty().trim().withMessage('Name is required'),
    body('code').notEmpty().trim().withMessage('Code is required'),
    body('type').optional().trim(),
    body('printer_id').optional({ nullable: true }).isInt({ min: 1 }),
    body('auto_print').optional().isBoolean(),
    body('is_active').optional().isBoolean(),
    body('display_color').optional().trim(),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, code, type, printer_id, auto_print, is_active, display_color, sort_order } = req.body;

      // Check unique code
      const [[existing]] = await db.query('SELECT id FROM stations WHERE code = ?', [code]);
      if (existing) {
        return res.status(409).json({ error: 'Station code already exists' });
      }

      const [result] = await db.query(
        `INSERT INTO stations (name, code, type, printer_id, auto_print, is_active, display_color, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          code,
          type || null,
          printer_id || null,
          auto_print !== undefined ? (auto_print ? 1 : 0) : 0,
          is_active !== undefined ? (is_active ? 1 : 0) : 1,
          display_color || null,
          sort_order !== undefined ? sort_order : 0,
        ]
      );

      res.status(201).json({ message: 'Station created', id: result.insertId });
    } catch (error) {
      console.error('Create station error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── UPDATE STATION ───────────────────────────────────────────────────────────
// PUT /:id
router.put('/:id',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid station ID'),
    body('name').optional().trim(),
    body('code').optional().trim(),
    body('type').optional().trim(),
    body('printer_id').optional({ nullable: true }),
    body('auto_print').optional().isBoolean(),
    body('is_active').optional().isBoolean(),
    body('display_color').optional().trim(),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const stationId = req.params.id;

      const [[station]] = await db.query('SELECT id FROM stations WHERE id = ?', [stationId]);
      if (!station) {
        return res.status(404).json({ error: 'Station not found' });
      }

      const fields = ['name', 'code', 'type', 'printer_id', 'auto_print', 'is_active', 'display_color', 'sort_order'];
      const updates = [];
      const values = [];

      for (const field of fields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          if (field === 'auto_print' || field === 'is_active') {
            values.push(req.body[field] ? 1 : 0);
          } else {
            values.push(req.body[field]);
          }
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      // If code being changed, check uniqueness
      if (req.body.code) {
        const [[dup]] = await db.query('SELECT id FROM stations WHERE code = ? AND id != ?', [req.body.code, stationId]);
        if (dup) return res.status(409).json({ error: 'Station code already exists' });
      }

      values.push(stationId);
      await db.query(`UPDATE stations SET ${updates.join(', ')} WHERE id = ?`, values);

      res.json({ message: 'Station updated' });
    } catch (error) {
      console.error('Update station error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── DELETE STATION ───────────────────────────────────────────────────────────
// DELETE /:id  (not allowed if it's the last station)
router.delete('/:id',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }).withMessage('Invalid station ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const stationId = req.params.id;

      const [[station]] = await db.query('SELECT id FROM stations WHERE id = ?', [stationId]);
      if (!station) {
        return res.status(404).json({ error: 'Station not found' });
      }

      const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM stations');
      if (count <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last station' });
      }

      // Remove routing references first
      await db.query('DELETE FROM product_stations WHERE station_id = ?', [stationId]);
      await db.query('DELETE FROM category_stations WHERE station_id = ?', [stationId]);
      await db.query('DELETE FROM stations WHERE id = ?', [stationId]);

      res.json({ message: 'Station deleted' });
    } catch (error) {
      console.error('Delete station error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── LIST PRODUCTS ROUTED TO A STATION ───────────────────────────────────────
// GET /:id/products
router.get('/:id/products',
  authenticate,
  param('id').isInt({ min: 1 }).withMessage('Invalid station ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const stationId = req.params.id;

      const [[station]] = await db.query('SELECT id, name FROM stations WHERE id = ?', [stationId]);
      if (!station) {
        return res.status(404).json({ error: 'Station not found' });
      }

      const [products] = await db.query(
        `SELECT p.id, p.name, p.price, p.status, c.name AS category_name
         FROM product_stations ps
         JOIN products p ON p.id = ps.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE ps.station_id = ?
         ORDER BY p.name ASC`,
        [stationId]
      );

      res.json({ station, products });
    } catch (error) {
      console.error('Get station products error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── ASSIGN PRODUCTS TO STATION ──────────────────────────────────────────────
// POST /:id/products  body: { product_ids: [1, 2, 3] }
router.post('/:id/products',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid station ID'),
    body('product_ids').isArray({ min: 1 }).withMessage('product_ids must be a non-empty array'),
    body('product_ids.*').isInt({ min: 1 }).withMessage('Each product_id must be a positive integer'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const stationId = req.params.id;
      const { product_ids } = req.body;

      const [[station]] = await db.query('SELECT id FROM stations WHERE id = ?', [stationId]);
      if (!station) {
        return res.status(404).json({ error: 'Station not found' });
      }

      // Insert or ignore duplicates
      for (const pid of product_ids) {
        await db.query(
          'INSERT IGNORE INTO product_stations (product_id, station_id) VALUES (?, ?)',
          [pid, stationId]
        );
      }

      res.json({ message: 'Products assigned to station', product_ids });
    } catch (error) {
      console.error('Assign products to station error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── REMOVE PRODUCT ROUTING ───────────────────────────────────────────────────
// DELETE /:id/products/:pid
router.delete('/:id/products/:pid',
  authenticate,
  authorize('admin'),
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid station ID'),
    param('pid').isInt({ min: 1 }).withMessage('Invalid product ID'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id: stationId, pid: productId } = req.params;

      const [result] = await db.query(
        'DELETE FROM product_stations WHERE station_id = ? AND product_id = ?',
        [stationId, productId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Routing not found' });
      }

      res.json({ message: 'Product routing removed' });
    } catch (error) {
      console.error('Remove product routing error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
