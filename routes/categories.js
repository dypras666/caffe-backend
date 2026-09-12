const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');

// Helper: generate slug from name
const generateSlug = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

// Helper: ensure slug is unique
const uniqueSlug = async (base, excludeId = null) => {
  let slug = base;
  let counter = 1;
  while (true) {
    const query = excludeId
      ? 'SELECT id FROM categories WHERE slug = ? AND id != ?'
      : 'SELECT id FROM categories WHERE slug = ?';
    const params = excludeId ? [slug, excludeId] : [slug];
    const [rows] = await db.query(query, params);
    if (rows.length === 0) return slug;
    slug = `${base}-${counter++}`;
  }
};

// Helper: log activity
const logActivity = async (userId, action, recordId, oldValues, newValues) => {
  await db.query(
    'INSERT INTO activity_logs (user_id, action, table_name, record_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)',
    [
      userId,
      action,
      'categories',
      recordId || null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ]
  );
};

// GET / — public, with product count
router.get('/', async (req, res) => {
  try {
    const { status, parent_id } = req.query;

    let query = `
      SELECT
        c.*,
        c.image_url AS icon,
        c.display_order AS sort_order,
        IF(c.status = 'active', 1, 0) AS is_active,
        p.name AS parent_name,
        COUNT(DISTINCT pr.id) AS product_count
      FROM categories c
      LEFT JOIN categories p ON c.parent_id = p.id
      LEFT JOIN products pr ON pr.category_id = c.id AND pr.status = 'active'
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND c.status = ?';
      params.push(status);
    }

    if (parent_id !== undefined) {
      if (parent_id === 'null' || parent_id === '') {
        query += ' AND c.parent_id IS NULL';
      } else {
        query += ' AND c.parent_id = ?';
        params.push(parent_id);
      }
    }

    query += ' GROUP BY c.id ORDER BY c.display_order, c.name';

    const [categories] = await db.query(query, params);
    res.json({ categories, count: categories.length });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id
router.get('/:id',
  param('id').isInt({ min: 1 }).withMessage('Invalid category ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const [rows] = await db.query(
        `SELECT c.*, p.name AS parent_name,
                c.image_url AS icon,
                c.display_order AS sort_order,
                IF(c.status = 'active', 1, 0) AS is_active,
                COUNT(DISTINCT pr.id) AS product_count
         FROM categories c
         LEFT JOIN categories p ON c.parent_id = p.id
         LEFT JOIN products pr ON pr.category_id = c.id AND pr.status = 'active'
         WHERE c.id = ?
         GROUP BY c.id`,
        [req.params.id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      res.json({ category: rows[0] });
    } catch (error) {
      console.error('Get category error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST / — admin, auto-generate slug
router.post('/',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('description').optional().trim(),
    body('icon').optional().trim(),
    body('parent_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('parent_id must be a valid integer'),
    body('sort_order').optional().isInt({ min: 0 }),
    body('is_active').optional().isBoolean(),
    body('slug').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, description, icon, parent_id, sort_order, is_active, slug } = req.body;

      // Validate parent exists if provided
      if (parent_id) {
        const [parent] = await db.query('SELECT id FROM categories WHERE id = ?', [parent_id]);
        if (parent.length === 0) {
          return res.status(400).json({ error: 'Parent category not found' });
        }
      }

      const baseSlug = slug ? generateSlug(slug) : generateSlug(name);
      const finalSlug = await uniqueSlug(baseSlug);

      const status = is_active !== false && is_active !== 'false' && is_active !== 0 ? 'active' : 'inactive';

      const [result] = await db.query(
        `INSERT INTO categories (name, slug, description, image_url, parent_id, display_order, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          finalSlug,
          description || null,
          icon || null,
          parent_id || null,
          sort_order != null ? sort_order : 0,
          status,
        ]
      );

      await logActivity(req.user.id, 'create_category', result.insertId, null, { name, slug: finalSlug });

      res.status(201).json({
        message: 'Category created successfully',
        category: { id: result.insertId, name, slug: finalSlug },
      });
    } catch (error) {
      console.error('Create category error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id — admin
router.put('/:id',
  authenticate,
  authorize('admin'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid category ID'),
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('description').optional({ nullable: true }).trim(),
    body('icon').optional({ nullable: true }).trim(),
    body('parent_id').optional({ nullable: true }),
    body('sort_order').optional().isInt({ min: 0 }),
    body('is_active').optional().isBoolean(),
    body('slug').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const categoryId = req.params.id;

      const [existing] = await db.query('SELECT * FROM categories WHERE id = ?', [categoryId]);
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const old = existing[0];

      // Prevent circular parent reference
      if (req.body.parent_id && Number(req.body.parent_id) === Number(categoryId)) {
        return res.status(400).json({ error: 'A category cannot be its own parent' });
      }

      if (req.body.parent_id) {
        const [parent] = await db.query('SELECT id FROM categories WHERE id = ?', [req.body.parent_id]);
        if (parent.length === 0) {
          return res.status(400).json({ error: 'Parent category not found' });
        }
      }

      const allowedFields = ['name', 'description', 'parent_id'];
      const updates = [];
      const values = [];

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field] === '' ? null : req.body[field]);
        }
      }

      if (req.body.icon !== undefined) {
        updates.push(`image_url = ?`);
        values.push(req.body.icon === '' ? null : req.body.icon);
      }
      if (req.body.sort_order !== undefined) {
        updates.push(`display_order = ?`);
        values.push(req.body.sort_order);
      }
      if (req.body.is_active !== undefined) {
        updates.push(`status = ?`);
        values.push(req.body.is_active !== false && req.body.is_active !== 'false' && req.body.is_active !== 0 ? 'active' : 'inactive');
      }

      // Handle slug update
      if (req.body.slug !== undefined || req.body.name !== undefined) {
        const baseSlug = req.body.slug
          ? generateSlug(req.body.slug)
          : generateSlug(req.body.name || old.name);
        const finalSlug = await uniqueSlug(baseSlug, categoryId);
        updates.push('slug = ?');
        values.push(finalSlug);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      values.push(categoryId);
      await db.query(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`, values);

      await logActivity(req.user.id, 'update_category', categoryId, old, req.body);

      res.json({ message: 'Category updated successfully' });
    } catch (error) {
      console.error('Update category error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /:id — admin, check if products exist
router.delete('/:id',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }).withMessage('Invalid category ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const categoryId = req.params.id;

      const [existing] = await db.query('SELECT * FROM categories WHERE id = ?', [categoryId]);
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      // Check if any products use this category
      const [products] = await db.query(
        'SELECT COUNT(*) AS cnt FROM products WHERE category_id = ?',
        [categoryId]
      );
      if (products[0].cnt > 0) {
        return res.status(409).json({
          error: 'Cannot delete category',
          message: `This category has ${products[0].cnt} product(s). Reassign or delete them first.`,
        });
      }

      // Check for child categories
      const [children] = await db.query(
        'SELECT COUNT(*) AS cnt FROM categories WHERE parent_id = ?',
        [categoryId]
      );
      if (children[0].cnt > 0) {
        return res.status(409).json({
          error: 'Cannot delete category',
          message: `This category has ${children[0].cnt} sub-categor(ies). Remove them first.`,
        });
      }

      await db.query('DELETE FROM categories WHERE id = ?', [categoryId]);

      await logActivity(req.user.id, 'delete_category', categoryId, existing[0], null);

      res.json({ message: 'Category deleted successfully' });
    } catch (error) {
      console.error('Delete category error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
