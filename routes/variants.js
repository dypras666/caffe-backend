const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// ─── Startup migration: add ingredient columns if not present ─────
(async () => {
  const migrations = [
    'ALTER TABLE product_variant_options ADD COLUMN IF NOT EXISTS ingredient_id INT DEFAULT NULL',
    'ALTER TABLE product_variant_options ADD COLUMN IF NOT EXISTS ingredient_qty DECIMAL(10,3) DEFAULT 0',
    'ALTER TABLE product_variant_options ADD COLUMN IF NOT EXISTS ingredient_unit VARCHAR(30) DEFAULT NULL',
    'ALTER TABLE product_addons ADD COLUMN IF NOT EXISTS ingredient_id INT DEFAULT NULL',
    'ALTER TABLE product_addons ADD COLUMN IF NOT EXISTS ingredient_qty DECIMAL(10,3) DEFAULT 0',
    'ALTER TABLE product_addons ADD COLUMN IF NOT EXISTS ingredient_unit VARCHAR(30) DEFAULT NULL',
  ];
  for (const sql of migrations) {
    try { await db.query(sql); } catch (_) { /* column already exists or other non-fatal error */ }
  }
})();

// ─── Helper: load full variant+addon config for a product ─────
async function loadProductConfig(productId) {
  const [variantGroups] = await db.query(
    `SELECT vg.*, JSON_ARRAYAGG(
       JSON_OBJECT(
         'id', vo.id, 'name', vo.name, 'price_modifier', vo.price_modifier,
         'is_default', vo.is_default, 'is_active', vo.is_active, 'sort_order', vo.sort_order,
         'ingredient_id', vo.ingredient_id, 'ingredient_qty', vo.ingredient_qty,
         'ingredient_unit', vo.ingredient_unit,
         'ingredient_name', i.name, 'ingredient_base_unit', i.unit
       ) ORDER BY vo.sort_order
     ) AS options
     FROM product_variant_groups vg
     LEFT JOIN product_variant_options vo ON vo.group_id = vg.id AND vo.is_active = 1
     LEFT JOIN ingredients i ON i.id = vo.ingredient_id
     WHERE vg.product_id = ?
     GROUP BY vg.id ORDER BY vg.sort_order`,
    [productId]
  );

  const [addonGroups] = await db.query(
    `SELECT ag.*, JSON_ARRAYAGG(
       JSON_OBJECT(
         'id', a.id, 'name', a.name, 'price', a.price,
         'max_qty', a.max_qty, 'is_active', a.is_active, 'sort_order', a.sort_order,
         'ingredient_id', a.ingredient_id, 'ingredient_qty', a.ingredient_qty,
         'ingredient_unit', a.ingredient_unit,
         'ingredient_name', i.name, 'ingredient_base_unit', i.unit
       ) ORDER BY a.sort_order
     ) AS addons
     FROM product_addon_groups ag
     LEFT JOIN product_addons a ON a.group_id = ag.id AND a.is_active = 1
     LEFT JOIN ingredients i ON i.id = a.ingredient_id
     WHERE ag.product_id = ?
     GROUP BY ag.id ORDER BY ag.sort_order`,
    [productId]
  );

  return {
    variant_groups: variantGroups.map(g => ({ ...g, options: g.options ? JSON.parse(g.options) : [] })),
    addon_groups: addonGroups.map(g => ({ ...g, addons: g.addons ? JSON.parse(g.addons) : [] })),
  };
}

