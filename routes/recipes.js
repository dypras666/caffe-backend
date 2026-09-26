const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

// ─── Helper: recalculate HPP for one recipe (with unit conversion) ──
async function calcRecipeCost(recipeId) {
  const [items] = await db.query(
    `SELECT ri.qty, ri.waste_pct, ri.unit AS recipe_unit,
            i.unit_cost, i.unit AS ingredient_unit
     FROM recipe_items ri
     JOIN ingredients i ON i.id = ri.ingredient_id
     WHERE ri.recipe_id = ?`,
    [recipeId]
  );

  let totalCost = 0;
  for (const item of items) {
    let qty = item.qty * (1 + (item.waste_pct || 0) / 100);

    // Unit conversion if recipe unit differs from ingredient unit
    if (item.recipe_unit && item.ingredient_unit && item.recipe_unit !== item.ingredient_unit) {
      try {
        const [[fromUnit]] = await db.query('SELECT * FROM units WHERE symbol=? OR name=?', [item.recipe_unit, item.recipe_unit]);
        const [[toUnit]]   = await db.query('SELECT * FROM units WHERE symbol=? OR name=?', [item.ingredient_unit, item.ingredient_unit]);
        if (fromUnit && toUnit && fromUnit.base_unit_id === toUnit.base_unit_id && fromUnit.base_unit_id !== null) {
          // Both share same base: convert from → base → to
          qty = qty * parseFloat(fromUnit.conversion_factor) / parseFloat(toUnit.conversion_factor);
        } else if (fromUnit && toUnit && fromUnit.id === toUnit.base_unit_id) {
          qty = qty * parseFloat(fromUnit.conversion_factor);
        } else if (fromUnit && toUnit && toUnit.id === fromUnit.base_unit_id) {
          qty = qty / parseFloat(fromUnit.conversion_factor);
        }
      } catch (_) { /* leave qty unchanged if unit lookup fails */ }
    }

    totalCost += qty * parseFloat(item.unit_cost || 0);
  }
  return parseFloat(totalCost.toFixed(4));
}

