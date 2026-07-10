const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

// GET /api/ingredients
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { search, q, low_stock, limit } = req.query;
    const branch_id = req.query.branch_id || req.user.branch_id || null;
    const keyword = q || search;

    let sql, params = [];
    if (branch_id) {
      sql = `SELECT i.id, i.name, i.code, i.unit, i.unit_id,
                    CAST(i.unit_cost AS DECIMAL(10,2)) AS unit_cost,
                    COALESCE(ibs.stock_qty, i.stock_qty) AS stock_qty,
                    COALESCE(ibs.min_stock, i.min_stock) AS min_stock,
                    i.supplier_id, i.notes, i.is_active, i.created_at, i.updated_at,
                    s.name AS supplier_name
             FROM ingredients i
             LEFT JOIN ingredient_branch_stock ibs ON ibs.ingredient_id=i.id AND ibs.branch_id=?
             LEFT JOIN suppliers s ON s.id = i.supplier_id
             WHERE i.is_active = 1`;
      params.push(branch_id);
    } else {
      sql = `SELECT i.id, i.name, i.code, i.unit, i.unit_id,
                    CAST(i.unit_cost AS DECIMAL(10,2)) AS unit_cost,
                    i.stock_qty, i.min_stock,
                    i.supplier_id, i.notes, i.is_active, i.created_at, i.updated_at,
                    s.name AS supplier_name
             FROM ingredients i
             LEFT JOIN suppliers s ON s.id = i.supplier_id
             WHERE i.is_active = 1`;
    }
    if (keyword) { sql += ' AND (i.name LIKE ? OR i.code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
    if (low_stock === 'true') {
      sql += branch_id
        ? ' AND COALESCE(ibs.stock_qty, i.stock_qty) <= COALESCE(ibs.min_stock, i.min_stock)'
        : ' AND i.stock_qty <= i.min_stock';
    }
    sql += ' ORDER BY i.name';
    if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }
    const [rows] = await db.query(sql, params);
    res.json({ ingredients: rows, branch_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ingredients/:id
router.get('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[ing]] = await db.query('SELECT * FROM ingredients WHERE id=?', [req.params.id]);
    if (!ing) return res.status(404).json({ error: 'Bahan tidak ditemukan' });
    const [log] = await db.query(
      'SELECT * FROM ingredient_stock_log WHERE ingredient_id=? ORDER BY created_at DESC LIMIT 30',
      [req.params.id]
    );
    res.json({ ingredient: ing, stock_log: log });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ingredients
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { name, code, unit, unit_cost, stock_qty, min_stock, supplier_id, notes } = req.body;
  if (!name || !unit) return res.status(400).json({ error: 'name dan unit wajib' });
  try {
    const [r] = await db.query(
      'INSERT INTO ingredients (name, code, unit, unit_cost, stock_qty, min_stock, supplier_id, notes) VALUES (?,?,?,?,?,?,?,?)',
      [name, code || null, unit, unit_cost || 0, stock_qty || 0, min_stock || 0, supplier_id || null, notes || null]
    );
    // Log initial stock
    if (parseFloat(stock_qty) > 0) {
      await db.query(
        'INSERT INTO ingredient_stock_log (ingredient_id, movement_type, qty, qty_before, qty_after, note, created_by) VALUES (?,?,?,0,?,?,?)',
        [r.insertId, 'in', stock_qty, stock_qty, 'Stok awal', req.user.id]
      );
    }
    const [[ing]] = await db.query('SELECT * FROM ingredients WHERE id=?', [r.insertId]);
    await audit({ userId: req.user.id, action: 'create_ingredient', tableName: 'ingredients', recordId: r.insertId, newValues: { name, unit }, description: `Tambah bahan: ${name}` });
    res.status(201).json({ ingredient: ing });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Kode bahan sudah ada' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/ingredients/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, code, unit, unit_id, unit_cost, min_stock, supplier_id, notes, is_active } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (code !== undefined) { fields.push('code=?'); vals.push(code); }
  if (unit !== undefined) { fields.push('unit=?'); vals.push(unit); }
  if (unit_id !== undefined) { fields.push('unit_id=?'); vals.push(unit_id || null); }
  if (unit_cost !== undefined) { fields.push('unit_cost=?'); vals.push(unit_cost); }
  if (min_stock !== undefined) { fields.push('min_stock=?'); vals.push(min_stock); }
  if (supplier_id !== undefined) { fields.push('supplier_id=?'); vals.push(supplier_id); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes); }
  if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    vals.push(req.params.id);
    await db.query(`UPDATE ingredients SET ${fields.join(',')} WHERE id=?`, vals);
    const [[ing]] = await db.query(
      `SELECT i.*, u.name AS unit_name, u.symbol AS unit_symbol, u.type AS unit_type,
              u.base_unit_id, u.conversion_factor
       FROM ingredients i LEFT JOIN units u ON u.id = i.unit_id WHERE i.id=?`,
      [req.params.id]
    );
    res.json({ ingredient: ing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ingredients/compatible-units/:id — units compatible with this ingredient's base unit
router.get('/compatible-units/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[ing]] = await db.query(
      'SELECT i.unit_id, u.base_unit_id, u.type FROM ingredients i LEFT JOIN units u ON u.id = i.unit_id WHERE i.id=?',
      [req.params.id]
    );
    if (!ing) return res.status(404).json({ error: 'Bahan tidak ditemukan' });

    let compatibleUnits;
    if (ing.base_unit_id) {
      // Has a base unit — get all units with same base
      const [units] = await db.query(
        'SELECT * FROM units WHERE (base_unit_id = ? OR id = ?) AND is_active = 1 ORDER BY conversion_factor',
        [ing.base_unit_id, ing.base_unit_id]
      );
      compatibleUnits = units;
    } else if (ing.unit_id) {
      // Is a base unit itself — get all units that reference it
      const [units] = await db.query(
        'SELECT * FROM units WHERE (id = ? OR base_unit_id = ?) AND is_active = 1 ORDER BY conversion_factor',
        [ing.unit_id, ing.unit_id]
      );
      compatibleUnits = units;
    } else {
      // No unit linked — return all units of same type
      const [units] = await db.query('SELECT * FROM units WHERE is_active = 1 ORDER BY type, conversion_factor');
      compatibleUnits = units;
    }

    res.json({ units: compatibleUnits, base_unit_id: ing.base_unit_id || ing.unit_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ingredients/:id/adjust — with optional unit conversion (master units OR custom units)
router.post('/:id/adjust', authenticate, authorize('admin'), async (req, res) => {
  // custom_unit_symbol: use ingredient_unit_conversions table
  const { qty_change, input_qty, input_unit_id, custom_unit_symbol, movement_type = 'adjustment', note } = req.body;
  if (qty_change === undefined && input_qty === undefined) return res.status(400).json({ error: 'qty_change atau input_qty wajib' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[ing]] = await conn.query(
      'SELECT i.*, u.conversion_factor AS base_factor FROM ingredients i LEFT JOIN units u ON u.id = i.unit_id WHERE i.id=?',
      [req.params.id]
    );
    if (!ing) throw new Error('Bahan tidak ditemukan');

    // Calculate qty_change in base unit
    let finalQtyChange = parseFloat(qty_change || 0);
    let inputQtyFinal = null;
    let inputUnitIdFinal = null;

    if (input_qty !== undefined && custom_unit_symbol) {
      // Custom unit from ingredient_unit_conversions
      const [[conv]] = await conn.query(
        'SELECT * FROM ingredient_unit_conversions WHERE ingredient_id=? AND unit_symbol=? AND is_active=1',
        [req.params.id, custom_unit_symbol]
      );
      if (!conv) throw new Error(`Satuan "${custom_unit_symbol}" tidak ditemukan untuk bahan ini`);
      inputQtyFinal = parseFloat(input_qty);
      finalQtyChange = inputQtyFinal * parseFloat(conv.conversion_qty);
    } else if (input_qty !== undefined && input_unit_id) {
      // Convert input unit → ingredient base unit (master units)
      const [[inputUnit]] = await conn.query('SELECT * FROM units WHERE id=?', [input_unit_id]);
      const [[baseUnit]] = await conn.query('SELECT * FROM units WHERE id=?', [ing.unit_id]);

      inputQtyFinal = parseFloat(input_qty);
      inputUnitIdFinal = input_unit_id;

      if (inputUnit && baseUnit) {
        // Both units share same base: convert via conversion_factor
        if (inputUnit.base_unit_id === baseUnit.base_unit_id && inputUnit.base_unit_id !== null) {
          // input → base → target
          finalQtyChange = inputQtyFinal * parseFloat(inputUnit.conversion_factor) / parseFloat(baseUnit.conversion_factor);
        } else if (inputUnit.id === baseUnit.base_unit_id) {
          finalQtyChange = inputQtyFinal * parseFloat(inputUnit.conversion_factor);
        } else if (baseUnit.id === inputUnit.base_unit_id) {
          finalQtyChange = inputQtyFinal / parseFloat(inputUnit.conversion_factor);
        } else if (inputUnit.id === baseUnit.id) {
          finalQtyChange = inputQtyFinal; // same unit
        } else {
          // Fallback: use as-is
          finalQtyChange = inputQtyFinal;
        }
      } else {
        finalQtyChange = inputQtyFinal;
      }
    }

    const branch_id = req.body.branch_id || req.user.branch_id || null;

    let qtyBefore, qtyAfter;
    if (branch_id) {
      await conn.query(
        'INSERT INTO ingredient_branch_stock (ingredient_id, branch_id, stock_qty, min_stock) VALUES (?,?,0,0) ON DUPLICATE KEY UPDATE stock_qty=stock_qty',
        [req.params.id, branch_id]
      );
      const [[ibs]] = await conn.query(
        'SELECT stock_qty FROM ingredient_branch_stock WHERE ingredient_id=? AND branch_id=?',
        [req.params.id, branch_id]
      );
      qtyBefore = ibs ? parseFloat(ibs.stock_qty) : 0;
      qtyAfter  = parseFloat((qtyBefore + finalQtyChange).toFixed(3));
      await conn.query(
        'UPDATE ingredient_branch_stock SET stock_qty=? WHERE ingredient_id=? AND branch_id=?',
        [qtyAfter, req.params.id, branch_id]
      );
      // Sync global stock_qty = sum of all branches
      await conn.query(
        'UPDATE ingredients SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0) FROM ingredient_branch_stock WHERE ingredient_id=?) WHERE id=?',
        [req.params.id, req.params.id]
      );
    } else {
      qtyBefore = parseFloat(ing.stock_qty);
      qtyAfter  = parseFloat((qtyBefore + finalQtyChange).toFixed(3));
      await conn.query('UPDATE ingredients SET stock_qty=? WHERE id=?', [qtyAfter, req.params.id]);
    }

    const noteWithUnit = inputQtyFinal !== null
      ? `${note ? note + ' · ' : ''}Input: ${inputQtyFinal} ${(await conn.query('SELECT symbol FROM units WHERE id=?', [inputUnitIdFinal]))[0][0]?.symbol || ''} → ${finalQtyChange.toFixed(3)} ${ing.unit}`
      : note || null;

    await conn.query(
      'INSERT INTO ingredient_stock_log (ingredient_id, branch_id, movement_type, qty, qty_before, qty_after, input_qty, input_unit_id, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [req.params.id, branch_id, movement_type, finalQtyChange, qtyBefore, qtyAfter, inputQtyFinal, inputUnitIdFinal, noteWithUnit, req.user.id]
    );
    await conn.commit();
    res.json({
      ingredient_id: req.params.id,
      branch_id,
      qty_before: qtyBefore,
      qty_after: qtyAfter,
      qty_change: finalQtyChange,
      input_qty: inputQtyFinal,
      input_unit_id: inputUnitIdFinal,
    });
  } catch (e) { await conn.rollback(); res.status(400).json({ error: e.message }); }
  finally { conn.release(); }
});

// ─── CUSTOM UNIT CONVERSIONS per ingredient ───────────────────

// GET /api/ingredients/:id/units
router.get('/:id/units', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM ingredient_unit_conversions WHERE ingredient_id=? ORDER BY sort_order, conversion_qty',
      [req.params.id]
    );
    const [[ing]] = await db.query('SELECT unit FROM ingredients WHERE id=?', [req.params.id]);
    res.json({ conversions: rows, base_unit: ing?.unit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ingredients/:id/units
router.post('/:id/units', authenticate, authorize('admin'), async (req, res) => {
  const { unit_name, unit_symbol, conversion_qty, notes, sort_order } = req.body;
  if (!unit_name || !unit_symbol || !conversion_qty)
    return res.status(400).json({ error: 'unit_name, unit_symbol, conversion_qty wajib' });
  try {
    const [r] = await db.query(
      'INSERT INTO ingredient_unit_conversions (ingredient_id, unit_name, unit_symbol, conversion_qty, notes, sort_order) VALUES (?,?,?,?,?,?)',
      [req.params.id, unit_name, unit_symbol, parseFloat(conversion_qty), notes || null, sort_order || 0]
    );
    const [[row]] = await db.query('SELECT * FROM ingredient_unit_conversions WHERE id=?', [r.insertId]);
    res.status(201).json({ conversion: row });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Simbol "${unit_symbol}" sudah ada untuk bahan ini` });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/ingredients/units/:convId
router.put('/units/:convId', authenticate, authorize('admin'), async (req, res) => {
  const { unit_name, unit_symbol, conversion_qty, notes, sort_order, is_active } = req.body;
  const fields = [], vals = [];
  if (unit_name !== undefined) { fields.push('unit_name=?'); vals.push(unit_name); }
  if (unit_symbol !== undefined) { fields.push('unit_symbol=?'); vals.push(unit_symbol); }
  if (conversion_qty !== undefined) { fields.push('conversion_qty=?'); vals.push(parseFloat(conversion_qty)); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes); }
  if (sort_order !== undefined) { fields.push('sort_order=?'); vals.push(sort_order); }
  if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    vals.push(req.params.convId);
    await db.query(`UPDATE ingredient_unit_conversions SET ${fields.join(',')} WHERE id=?`, vals);
    const [[row]] = await db.query('SELECT * FROM ingredient_unit_conversions WHERE id=?', [req.params.convId]);
    res.json({ conversion: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ingredients/units/:convId
router.delete('/units/:convId', authenticate, authorize('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM ingredient_unit_conversions WHERE id=?', [req.params.convId]);
    res.json({ message: 'Satuan dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ingredients/:id/units/convert?unit_symbol=kln&qty=3
// Returns qty in base unit
router.get('/:id/units/convert', async (req, res) => {
  const { unit_symbol, qty } = req.query;
  if (!unit_symbol || !qty) return res.status(400).json({ error: 'unit_symbol dan qty wajib' });
  try {
    const [[conv]] = await db.query(
      'SELECT * FROM ingredient_unit_conversions WHERE ingredient_id=? AND unit_symbol=? AND is_active=1',
      [req.params.id, unit_symbol]
    );
    if (!conv) {
      // Check if it's the base unit symbol
      const [[ing]] = await db.query('SELECT unit FROM ingredients WHERE id=?', [req.params.id]);
      if (ing && ing.unit === unit_symbol) {
        return res.json({ base_qty: parseFloat(qty), unit_symbol, conversion_qty: 1 });
      }
      return res.status(404).json({ error: 'Satuan tidak ditemukan' });
    }
    const base_qty = parseFloat(qty) * parseFloat(conv.conversion_qty);
    res.json({ base_qty, unit_symbol, conversion_qty: parseFloat(conv.conversion_qty) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