// GET /api/variants/:productId — full config
router.get('/:productId', async (req, res) => {
  try {
    const pid = req.params.productId;
    if (!pid || pid === 'null' || pid === 'undefined' || isNaN(parseInt(pid))) {
      return res.json({ product: null, variant_groups: [], addon_groups: [] });
    }
    const [[product]] = await db.query('SELECT id, name, price FROM products WHERE id=?', [pid]);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    const config = await loadProductConfig(pid);
    res.json({ product, ...config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VARIANT GROUPS ───────────────────────────────────────────

router.post('/:productId/groups', authenticate, authorize('admin'), async (req, res) => {
  const { name, is_required, min_select, max_select, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama group wajib' });
  try {
    const [r] = await db.query(
      'INSERT INTO product_variant_groups (product_id, name, is_required, min_select, max_select, sort_order) VALUES (?,?,?,?,?,?)',
      [req.params.productId, name, is_required ? 1 : 0, min_select || 1, max_select || 1, sort_order || 0]
    );
    const [[g]] = await db.query('SELECT * FROM product_variant_groups WHERE id=?', [r.insertId]);
    res.status(201).json({ group: { ...g, options: [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/groups/:groupId', authenticate, authorize('admin'), async (req, res) => {
  const { name, is_required, min_select, max_select, sort_order } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (is_required !== undefined) { fields.push('is_required=?'); vals.push(is_required ? 1 : 0); }
  if (min_select !== undefined) { fields.push('min_select=?'); vals.push(min_select); }
  if (max_select !== undefined) { fields.push('max_select=?'); vals.push(max_select); }
  if (sort_order !== undefined) { fields.push('sort_order=?'); vals.push(sort_order); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    vals.push(req.params.groupId);
    await db.query(`UPDATE product_variant_groups SET ${fields.join(',')} WHERE id=?`, vals);
    const [[g]] = await db.query('SELECT * FROM product_variant_groups WHERE id=?', [req.params.groupId]);
    res.json({ group: g });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/groups/:groupId', authenticate, authorize('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM product_variant_groups WHERE id=?', [req.params.groupId]);
    res.json({ message: 'Group dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VARIANT OPTIONS ──────────────────────────────────────────

router.post('/groups/:groupId/options', authenticate, authorize('admin'), async (req, res) => {
  const { name, price_modifier, is_default, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama opsi wajib' });
  try {
    if (is_default) await db.query('UPDATE product_variant_options SET is_default=0 WHERE group_id=?', [req.params.groupId]);
    const [r] = await db.query(
      'INSERT INTO product_variant_options (group_id, name, price_modifier, is_default, sort_order) VALUES (?,?,?,?,?)',
      [req.params.groupId, name, price_modifier || 0, is_default ? 1 : 0, sort_order || 0]
    );
    const [[opt]] = await db.query('SELECT * FROM product_variant_options WHERE id=?', [r.insertId]);
    res.status(201).json({ option: opt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/options/:optionId', authenticate, authorize('admin'), async (req, res) => {
  const oid = req.params.optionId;
  if (!oid || oid === 'null' || oid === 'undefined' || isNaN(parseInt(oid)))
    return res.status(400).json({ error: 'Invalid option id' });
  const { name, price_modifier, is_default, is_active, sort_order,
          ingredient_id, ingredient_qty, ingredient_unit } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (price_modifier !== undefined) { fields.push('price_modifier=?'); vals.push(price_modifier); }
  if (is_default !== undefined) {
    if (is_default) {
      const [[opt]] = await db.query('SELECT group_id FROM product_variant_options WHERE id=?', [req.params.optionId]);
      if (opt) await db.query('UPDATE product_variant_options SET is_default=0 WHERE group_id=?', [opt.group_id]);
    }
    fields.push('is_default=?'); vals.push(is_default ? 1 : 0);
  }
  if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (sort_order !== undefined) { fields.push('sort_order=?'); vals.push(sort_order); }
  if (ingredient_id !== undefined) { fields.push('ingredient_id=?'); vals.push(ingredient_id || null); }
  if (ingredient_qty !== undefined) { fields.push('ingredient_qty=?'); vals.push(ingredient_qty); }
  if (ingredient_unit !== undefined) { fields.push('ingredient_unit=?'); vals.push(ingredient_unit || null); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    vals.push(req.params.optionId);
    await db.query(`UPDATE product_variant_options SET ${fields.join(',')} WHERE id=?`, vals);
    const [[opt]] = await db.query(
      `SELECT vo.*, i.name AS ingredient_name, i.unit AS ingredient_base_unit
       FROM product_variant_options vo
       LEFT JOIN ingredients i ON i.id = vo.ingredient_id
       WHERE vo.id=?`,
      [req.params.optionId]
    );
    res.json({ option: opt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/options/:optionId', authenticate, authorize('admin'), async (req, res) => {
  const oid = req.params.optionId;
  if (!oid || oid === 'null' || oid === 'undefined' || isNaN(parseInt(oid)))
    return res.status(400).json({ error: 'Invalid option id' });
  try {
    await db.query('DELETE FROM product_variant_options WHERE id=?', [oid]);
    res.json({ message: 'Opsi dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADDON GROUPS ─────────────────────────────────────────────

router.post('/:productId/addon-groups', authenticate, authorize('admin'), async (req, res) => {
  const { name, is_required, min_qty, max_qty, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama group addon wajib' });
  try {
    const [r] = await db.query(
      'INSERT INTO product_addon_groups (product_id, name, is_required, min_qty, max_qty, sort_order) VALUES (?,?,?,?,?,?)',
      [req.params.productId, name, is_required ? 1 : 0, min_qty || 0, max_qty || 5, sort_order || 0]
    );
    const [[g]] = await db.query('SELECT * FROM product_addon_groups WHERE id=?', [r.insertId]);
    res.status(201).json({ group: { ...g, addons: [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/addon-groups/:groupId', authenticate, authorize('admin'), async (req, res) => {
  const { name, is_required, min_qty, max_qty, sort_order } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (is_required !== undefined) { fields.push('is_required=?'); vals.push(is_required ? 1 : 0); }
  if (min_qty !== undefined) { fields.push('min_qty=?'); vals.push(min_qty); }
  if (max_qty !== undefined) { fields.push('max_qty=?'); vals.push(max_qty); }
  if (sort_order !== undefined) { fields.push('sort_order=?'); vals.push(sort_order); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    vals.push(req.params.groupId);
    await db.query(`UPDATE product_addon_groups SET ${fields.join(',')} WHERE id=?`, vals);
    const [[g]] = await db.query('SELECT * FROM product_addon_groups WHERE id=?', [req.params.groupId]);
    res.json({ group: g });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/addon-groups/:groupId', authenticate, authorize('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM product_addon_groups WHERE id=?', [req.params.groupId]);
    res.json({ message: 'Group addon dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADDON ITEMS ──────────────────────────────────────────────

router.post('/addon-groups/:groupId/addons', authenticate, authorize('admin'), async (req, res) => {
  const { name, price, max_qty, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama addon wajib' });
  try {
    const [r] = await db.query(
      'INSERT INTO product_addons (group_id, name, price, max_qty, sort_order) VALUES (?,?,?,?,?)',
      [req.params.groupId, name, price || 0, max_qty || 3, sort_order || 0]
    );
    const [[addon]] = await db.query('SELECT * FROM product_addons WHERE id=?', [r.insertId]);
    res.status(201).json({ addon });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/addons/:addonId', authenticate, authorize('admin'), async (req, res) => {
  const { name, price, max_qty, is_active, sort_order,
          ingredient_id, ingredient_qty, ingredient_unit } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (price !== undefined) { fields.push('price=?'); vals.push(price); }
  if (max_qty !== undefined) { fields.push('max_qty=?'); vals.push(max_qty); }
  if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (sort_order !== undefined) { fields.push('sort_order=?'); vals.push(sort_order); }
  if (ingredient_id !== undefined) { fields.push('ingredient_id=?'); vals.push(ingredient_id || null); }
  if (ingredient_qty !== undefined) { fields.push('ingredient_qty=?'); vals.push(ingredient_qty); }
  if (ingredient_unit !== undefined) { fields.push('ingredient_unit=?'); vals.push(ingredient_unit || null); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    vals.push(req.params.addonId);
    await db.query(`UPDATE product_addons SET ${fields.join(',')} WHERE id=?`, vals);
    const [[addon]] = await db.query(
      `SELECT a.*, i.name AS ingredient_name, i.unit AS ingredient_base_unit
       FROM product_addons a
       LEFT JOIN ingredients i ON i.id = a.ingredient_id
       WHERE a.id=?`,
      [req.params.addonId]
    );
    res.json({ addon });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/addons/:addonId', authenticate, authorize('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM product_addons WHERE id=?', [req.params.addonId]);
    res.json({ message: 'Addon dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.loadProductConfig = loadProductConfig;