// GET /api/recipes — list all with HPP
router.get('/', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT r.*, p.name AS product_name, p.price AS selling_price,
              p.price - r.last_cost AS gross_profit,
              CASE WHEN p.price > 0 THEN ROUND((p.price - r.last_cost) / p.price * 100, 2) ELSE 0 END AS margin_pct
       FROM recipes r JOIN products p ON p.id = r.product_id
       ORDER BY p.name`
    );
    res.json({ recipes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/recipes/:productId
router.get('/:productId', authenticate, async (req, res) => {
  try {
    const [[recipe]] = await db.query(
      `SELECT r.*, p.name AS product_name, p.price AS selling_price
       FROM recipes r JOIN products p ON p.id = r.product_id
       WHERE r.product_id=?`,
      [req.params.productId]
    );

    let items = [];
    if (recipe) {
      [items] = await db.query(
        `SELECT ri.*, i.name AS ingredient_name, i.unit AS ingredient_unit, i.unit_cost,
                (ri.qty * (1 + ri.waste_pct/100) * i.unit_cost) AS line_cost
         FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id
         WHERE ri.recipe_id=? ORDER BY ri.id`,
        [recipe.id]
      );
    }

    const totalCost = items.reduce((s, i) => s + parseFloat(i.line_cost || 0), 0);

    // Collect variant options and addons that have an ingredient link (informational)
    let variant_ingredients = [];
    if (recipe) {
      const [variantIngredients] = await db.query(
        `SELECT 'variant' AS type, vo.id, vo.name, vo.price_modifier AS price_effect,
                i.id AS ingredient_id, i.name AS ingredient_name,
                vo.ingredient_qty, vo.ingredient_unit
         FROM product_variant_groups vg
         JOIN product_variant_options vo ON vo.group_id = vg.id
         JOIN ingredients i ON i.id = vo.ingredient_id
         WHERE vg.product_id = ? AND vo.ingredient_id IS NOT NULL`,
        [req.params.productId]
      );
      const [addonIngredients] = await db.query(
        `SELECT 'addon' AS type, a.id, a.name, a.price AS price_effect,
                i.id AS ingredient_id, i.name AS ingredient_name,
                a.ingredient_qty, a.ingredient_unit
         FROM product_addon_groups ag
         JOIN product_addons a ON a.group_id = ag.id
         JOIN ingredients i ON i.id = a.ingredient_id
         WHERE ag.product_id = ? AND a.ingredient_id IS NOT NULL`,
        [req.params.productId]
      );
      variant_ingredients = [...variantIngredients, ...addonIngredients];
    }

    res.json({ recipe: recipe || null, items, total_cost: totalCost, variant_ingredients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recipes — create or update recipe for product
router.post('/:productId', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { notes, yield_qty, yield_unit, prep_time_min, items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Minimal 1 item bahan' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[product]] = await conn.query('SELECT id, name FROM products WHERE id=?', [req.params.productId]);
    if (!product) throw new Error('Produk tidak ditemukan');

    // Upsert recipe header
    const [[existing]] = await conn.query('SELECT id FROM recipes WHERE product_id=?', [req.params.productId]);
    let recipeId;
    if (existing) {
      recipeId = existing.id;
      await conn.query(
        'UPDATE recipes SET notes=?, yield_qty=?, yield_unit=?, prep_time_min=?, updated_by=? WHERE id=?',
        [notes || null, yield_qty || 1, yield_unit || 'porsi', prep_time_min || 0, req.user.id, recipeId]
      );
      await conn.query('DELETE FROM recipe_items WHERE recipe_id=?', [recipeId]);
    } else {
      const [r] = await conn.query(
        'INSERT INTO recipes (product_id, notes, yield_qty, yield_unit, prep_time_min, created_by) VALUES (?,?,?,?,?,?)',
        [req.params.productId, notes || null, yield_qty || 1, yield_unit || 'porsi', prep_time_min || 0, req.user.id]
      );
      recipeId = r.insertId;
    }

    // Insert items
    for (const item of items) {
      const [[ing]] = await conn.query('SELECT id, unit FROM ingredients WHERE id=?', [item.ingredient_id]);
      if (!ing) throw new Error(`Bahan ID ${item.ingredient_id} tidak ditemukan`);
      await conn.query(
        'INSERT INTO recipe_items (recipe_id, ingredient_id, qty, unit, waste_pct, notes) VALUES (?,?,?,?,?,?)',
        [recipeId, item.ingredient_id, parseFloat(item.qty), item.unit || ing.unit, parseFloat(item.waste_pct || 0), item.notes || null]
      );
    }

    // Recalculate and cache HPP
    const cost = await calcRecipeCost(recipeId);
    await conn.query('UPDATE recipes SET last_cost=? WHERE id=?', [cost, recipeId]);

    // Update product cost_price
    await conn.query('UPDATE products SET cost_price=? WHERE id=?', [cost, req.params.productId]);

    await conn.commit();
    await audit({ userId: req.user.id, action: 'save_recipe', tableName: 'recipes', recordId: recipeId, newValues: { product_id: req.params.productId, cost }, description: `Simpan resep ${product.name}, HPP: ${cost}` });

    const [[saved]] = await db.query('SELECT * FROM recipes WHERE id=?', [recipeId]);
    const [savedItems] = await db.query(
      `SELECT ri.*, i.name AS ingredient_name FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id WHERE ri.recipe_id=?`,
      [recipeId]
    );
    res.json({ recipe: saved, items: savedItems, cost });
  } catch (e) { await conn.rollback(); res.status(400).json({ error: e.message }); }
  finally { conn.release(); }
});

// DELETE /api/recipes/:productId
router.delete('/:productId', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    await db.query('DELETE FROM recipes WHERE product_id=?', [req.params.productId]);
    res.json({ message: 'Resep dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recipes/recalculate-all — recalculate all HPP from current ingredient costs
router.post('/recalculate-all', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const [recipes] = await db.query('SELECT id, product_id FROM recipes');
    let updated = 0;
    for (const r of recipes) {
      const cost = await calcRecipeCost(r.id);
      await db.query('UPDATE recipes SET last_cost=? WHERE id=?', [cost, r.id]);
      await db.query('UPDATE products SET cost_price=? WHERE id=?', [cost, r.product_id]);
      updated++;
    }
    res.json({ message: `${updated} resep diperbarui`, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/recipes/hpp-report — margin analysis all products with recipes
router.get('/hpp-report', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.id, p.name, p.price AS selling_price, p.cost_price AS hpp,
             p.price - p.cost_price AS gross_profit,
             CASE WHEN p.price > 0 THEN ROUND((p.price - p.cost_price) / p.price * 100, 2) ELSE 0 END AS margin_pct,
             r.id AS recipe_id, r.last_cost
      FROM products p
      LEFT JOIN recipes r ON r.product_id = p.id
      WHERE p.status = 'active'
      ORDER BY margin_pct ASC
    `);
    res.json({ products: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
