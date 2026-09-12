const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/navigation — public, returns active menu items sorted
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, label, url, icon, target, sort_order, parent_id FROM navigation_menus WHERE is_active = 1 ORDER BY sort_order ASC'
    );
    res.json({ menus: rows });
  } catch (error) {
    console.error('Get navigation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/navigation/all — admin, returns all menu items (including inactive)
router.get('/all', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM navigation_menus ORDER BY sort_order ASC'
    );
    res.json({ menus: rows });
  } catch (error) {
    console.error('Get all navigation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/navigation — admin, create menu item
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { label, url, icon, target, sort_order, parent_id, is_active } = req.body;
    if (!label || !url) return res.status(400).json({ error: 'Label dan URL wajib diisi' });

    // Get max sort_order if not provided
    let order = sort_order;
    if (order == null) {
      const [[{ maxOrder }]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM navigation_menus');
      order = maxOrder + 1;
    }

    const [result] = await db.query(
      'INSERT INTO navigation_menus (label, url, icon, target, sort_order, parent_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [label, url, icon || null, target || '_self', order, parent_id || null, is_active !== false ? 1 : 0]
    );
    res.status(201).json({ message: 'Menu berhasil ditambahkan', id: result.insertId });
  } catch (error) {
    console.error('Create navigation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/navigation/:id — admin, update menu item
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { label, url, icon, target, sort_order, parent_id, is_active } = req.body;
    if (!label || !url) return res.status(400).json({ error: 'Label dan URL wajib diisi' });

    await db.query(
      'UPDATE navigation_menus SET label = ?, url = ?, icon = ?, target = ?, sort_order = ?, parent_id = ?, is_active = ? WHERE id = ?',
      [label, url, icon || null, target || '_self', sort_order || 0, parent_id || null, is_active !== false ? 1 : 0, id]
    );
    res.json({ message: 'Menu berhasil diperbarui' });
  } catch (error) {
    console.error('Update navigation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/navigation/:id — admin, delete menu item
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM navigation_menus WHERE id = ?', [id]);
    res.json({ message: 'Menu berhasil dihapus' });
  } catch (error) {
    console.error('Delete navigation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/navigation/reorder — admin, bulk reorder
router.patch('/reorder', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { items } = req.body; // [{ id, sort_order }, ...]
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items harus array' });

    for (const item of items) {
      await db.query('UPDATE navigation_menus SET sort_order = ? WHERE id = ?', [item.sort_order, item.id]);
    }
    res.json({ message: 'Urutan menu berhasil diperbarui' });
  } catch (error) {
    console.error('Reorder navigation error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
