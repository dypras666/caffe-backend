const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize, can, optionalAuth } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');

// Get all products (public)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, status, popular, available, search } = req.query;
    const branch_id = req.query.branch_id || req.user?.branch_id || null;

    let query = `
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (category) {
      query += ' AND p.category_id = ?';
      params.push(category);
    }

    if (status && req.user?.role === 'admin') {
      query += ' AND p.status = ?';
      params.push(status);
    } else {
      query += ' AND p.status = "active"';
    }

    if (popular === 'true') {
      query += ' AND p.is_popular = 1';
    }

    if (available === 'true') {
      query += ' AND p.is_available = 1';
    }

    if (search) {
      query += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.sku LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY p.created_at DESC';

    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const countQuery = query.replace(
      'SELECT p.*, c.name as category_name',
      'SELECT COUNT(*) as total'
    );
    const [[{ total }]] = await db.query(countQuery, params);

    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [products] = await db.query(query, params);

    // Inject has_variants / has_addons flags efficiently in one query
    if (products.length > 0) {
      const ids = products.map(p => p.id);
      const [vGroups] = await db.query(
        'SELECT DISTINCT product_id FROM product_variant_groups WHERE product_id IN (?)',
        [ids]
      );
      const [aGroups] = await db.query(
        'SELECT DISTINCT product_id FROM product_addon_groups WHERE product_id IN (?)',
        [ids]
      );
      const variantSet = new Set(vGroups.map(r => r.product_id));
      const addonSet   = new Set(aGroups.map(r => r.product_id));
      products.forEach(p => {
        p.has_variants = variantSet.has(p.id);
        p.has_addons   = addonSet.has(p.id);
      });

      // Inject per-branch stock if branch_id provided
      if (branch_id) {
        const [branchStocks] = await db.query(
          'SELECT product_id, stock, min_stock FROM product_branch_stock WHERE branch_id=? AND product_id IN (?)',
          [branch_id, ids]
        );
        const bsMap = new Map(branchStocks.map(r => [r.product_id, r]));
        products.forEach(p => {
          const bs = bsMap.get(p.id);
          if (bs) { p.stock = bs.stock; p.min_stock = bs.min_stock; }
        });
      }

      // Inject promo data from active vouchers
      try {
        const [vouchers] = await db.query(`
          SELECT * FROM vouchers 
          WHERE is_active = 1 
            AND type = 'item_discount'
            AND (valid_from IS NULL OR valid_from <= NOW())
            AND (valid_until IS NULL OR valid_until >= NOW())
        `);
        if (vouchers.length > 0) {
          const promoMap = new Map();
          for (const v of vouchers) {
            if (v.applicable_products) {
              let parsed = v.applicable_products;
              try {
                while (typeof parsed === 'string') {
                  parsed = JSON.parse(parsed);
                }
                pIds = Array.isArray(parsed) ? parsed : [];
              } catch(e) {
                pIds = [];
              }
              for (const pid of pIds) {
                if (!promoMap.has(pid)) {
                  promoMap.set(pid, {
                    promo_end_time: v.valid_until || new Date(Date.now() + 86400000).toISOString(),
                    promo_rules: `Diskon ${v.discount_type === 'percent' ? v.discount_value + '%' : 'Rp' + v.discount_value} (${v.code})`,
                    promo_voucher: {
                      code: v.code,
                      discount_type: v.discount_type,
                      discount_value: v.discount_value
                    }
                  });
                }
              }
            }
          }
          products.forEach(p => {
            const promo = promoMap.get(p.id);
            if (promo) {
              let meta = {};
              if (p.meta_data) {
                try { meta = typeof p.meta_data === 'string' ? JSON.parse(p.meta_data) : p.meta_data; } catch(e){}
              }
              meta.promo_end_time = promo.promo_end_time;
              meta.promo_rules = promo.promo_rules;
              meta.promo_voucher = promo.promo_voucher;
              p.meta_data = JSON.stringify(meta);
            }
          });
        }
      } catch (err) {
        console.error('Error injecting promos:', err);
      }
    }

    res.json({
      products,
      count: products.length,
      branch_id,
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single product
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const [products] = await db.query(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = ?`,
      [req.params.id]
    );

    if (products.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Get custom fields
    const [customFields] = await db.query(
      `SELECT pcf.*, pfd.field_name, pfd.field_label, pfd.field_type
       FROM product_custom_fields pcf
       JOIN product_field_definitions pfd ON pcf.field_id = pfd.id
       WHERE pcf.product_id = ?`,
      [req.params.id]
    );

    const product = products[0];
    product.custom_fields = customFields;

    // Include variant & addon config
    try {
      const { loadProductConfig } = require('./variants');
      const config = await loadProductConfig(product.id);
      product.variant_groups = config.variant_groups;
      product.addon_groups = config.addon_groups;
    } catch {}

    res.json({ product });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create product
router.post('/',
  authenticate,
  can('create', 'products'),
  sanitizeInput,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('price').isFloat({ min: 0 }).withMessage('Valid price is required'),
    body('category_id').optional().isInt(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        category_id, name, slug, description, price, cost_price,
        sku, barcode, stock, min_stock, unit, image, gallery,
        is_popular, is_available, status, meta_data, custom_fields
      } = req.body;

      // Generate slug if not provided
      const productSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      // Insert product
      const [result] = await db.query(
        `INSERT INTO products (
          category_id, name, slug, description, price, cost_price,
          sku, barcode, stock, min_stock, unit, image, gallery,
          is_popular, is_available, status, meta_data, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          category_id || null, name, productSlug, description || null,
          price, cost_price || null, sku || null, barcode || null,
          stock || 0, min_stock || 0, unit || 'pcs', image || null,
          gallery ? JSON.stringify(gallery) : null,
          is_popular || false, is_available || true,
          status || 'active',
          meta_data ? JSON.stringify(meta_data) : null,
          req.user.id
        ]
      );

      const productId = result.insertId;

      // Insert custom fields if provided
      if (custom_fields && Array.isArray(custom_fields)) {
        for (const field of custom_fields) {
          await db.query(
            'INSERT INTO product_custom_fields (product_id, field_id, field_value) VALUES (?, ?, ?)',
            [productId, field.field_id, field.field_value]
          );
        }
      }

      // Log activity
      await db.query(
        'INSERT INTO activity_logs (user_id, action, table_name, record_id, new_values) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, 'create_product', 'products', productId, JSON.stringify({ name, price, sku })]
      );

      res.status(201).json({
        message: 'Product created successfully',
        product: { id: productId, name, slug: productSlug }
      });
    } catch (error) {
      console.error('Create product error:', error);
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'Slug or SKU already exists' });
      }
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update product
router.put('/:id',
  authenticate,
  can('update', 'products'),
  sanitizeInput,
  async (req, res) => {
    try {
      const productId = req.params.id;

      // Check if product exists
      const [existing] = await db.query('SELECT id FROM products WHERE id = ?', [productId]);
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const allowedFields = [
        'category_id', 'name', 'slug', 'description', 'price', 'cost_price',
        'sku', 'barcode', 'min_stock', 'unit', 'image', 'gallery',
        'is_popular', 'is_available', 'status', 'meta_data'
      ];

      const updates = [];
      const values = [];

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(
            ['gallery', 'meta_data'].includes(field) && typeof req.body[field] === 'object'
              ? JSON.stringify(req.body[field])
              : req.body[field]
          );
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      values.push(productId);

      await db.query(
        `UPDATE products SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      // Update custom fields if provided
      if (req.body.custom_fields && Array.isArray(req.body.custom_fields)) {
        for (const field of req.body.custom_fields) {
          await db.query(
            `INSERT INTO product_custom_fields (product_id, field_id, field_value)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE field_value = ?`,
            [productId, field.field_id, field.field_value, field.field_value]
          );
        }
      }

      // Log activity
      await db.query(
        'INSERT INTO activity_logs (user_id, action, table_name, record_id, new_values) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, 'update_product', 'products', productId, JSON.stringify(req.body)]
      );

      res.json({ message: 'Product updated successfully' });
    } catch (error) {
      console.error('Update product error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PATCH /api/products/:id/stock — stock adjustment with tracking
router.patch('/:id/stock', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  const { qty_change, movement_type = 'adjustment', note, unit_cost } = req.body;
  if (qty_change === undefined) return res.status(400).json({ error: 'qty_change wajib' });

  const branch_id = req.body.branch_id || req.user.branch_id || null;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[prod]] = await conn.query('SELECT id, name, stock FROM products WHERE id=?', [req.params.id]);
    if (!prod) throw new Error('Produk tidak ditemukan');

    let qtyBefore, qtyAfter;
    if (branch_id) {
      await conn.query(
        'INSERT INTO product_branch_stock (product_id, branch_id, stock, min_stock) VALUES (?,?,0,0) ON DUPLICATE KEY UPDATE stock=stock',
        [req.params.id, branch_id]
      );
      const [[bs]] = await conn.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [req.params.id, branch_id]
      );
      qtyBefore = bs ? bs.stock : 0;
      qtyAfter  = qtyBefore + parseInt(qty_change);
      if (qtyAfter < 0) throw new Error('Stok tidak boleh negatif');
      await conn.query(
        'UPDATE product_branch_stock SET stock=? WHERE product_id=? AND branch_id=?',
        [qtyAfter, req.params.id, branch_id]
      );
      // Sync global
      await conn.query(
        'UPDATE products SET stock=(SELECT COALESCE(SUM(stock),0) FROM product_branch_stock WHERE product_id=?) WHERE id=?',
        [req.params.id, req.params.id]
      );
    } else {
      qtyBefore = prod.stock;
      qtyAfter  = qtyBefore + parseInt(qty_change);
      if (qtyAfter < 0) throw new Error('Stok tidak boleh negatif');
      await conn.query('UPDATE products SET stock=? WHERE id=?', [qtyAfter, req.params.id]);
    }

    await conn.query(
      'INSERT INTO stock_cards (product_id, branch_id, movement_type, reference_type, qty_before, qty_change, qty_after, unit_cost, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [req.params.id, branch_id, movement_type, 'manual', qtyBefore, parseInt(qty_change), qtyAfter, unit_cost || 0, note || null, req.user.id]
    );

    await conn.commit();
    res.json({ product_id: req.params.id, branch_id, qty_before: qtyBefore, qty_after: qtyAfter, qty_change: parseInt(qty_change) });
  } catch (e) { await conn.rollback(); res.status(400).json({ error: e.message }); }
  finally { conn.release(); }
});

// Delete product
router.delete('/:id',
  authenticate,
  can('delete', 'products'),
  async (req, res) => {
    try {
      const productId = req.params.id;

      // Check if product exists
      const [existing] = await db.query('SELECT name FROM products WHERE id = ?', [productId]);
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Product not found' });
      }

      await db.query('DELETE FROM products WHERE id = ?', [productId]);

      // Log activity
      await db.query(
        'INSERT INTO activity_logs (user_id, action, table_name, record_id, old_values) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, 'delete_product', 'products', productId, JSON.stringify(existing[0])]
      );

      res.json({ message: 'Product deleted successfully' });
    } catch (error) {
      console.error('Delete product error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
