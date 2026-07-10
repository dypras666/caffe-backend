const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// ─── CRUD (admin) ─────────────────────────────────────────────

// GET /api/vouchers — list all (admin/kasir)
router.get('/', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  try {
    const { search, is_active, type } = req.query;
    let sql = `SELECT v.*, p.name AS free_product_name, b.name AS branch_name
               FROM vouchers v
               LEFT JOIN products p ON p.id = v.free_product_id
               LEFT JOIN branches b ON b.id = v.branch_id
               WHERE 1=1`;
    const params = [];
    if (search) { sql += ' AND (v.code LIKE ? OR v.name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (is_active !== undefined) { sql += ' AND v.is_active = ?'; params.push(is_active === 'true' ? 1 : 0); }
    if (type) { sql += ' AND v.type = ?'; params.push(type); }
    sql += ' ORDER BY v.created_at DESC';
    const [rows] = await db.query(sql, params);
    res.json({ vouchers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vouchers/:id
router.get('/:id', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  try {
    const [[v]] = await db.query(
      `SELECT v.*, p.name AS free_product_name, b.name AS branch_name
       FROM vouchers v
       LEFT JOIN products p ON p.id = v.free_product_id
       LEFT JOIN branches b ON b.id = v.branch_id
       WHERE v.id = ?`, [req.params.id]
    );
    if (!v) return res.status(404).json({ error: 'Voucher tidak ditemukan' });
    const [usages] = await db.query(
      `SELECT vu.*, o.order_number, u.name AS user_name
       FROM voucher_usages vu
       LEFT JOIN orders o ON o.id = vu.order_id
       LEFT JOIN users u ON u.id = vu.user_id
       WHERE vu.voucher_id = ? ORDER BY vu.created_at DESC LIMIT 50`, [req.params.id]
    );
    res.json({ voucher: v, usages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vouchers
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const {
    code, name, description, type, discount_type, discount_value,
    free_product_id, free_product_qty, bonus_points_multiplier,
    min_transaction, max_discount, branch_id, member_only,
    usage_limit, usage_per_member, valid_from, valid_until,
  } = req.body;
  if (!code || !name || !type) return res.status(400).json({ error: 'code, name, type wajib' });
  try {
    const [r] = await db.query(
      `INSERT INTO vouchers
         (code, name, description, type, discount_type, discount_value,
          free_product_id, free_product_qty, bonus_points_multiplier,
          min_transaction, max_discount, branch_id, member_only,
          usage_limit, usage_per_member, valid_from, valid_until, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        code.toUpperCase(), name, description || null, type,
        discount_type || null, parseFloat(discount_value || 0),
        free_product_id || null, parseInt(free_product_qty || 1),
        parseFloat(bonus_points_multiplier || 1),
        parseFloat(min_transaction || 0), max_discount ? parseFloat(max_discount) : null,
        branch_id || null, member_only ? 1 : 0,
        usage_limit ? parseInt(usage_limit) : null,
        parseInt(usage_per_member || 1),
        valid_from || null, valid_until || null,
        req.user.id,
      ]
    );
    const [[v]] = await db.query('SELECT * FROM vouchers WHERE id = ?', [r.insertId]);
    res.status(201).json({ voucher: v });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Kode voucher sudah ada' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/vouchers/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const allowed = ['name','description','discount_type','discount_value','free_product_id',
    'free_product_qty','bonus_points_multiplier','min_transaction','max_discount',
    'branch_id','member_only','usage_limit','usage_per_member','valid_from','valid_until','is_active'];
  const fields = [], vals = [];
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      fields.push(`${f}=?`);
      vals.push(req.body[f] === '' ? null : req.body[f]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Tidak ada perubahan' });
  try {
    vals.push(req.params.id);
    await db.query(`UPDATE vouchers SET ${fields.join(',')}, updated_at=NOW() WHERE id=?`, vals);
    const [[v]] = await db.query('SELECT * FROM vouchers WHERE id=?', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'Voucher tidak ditemukan' });
    res.json({ voucher: v });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/vouchers/:id
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[v]] = await db.query('SELECT id, used_count FROM vouchers WHERE id=?', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'Voucher tidak ditemukan' });
    if (v.used_count > 0) {
      // soft delete — nonaktifkan saja
      await db.query('UPDATE vouchers SET is_active=0 WHERE id=?', [req.params.id]);
      return res.json({ message: 'Voucher dinonaktifkan (sudah pernah digunakan)' });
    }
    await db.query('DELETE FROM vouchers WHERE id=?', [req.params.id]);
    res.json({ message: 'Voucher dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Validate (kasir/member pakai) ───────────────────────────

// POST /api/vouchers/validate — cek voucher sebelum apply ke order
router.post('/validate', authenticate, async (req, res) => {
  const { code, subtotal, branch_id, user_id } = req.body;
  if (!code) return res.status(400).json({ error: 'code wajib' });
  try {
    const result = await validateVoucher(code, subtotal || 0, branch_id || null, user_id || null);
    if (!result.valid) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.validateVoucher = validateVoucher;
module.exports.redeemVoucher = redeemVoucher;

// ─── Shared validation helper ─────────────────────────────────
async function validateVoucher(code, subtotal, branchId, userId) {
  const [[v]] = await db.query(
    `SELECT v.*, p.name AS free_product_name, p.price AS free_product_price
     FROM vouchers v LEFT JOIN products p ON p.id = v.free_product_id
     WHERE v.code = ? AND v.is_active = 1`,
    [code.toUpperCase()]
  );
  if (!v) return { valid: false, error: 'Voucher tidak ditemukan atau tidak aktif' };

  const now = new Date();
  if (v.valid_from && new Date(v.valid_from) > now) return { valid: false, error: 'Voucher belum berlaku' };
  if (v.valid_until && new Date(v.valid_until) < now) return { valid: false, error: 'Voucher sudah kadaluarsa' };
  if (v.usage_limit !== null && v.used_count >= v.usage_limit) return { valid: false, error: 'Kuota voucher sudah habis' };
  if (v.min_transaction > 0 && subtotal < v.min_transaction) {
    return { valid: false, error: `Minimum transaksi Rp ${Number(v.min_transaction).toLocaleString('id')}` };
  }
  if (v.branch_id && branchId && v.branch_id !== parseInt(branchId)) {
    return { valid: false, error: 'Voucher tidak berlaku di cabang ini' };
  }
  if (v.member_only && !userId) return { valid: false, error: 'Voucher hanya untuk member' };

  // Cek usage per member
  if (userId && v.usage_per_member > 0) {
    const [[{ cnt }]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM voucher_usages WHERE voucher_id=? AND user_id=?',
      [v.id, userId]
    );
    if (cnt >= v.usage_per_member) return { valid: false, error: `Voucher sudah digunakan ${cnt} kali (maks ${v.usage_per_member}x per member)` };
  }

  // Hitung efek
  let discountAmount = 0;
  let freeItem = null;
  let bonusPointsMultiplier = 1;

  if (v.type === 'total_discount' || v.type === 'item_discount') {
    if (v.discount_type === 'percent') {
      discountAmount = Math.floor(subtotal * parseFloat(v.discount_value) / 100);
      if (v.max_discount) discountAmount = Math.min(discountAmount, parseFloat(v.max_discount));
    } else {
      discountAmount = Math.min(parseFloat(v.discount_value), subtotal);
    }
  } else if (v.type === 'free_item' && v.free_product_id) {
    freeItem = {
      product_id: v.free_product_id,
      product_name: v.free_product_name,
      price: parseFloat(v.free_product_price || 0),
      qty: parseInt(v.free_product_qty || 1),
    };
  } else if (v.type === 'bonus_points') {
    bonusPointsMultiplier = parseFloat(v.bonus_points_multiplier || 1);
  }

  return {
    valid: true,
    voucher_id: v.id,
    code: v.code,
    name: v.name,
    type: v.type,
    discount_amount: discountAmount,
    free_item: freeItem,
    bonus_points_multiplier: bonusPointsMultiplier,
    description: v.description,
  };
}

// Atomic: validate + lock + increment in one transaction — prevents race conditions
async function redeemVoucher(code, subtotal, branchId, userId, orderId, createdBy) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the voucher row for this transaction
    const [[v]] = await conn.query(
      `SELECT v.*, p.name AS free_product_name, p.price AS free_product_price
       FROM vouchers v LEFT JOIN products p ON p.id = v.free_product_id
       WHERE v.code = ? AND v.is_active = 1 FOR UPDATE`,
      [code.toUpperCase()]
    );

    if (!v) { await conn.rollback(); return { ok: false, error: 'Voucher tidak ditemukan atau tidak aktif' }; }

    const now = new Date();
    if (v.valid_from && new Date(v.valid_from) > now) { await conn.rollback(); return { ok: false, error: 'Voucher belum berlaku' }; }
    if (v.valid_until && new Date(v.valid_until) < now) { await conn.rollback(); return { ok: false, error: 'Voucher sudah kadaluarsa' }; }

    // Quota check AFTER lock — prevents race condition
    if (v.usage_limit !== null && v.used_count >= v.usage_limit) {
      await conn.rollback();
      return { ok: false, error: 'Kuota voucher sudah habis' };
    }
    if (v.min_transaction > 0 && subtotal < v.min_transaction) {
      await conn.rollback();
      return { ok: false, error: `Minimum transaksi Rp ${Number(v.min_transaction).toLocaleString('id')}` };
    }
    if (v.branch_id && branchId && v.branch_id !== parseInt(branchId)) {
      await conn.rollback();
      return { ok: false, error: 'Voucher tidak berlaku di cabang ini' };
    }
    if (v.member_only && !userId) {
      await conn.rollback();
      return { ok: false, error: 'Voucher hanya untuk member' };
    }

    // Per-member quota check AFTER lock
    if (userId && v.usage_per_member > 0) {
      const [[{ cnt }]] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM voucher_usages WHERE voucher_id=? AND user_id=?',
        [v.id, userId]
      );
      if (cnt >= v.usage_per_member) {
        await conn.rollback();
        return { ok: false, error: `Voucher sudah digunakan ${cnt} kali (maks ${v.usage_per_member}x per member)` };
      }
    }

    // Calculate effect
    let discountAmount = 0;
    let freeItem = null;
    let bonusPointsMultiplier = 1;

    if (v.type === 'total_discount' || v.type === 'item_discount') {
      if (v.discount_type === 'percent') {
        discountAmount = Math.floor(subtotal * parseFloat(v.discount_value) / 100);
        if (v.max_discount) discountAmount = Math.min(discountAmount, parseFloat(v.max_discount));
      } else {
        discountAmount = Math.min(parseFloat(v.discount_value), subtotal);
      }
    } else if (v.type === 'free_item' && v.free_product_id) {
      freeItem = {
        product_id: v.free_product_id,
        product_name: v.free_product_name,
        price: parseFloat(v.free_product_price || 0),
        qty: parseInt(v.free_product_qty || 1),
      };
    } else if (v.type === 'bonus_points') {
      bonusPointsMultiplier = parseFloat(v.bonus_points_multiplier || 1);
    }

    // Atomically increment used_count and record usage
    await conn.query('UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?', [v.id]);
    await conn.query(
      'INSERT INTO voucher_usages (voucher_id, order_id, user_id, discount_applied, free_product_id, bonus_points) VALUES (?,?,?,?,?,?)',
      [v.id, orderId, userId || createdBy, discountAmount, freeItem?.product_id || null, 0]
    );

    await conn.commit();

    return {
      ok: true,
      voucher_id: v.id,
      code: v.code,
      name: v.name,
      type: v.type,
      discount_amount: discountAmount,
      free_item: freeItem,
      bonus_points_multiplier: bonusPointsMultiplier,
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
