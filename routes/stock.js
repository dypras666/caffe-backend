const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

// ─── HELPERS ────────────────────────────────────────────────

const nextSeq = async (key) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE order_sequences SET last_number = last_number + 1 WHERE seq_key = ?', [key]);
    const [[row]] = await conn.query('SELECT last_number FROM order_sequences WHERE seq_key = ?', [key]);
    await conn.commit();
    return row.last_number;
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
};

const recordStockCard = async (conn, { product_id, branch_id, movement_type, reference_type, reference_id, qty_change, unit_cost, note, created_by }) => {
  // Per-branch stock
  if (branch_id) {
    await conn.query(
      `INSERT INTO product_branch_stock (product_id, branch_id, stock, min_stock)
       VALUES (?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE stock = stock`,
      [product_id, branch_id]
    );
    const [[bs]] = await conn.query(
      'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
      [product_id, branch_id]
    );
    const qty_before = bs ? bs.stock : 0;
    const qty_after  = qty_before + qty_change;
    await conn.query(
      'UPDATE product_branch_stock SET stock=? WHERE product_id=? AND branch_id=?',
      [qty_after, product_id, branch_id]
    );
    await conn.query(
      `INSERT INTO stock_cards (product_id, branch_id, movement_type, reference_type, reference_id, qty_before, qty_change, qty_after, unit_cost, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [product_id, branch_id, movement_type, reference_type || null, reference_id || null, qty_before, qty_change, qty_after, unit_cost || 0, note || null, created_by || null]
    );
    // Keep products.stock in sync with branch 1 (main branch) as fallback
    const [[main]] = await conn.query(
      'SELECT stock FROM product_branch_stock WHERE product_id=? ORDER BY branch_id ASC LIMIT 1',
      [product_id]
    );
    if (main) await conn.query('UPDATE products SET stock=? WHERE id=?', [main.stock, product_id]);
    return qty_after;
  }
  // Fallback: no branch — write to global (legacy)
  const [[prod]] = await conn.query('SELECT stock FROM products WHERE id = ?', [product_id]);
  const qty_before = prod ? prod.stock : 0;
  const qty_after  = qty_before + qty_change;
  await conn.query(
    `INSERT INTO stock_cards (product_id, movement_type, reference_type, reference_id, qty_before, qty_change, qty_after, unit_cost, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [product_id, movement_type, reference_type || null, reference_id || null, qty_before, qty_change, qty_after, unit_cost || 0, note || null, created_by || null]
  );
  await conn.query('UPDATE products SET stock=? WHERE id=?', [qty_after, product_id]);
  return qty_after;
};

// ─── SUPPLIERS ───────────────────────────────────────────────

router.get('/suppliers', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const { q, limit = 30 } = req.query;
    let sql = 'SELECT id, name, code, contact_person, phone, email, is_active FROM suppliers WHERE is_active=1';
    const params = [];
    if (q) { sql += ' AND (name LIKE ? OR code LIKE ? OR contact_person LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY name LIMIT ?';
    params.push(parseInt(limit));
    const [rows] = await db.query(sql, params);
    res.json({ suppliers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/suppliers', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { name, code, contact_person, phone, email, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama supplier wajib diisi' });
  try {
    const [r] = await db.query(
      'INSERT INTO suppliers (name, code, contact_person, phone, email, address, notes) VALUES (?,?,?,?,?,?,?)',
      [name, code || null, contact_person || null, phone || null, email || null, address || null, notes || null]
    );
    const [[sup]] = await db.query('SELECT * FROM suppliers WHERE id = ?', [r.insertId]);
    await audit({ userId: req.user.id, action: 'create_supplier', tableName: 'suppliers', recordId: r.insertId, newValues: { name, code }, ipAddress: req.ip, description: `Tambah supplier: ${name}` });
    res.status(201).json({ supplier: sup });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Kode supplier sudah ada' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/suppliers/:id', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { name, code, contact_person, phone, email, address, notes, is_active } = req.body;
  try {
    const fields = [], vals = [];
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (code !== undefined) { fields.push('code=?'); vals.push(code); }
    if (contact_person !== undefined) { fields.push('contact_person=?'); vals.push(contact_person); }
    if (phone !== undefined) { fields.push('phone=?'); vals.push(phone); }
    if (email !== undefined) { fields.push('email=?'); vals.push(email); }
    if (address !== undefined) { fields.push('address=?'); vals.push(address); }
    if (notes !== undefined) { fields.push('notes=?'); vals.push(notes); }
    if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: 'Tidak ada field' });
    vals.push(req.params.id);
    await db.query(`UPDATE suppliers SET ${fields.join(',')} WHERE id=?`, vals);
    const [[sup]] = await db.query('SELECT * FROM suppliers WHERE id=?', [req.params.id]);
    res.json({ supplier: sup });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/suppliers/:id', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    await db.query('DELETE FROM suppliers WHERE id=?', [req.params.id]);
    res.json({ message: 'Supplier dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STOCK CARD (Kartu Stok) ─────────────────────────────────

// GET /stock/card/:productId — full kartu stok for one product
router.get('/card/:productId', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const branch_id = req.query.branch_id || req.user.branch_id || null;

    const [[product]] = await db.query(
      'SELECT id, name, sku, stock, min_stock, unit, cost_price FROM products WHERE id=?',
      [req.params.productId]
    );
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });

    // Override stock/min_stock with branch-specific values
    if (branch_id) {
      const [[bs]] = await db.query(
        'SELECT stock, min_stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [req.params.productId, branch_id]
      );
      if (bs) { product.stock = bs.stock; product.min_stock = bs.min_stock; }
    }

    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Filter stock_cards by branch if available
    const branchWhere = branch_id ? ' AND sc.branch_id = ?' : '';
    const branchParams = branch_id ? [req.params.productId, branch_id] : [req.params.productId];

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM stock_cards sc WHERE sc.product_id=?${branchWhere}`,
      branchParams
    );
    const [cards] = await db.query(
      `SELECT sc.*, u.name AS created_by_name
       FROM stock_cards sc
       LEFT JOIN users u ON u.id = sc.created_by
       WHERE sc.product_id = ?${branchWhere}
       ORDER BY sc.created_at DESC, sc.id DESC
       LIMIT ? OFFSET ?`,
      [...branchParams, parseInt(limit), offset]
    );

    res.json({
      product,
      cards,
      branch_id,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /stock/cards — all stock cards, filterable
router.get('/cards', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const { product_id, movement_type, date_from, date_to, page = 1, limit = 30 } = req.query;
    const branch_id = req.query.branch_id || req.user.branch_id || null;
    let where = 'WHERE 1=1', params = [];
    if (branch_id) { where += ' AND sc.branch_id=?'; params.push(branch_id); }
    if (product_id) { where += ' AND sc.product_id=?'; params.push(product_id); }
    if (movement_type) { where += ' AND sc.movement_type=?'; params.push(movement_type); }
    if (date_from) { where += ' AND DATE(sc.created_at) >= ?'; params.push(date_from); }
    if (date_to) { where += ' AND DATE(sc.created_at) <= ?'; params.push(date_to); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM stock_cards sc ${where}`, params);
    const [cards] = await db.query(
      `SELECT sc.*, p.name AS product_name, p.sku, p.unit, u.name AS created_by_name
       FROM stock_cards sc
       LEFT JOIN products p ON p.id = sc.product_id
       LEFT JOIN users u ON u.id = sc.created_by
       ${where}
       ORDER BY sc.created_at DESC, sc.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ cards, pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /stock/adjustment — manual stock adjustment or waste
router.post('/adjustment', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { product_id, qty_change, movement_type = 'adjustment', note, unit_cost } = req.body;
  if (!product_id || qty_change === undefined) return res.status(400).json({ error: 'product_id dan qty_change wajib' });
  const validTypes = ['adjustment', 'waste', 'return', 'opname'];
  if (!validTypes.includes(movement_type)) return res.status(400).json({ error: 'movement_type tidak valid' });

  const branch_id = req.body.branch_id || req.user.branch_id || null;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const newStock = await recordStockCard(conn, {
      product_id, branch_id, movement_type, qty_change: parseInt(qty_change),
      unit_cost: unit_cost || 0, note, created_by: req.user.id,
    });
    await conn.commit();
    await audit({ userId: req.user.id, action: `stock_${movement_type}`, tableName: 'stock_cards', recordId: null, newValues: { product_id, qty_change: parseInt(qty_change), new_stock: newStock, movement_type }, ipAddress: req.ip, description: `Penyesuaian stok produk #${product_id}: ${parseInt(qty_change) > 0 ? '+' : ''}${qty_change} (${movement_type}). ${note || ''}`, severity: movement_type === 'waste' ? 'warning' : 'info' });
    res.json({ message: 'Stok disesuaikan', product_id, new_stock: newStock, qty_change });
  } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

// ─── PURCHASE ORDERS ─────────────────────────────────────────

router.get('/po', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    let where = 'WHERE 1=1', params = [];
    if (status) { where += ' AND po.status=?'; params.push(status); }
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM purchase_orders po ${where}`, params);
    const [pos] = await db.query(
      `SELECT po.*, s.name AS supplier_name, u.name AS created_by_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.created_by
       ${where}
       ORDER BY po.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ purchase_orders: pos, pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/po/:id', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const [[po]] = await db.query(
      `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id=?`,
      [req.params.id]
    );
    if (!po) return res.status(404).json({ error: 'PO tidak ditemukan' });
    const [items] = await db.query(
      `SELECT poi.* FROM purchase_order_items poi WHERE poi.po_id=?`,
      [req.params.id]
    );
    res.json({ purchase_order: { ...po, items } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/po', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { supplier_id, order_date, expected_date, notes, items } = req.body;
  if (!order_date || !items?.length) return res.status(400).json({ error: 'order_date dan items wajib' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const seq = await nextSeq('po');
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const po_number = `PO-${datePart}-${String(seq).padStart(5, '0')}`;

    let subtotal = 0;
    const resolvedItems = [];
    for (const item of items) {
      const [[prod]] = await conn.query('SELECT id, name, unit, unit_cost AS cost_price FROM ingredients WHERE id=?', [item.ingredient_id]);
      if (!prod) throw new Error(`Bahan baku ID ${item.ingredient_id} tidak ditemukan`);
      const unit_cost = parseFloat(item.unit_cost || prod.cost_price || 0);
      const lineSubtotal = unit_cost * parseInt(item.qty_ordered);
      subtotal += lineSubtotal;
      resolvedItems.push({ ...item, product_name: prod.name, unit: item.unit || prod.unit || 'pcs', unit_cost, subtotal: lineSubtotal, qty_received: 0 });
    }
    const total = subtotal;

    const poBranchId = req.body.branch_id || req.user.branch_id || null;
    const [r] = await conn.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, status, order_date, expected_date, subtotal, total, notes, created_by, branch_id)
       VALUES (?,?,  'draft',?,?,?,?,?,?,?)`,
      [po_number, supplier_id || null, order_date, expected_date || null, subtotal, total, notes || null, req.user.id, poBranchId]
    );
    const poId = r.insertId;

    for (const item of resolvedItems) {
      await conn.query(
        'INSERT INTO purchase_order_items (po_id, ingredient_id, product_name, unit, qty_ordered, qty_received, unit_cost, subtotal) VALUES (?,?,?,?,?,0,?,?)',
        [poId, item.ingredient_id, item.product_name, item.unit, item.qty_ordered, item.unit_cost, item.subtotal]
      );
    }

    await conn.commit();
    await audit({ userId: req.user.id, action: 'create_po', tableName: 'purchase_orders', recordId: poId, newValues: { po_number, supplier_id, total }, ipAddress: req.ip, description: `Buat PO ${po_number}, total ${total}` });
    const [[po]] = await db.query('SELECT * FROM purchase_orders WHERE id=?', [poId]);
    res.status(201).json({ purchase_order: { ...po, items: resolvedItems } });
  } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

// PUT /po/:id/status — change status, e.g. draft→ordered
router.put('/po/:id/status', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { status } = req.body;
  const valid = ['draft','ordered','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Status tidak valid' });
  try {
    const [[po]] = await db.query('SELECT id, status FROM purchase_orders WHERE id=?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'PO tidak ditemukan' });
    if (po.status === 'received' || po.status === 'cancelled') return res.status(400).json({ error: `Tidak bisa ubah dari status ${po.status}` });
    await db.query('UPDATE purchase_orders SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ message: 'Status PO diupdate', status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /po/:id/receive — terima barang (partial/full), update stock
router.post('/po/:id/receive', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { items, received_date, notes } = req.body;
  // items = [{ po_item_id, qty_received, unit_cost }]
  if (!items?.length) return res.status(400).json({ error: 'items wajib' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[po]] = await conn.query('SELECT * FROM purchase_orders WHERE id=?', [req.params.id]);
    if (!po) throw new Error('PO tidak ditemukan');
    if (po.status === 'cancelled') throw new Error('PO sudah dibatalkan');

    let allFullyReceived = true;
    for (const recv of items) {
      const [[poItem]] = await conn.query('SELECT * FROM purchase_order_items WHERE id=? AND po_id=?', [recv.po_item_id, req.params.id]);
      if (!poItem) continue;
      const newQtyReceived = poItem.qty_received + parseInt(recv.qty_received || 0);
      if (newQtyReceived > poItem.qty_ordered) throw new Error(`Jumlah terima melebihi PO untuk ${poItem.product_name}`);
      await conn.query('UPDATE purchase_order_items SET qty_received=? WHERE id=?', [newQtyReceived, poItem.id]);

      if (poItem.ingredient_id) {
        const qty = parseInt(recv.qty_received || 0);
        const branchId = po.branch_id || req.user.branch_id || null;

        if (branchId) {
          // Per-branch ingredient stock
          await conn.query(
            `INSERT INTO ingredient_branch_stock (ingredient_id, branch_id, stock_qty, min_stock)
             VALUES (?, ?, 0, 0)
             ON DUPLICATE KEY UPDATE stock_qty = stock_qty`,
            [poItem.ingredient_id, branchId]
          );
          const [[ibs]] = await conn.query(
            'SELECT stock_qty FROM ingredient_branch_stock WHERE ingredient_id=? AND branch_id=?',
            [poItem.ingredient_id, branchId]
          );
          const qtyBefore = ibs ? parseFloat(ibs.stock_qty) : 0;
          const qtyAfter  = qtyBefore + qty;
          await conn.query(
            'UPDATE ingredient_branch_stock SET stock_qty=? WHERE ingredient_id=? AND branch_id=?',
            [qtyAfter, poItem.ingredient_id, branchId]
          );
          await conn.query(
            'INSERT INTO ingredient_stock_log (ingredient_id, branch_id, movement_type, qty, qty_before, qty_after, reference_type, reference_id, note, created_by) VALUES (?,?,"in",?,?,?,"purchase_order",?,?,?)',
            [poItem.ingredient_id, branchId, qty, qtyBefore, qtyAfter, po.id, `Terima PO ${po.po_number}`, req.user.id]
          );
          // Sync global stock_qty with sum of all branches
          await conn.query(
            'UPDATE ingredients SET stock_qty = (SELECT COALESCE(SUM(stock_qty),0) FROM ingredient_branch_stock WHERE ingredient_id=?) WHERE id=?',
            [poItem.ingredient_id, poItem.ingredient_id]
          );
        } else {
          // Fallback: global
          await conn.query('UPDATE ingredients SET stock_qty = stock_qty + ? WHERE id = ?', [qty, poItem.ingredient_id]);
          await conn.query(
            'INSERT INTO ingredient_stock_log (ingredient_id, movement_type, qty, qty_before, qty_after, reference_type, reference_id, note, created_by) SELECT ?, "in", ?, stock_qty - ?, stock_qty, "purchase_order", ?, ?, ? FROM ingredients WHERE id = ?',
            [poItem.ingredient_id, qty, qty, po.id, `Terima PO ${po.po_number}`, req.user.id, poItem.ingredient_id]
          );
        }
      }
      if (newQtyReceived < poItem.qty_ordered) allFullyReceived = false;
    }

    const newStatus = allFullyReceived ? 'received' : 'partial';
    await conn.query(
      'UPDATE purchase_orders SET status=?, received_date=COALESCE(?,received_date), notes=COALESCE(?,notes) WHERE id=?',
      [newStatus, received_date || null, notes || null, req.params.id]
    );

    await conn.commit();
    await audit({ userId: req.user.id, action: 'receive_po', tableName: 'purchase_orders', recordId: parseInt(req.params.id), newValues: { status: newStatus }, ipAddress: req.ip, description: `Terima barang PO ${po.po_number}, status: ${newStatus}` });
    res.json({ message: `Barang diterima, status PO: ${newStatus}`, status: newStatus });
  } catch (e) { await conn.rollback(); res.status(400).json({ error: e.message }); }
  finally { conn.release(); }
});

// ─── STOCK OPNAME ────────────────────────────────────────────

router.get('/opname', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT so.*, u.name AS created_by_name FROM stock_opnames so
       LEFT JOIN users u ON u.id = so.created_by ORDER BY so.created_at DESC`
    );
    res.json({ opnames: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/opname/:id', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const [[opname]] = await db.query('SELECT * FROM stock_opnames WHERE id=?', [req.params.id]);
    if (!opname) return res.status(404).json({ error: 'Opname tidak ditemukan' });
    const [items] = await db.query(
      `SELECT soi.*, p.name AS product_name, p.sku, p.unit FROM stock_opname_items soi
       LEFT JOIN products p ON p.id = soi.product_id WHERE soi.opname_id=?`,
      [req.params.id]
    );
    res.json({ opname: { ...opname, items } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /opname — create opname (auto-fill system qty from products, scoped to branch)
router.post('/opname', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { opname_date, notes, product_ids } = req.body;
  if (!opname_date) return res.status(400).json({ error: 'opname_date wajib' });

  const branch_id = req.body.branch_id || req.user.branch_id || null;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const seq = await nextSeq('opname');
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const opname_number = `OPN-${datePart}-${String(seq).padStart(5, '0')}`;

    const [r] = await conn.query(
      `INSERT INTO stock_opnames (opname_number, status, opname_date, notes, created_by) VALUES (?, 'draft',?,?,?)`,
      [opname_number, opname_date, notes || null, req.user.id]
    );
    const opnameId = r.insertId;

    // Load products — use branch stock if branch_id provided
    let products;
    if (branch_id) {
      const branchFilter = product_ids?.length
        ? 'AND pbs.product_id IN (?)'
        : '';
      const params = [branch_id, ...(product_ids?.length ? [product_ids] : [])];
      [products] = await conn.query(
        `SELECT p.id, pbs.stock, p.cost_price
         FROM product_branch_stock pbs
         JOIN products p ON p.id = pbs.product_id
         WHERE pbs.branch_id=? AND p.status='active' ${branchFilter}`,
        params
      );
    } else if (product_ids?.length) {
      [products] = await conn.query('SELECT id, stock, cost_price FROM products WHERE id IN (?) AND status="active"', [product_ids]);
    } else {
      [products] = await conn.query('SELECT id, stock, cost_price FROM products WHERE status="active"');
    }

    for (const p of products) {
      await conn.query(
        'INSERT INTO stock_opname_items (opname_id, product_id, qty_system, qty_actual, unit_cost) VALUES (?,?,?,?,?)',
        [opnameId, p.id, p.stock, p.stock, p.cost_price || 0]
      );
    }

    await conn.commit();
    res.status(201).json({ opname: { id: opnameId, opname_number, status: 'draft', opname_date, item_count: products.length, branch_id } });
  } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

// PUT /opname/:id/items — update actual counts
router.put('/opname/:id/items', authenticate, authorize('admin', 'station'), async (req, res) => {
  const { items } = req.body; // [{ item_id, qty_actual, notes }]
  if (!items?.length) return res.status(400).json({ error: 'items wajib' });
  try {
    const [[opname]] = await db.query('SELECT status FROM stock_opnames WHERE id=?', [req.params.id]);
    if (!opname) return res.status(404).json({ error: 'Opname tidak ditemukan' });
    if (opname.status === 'completed' || opname.status === 'cancelled') {
      return res.status(400).json({ error: 'Opname sudah selesai/dibatalkan' });
    }
    await db.query('UPDATE stock_opnames SET status="in_progress" WHERE id=? AND status="draft"', [req.params.id]);
    for (const item of items) {
      await db.query('UPDATE stock_opname_items SET qty_actual=?, notes=? WHERE id=? AND opname_id=?',
        [item.qty_actual, item.notes || null, item.item_id, req.params.id]);
    }
    res.json({ message: 'Opname diupdate' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /opname/:id/approve — finalize opname, post adjustments to stock card
router.post('/opname/:id/approve', authenticate, authorize('admin', 'station'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[opname]] = await conn.query('SELECT * FROM stock_opnames WHERE id=?', [req.params.id]);
    if (!opname) throw new Error('Opname tidak ditemukan');
    if (opname.status === 'completed') throw new Error('Opname sudah selesai');
    if (opname.status === 'cancelled') throw new Error('Opname sudah dibatalkan');

    const [items] = await conn.query('SELECT * FROM stock_opname_items WHERE opname_id=?', [req.params.id]);

    const branch_id = req.user.branch_id || null;
    for (const item of items) {
      const diff = item.qty_actual - item.qty_system;
      if (diff !== 0) {
        await recordStockCard(conn, {
          product_id: item.product_id,
          branch_id,
          movement_type: 'opname',
          reference_type: 'stock_opname',
          reference_id: opname.id,
          qty_change: diff,
          unit_cost: item.unit_cost,
          note: `Hasil opname ${opname.opname_number}`,
          created_by: req.user.id,
        });
      }
    }

    await conn.query(
      'UPDATE stock_opnames SET status="completed", approved_by=? WHERE id=?',
      [req.user.id, req.params.id]
    );
    await conn.commit();

    const adjustedCount = items.filter(i => i.qty_actual !== i.qty_system).length;
    await audit({ userId: req.user.id, action: 'approve_opname', tableName: 'stock_opnames', recordId: parseInt(req.params.id), newValues: { status: 'completed', adjusted_items: adjustedCount }, ipAddress: req.ip, description: `Finalisasi opname ${opname.opname_number}, ${adjustedCount} item disesuaikan`, severity: 'warning' });
    res.json({ message: 'Opname selesai', adjusted_items: adjustedCount });
  } catch (e) { await conn.rollback(); res.status(400).json({ error: e.message }); }
  finally { conn.release(); }
});

// ─── STOCK SUMMARY ───────────────────────────────────────────

// GET /stock/summary — overview: low stock, stock value, etc
router.get('/summary', authenticate, authorize('admin', 'station'), async (req, res) => {
  try {
    const branch_id = req.query.branch_id || req.user.branch_id || null;

    let totals, lowStock, recentMovements;

    if (branch_id) {
      [[totals]] = await db.query(`
        SELECT
          COUNT(*) AS total_products,
          SUM(CASE WHEN pbs.stock <= pbs.min_stock AND pbs.min_stock > 0 THEN 1 ELSE 0 END) AS low_stock_count,
          SUM(CASE WHEN pbs.stock = 0 THEN 1 ELSE 0 END) AS out_of_stock,
          SUM(pbs.stock * COALESCE(p.cost_price, 0)) AS total_stock_value
        FROM product_branch_stock pbs
        JOIN products p ON p.id = pbs.product_id
        WHERE pbs.branch_id = ? AND p.status = 'active'
      `, [branch_id]);

      [lowStock] = await db.query(`
        SELECT p.id, p.name, p.sku, pbs.stock, pbs.min_stock, p.unit
        FROM product_branch_stock pbs
        JOIN products p ON p.id = pbs.product_id
        WHERE pbs.branch_id = ? AND pbs.stock <= pbs.min_stock AND pbs.min_stock > 0 AND p.status = 'active'
        ORDER BY pbs.stock ASC LIMIT 10
      `, [branch_id]);

      [recentMovements] = await db.query(`
        SELECT sc.*, p.name AS product_name, p.unit, u.name AS created_by_name
        FROM stock_cards sc
        LEFT JOIN products p ON p.id = sc.product_id
        LEFT JOIN users u ON u.id = sc.created_by
        WHERE sc.branch_id = ?
        ORDER BY sc.created_at DESC LIMIT 15
      `, [branch_id]);
    } else {
      [[totals]] = await db.query(`
        SELECT
          COUNT(*) AS total_products,
          SUM(CASE WHEN stock <= min_stock AND min_stock > 0 THEN 1 ELSE 0 END) AS low_stock_count,
          SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END) AS out_of_stock,
          SUM(stock * COALESCE(cost_price, 0)) AS total_stock_value
        FROM products WHERE status = 'active'
      `);
      [lowStock] = await db.query(`
        SELECT id, name, sku, stock, min_stock, unit FROM products
        WHERE stock <= min_stock AND min_stock > 0 AND status = 'active'
        ORDER BY stock ASC LIMIT 10
      `);
      [recentMovements] = await db.query(`
        SELECT sc.*, p.name AS product_name, p.unit, u.name AS created_by_name
        FROM stock_cards sc
        LEFT JOIN products p ON p.id = sc.product_id
        LEFT JOIN users u ON u.id = sc.created_by
        ORDER BY sc.created_at DESC LIMIT 15
      `);
    }

    res.json({ summary: totals, low_stock: lowStock, recent_movements: recentMovements, branch_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
