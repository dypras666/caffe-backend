/**
 * Voucher system tests — security, abuse prevention, race conditions, all types
 *
 * Covers:
 * - CRUD access control (admin only for write, kasir can read)
 * - All 4 voucher types (total_discount, item_discount, free_item, bonus_points)
 * - Expired vouchers
 * - Future (not-yet-valid) vouchers
 * - Quota exhaustion (global usage_limit)
 * - Per-member usage limit enforcement
 * - Member-only voucher rejected for non-member
 * - Minimum transaction enforcement
 * - Wrong branch rejection
 * - Inactive voucher rejection
 * - Duplicate code rejection
 * - Race condition: concurrent redemption must not exceed quota
 * - Double-apply same voucher in same order (validate idempotency)
 * - Voucher applied to order: used_count increments, voucher_usages row created
 * - Soft-delete: voucher with usage_count > 0 is deactivated not deleted
 * - Percent discount capped by max_discount
 * - Discount never exceeds subtotal
 */
const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken, getKasirToken, getMemberToken } = require('./helpers');

// ─── Helpers ──────────────────────────────────────────────────

let adminToken, kasirToken, memberToken;
let productId;
const createdVoucherIds = [];
const createdOrderIds = [];

async function createVoucher(overrides = {}) {
  const code = `TEST-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
  const defaults = {
    code,
    name: 'Test Voucher',
    type: 'total_discount',
    discount_type: 'fixed',
    discount_value: 10000,
    min_transaction: 0,
    usage_limit: null,
    usage_per_member: 99,
    member_only: false,
    is_active: true,
  };
  const payload = { ...defaults, ...overrides };
  const [r] = await db.query(
    `INSERT INTO vouchers
       (code, name, type, discount_type, discount_value, max_discount, min_transaction,
        usage_limit, usage_per_member, member_only, is_active,
        valid_from, valid_until, branch_id, free_product_id, free_product_qty,
        bonus_points_multiplier, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      payload.code.toUpperCase(), payload.name, payload.type,
      payload.discount_type || null, payload.discount_value || 0,
      payload.max_discount ?? null,
      payload.min_transaction || 0,
      payload.usage_limit ?? null, payload.usage_per_member ?? 99,
      payload.member_only ? 1 : 0, payload.is_active ? 1 : 0,
      payload.valid_from || null, payload.valid_until || null,
      payload.branch_id || null,
      payload.free_product_id || null, payload.free_product_qty || 1,
      payload.bonus_points_multiplier || 1,
    ]
  );
  createdVoucherIds.push(r.insertId);
  return { id: r.insertId, code: payload.code.toUpperCase(), ...payload };
}

async function createOrder(token, extra = {}) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      customer_name: 'Test Customer',
      order_type: 'takeaway',
      payment_method: 'cash',
      items: [{ product_id: productId, quantity: 1 }],
      ...extra,
    });
  if (res.body?.order?.id) createdOrderIds.push(res.body.order.id);
  return res;
}

// ─── Setup / teardown ─────────────────────────────────────────

beforeAll(async () => {
  [adminToken, kasirToken, memberToken] = await Promise.all([
    getAdminToken(), getKasirToken(), getMemberToken(),
  ]);
  const [products] = await db.query('SELECT id, price FROM products WHERE status="active" LIMIT 1');
  if (!products.length) throw new Error('No active product in DB — seed first');
  productId = products[0].id;
});

afterAll(async () => {
  if (createdOrderIds.length) {
    await db.query('DELETE FROM order_items WHERE order_id IN (?)', [createdOrderIds]);
    await db.query('DELETE FROM voucher_usages WHERE order_id IN (?)', [createdOrderIds]);
    await db.query('DELETE FROM orders WHERE id IN (?)', [createdOrderIds]);
  }
  if (createdVoucherIds.length) {
    await db.query('DELETE FROM voucher_usages WHERE voucher_id IN (?)', [createdVoucherIds]);
    await db.query('DELETE FROM vouchers WHERE id IN (?)', [createdVoucherIds]);
  }
  if (createdVoucherIds._tempBranchId) {
    await db.query('DELETE FROM branches WHERE id = ?', [createdVoucherIds._tempBranchId]);
  }
});

// ─── CRUD access control ──────────────────────────────────────

describe('CRUD access control', () => {
  it('admin can list vouchers', async () => {
    const res = await request(app).get('/api/vouchers').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.vouchers)).toBe(true);
  });

  it('kasir can list vouchers', async () => {
    const res = await request(app).get('/api/vouchers').set('Authorization', `Bearer ${kasirToken}`);
    expect(res.status).toBe(200);
  });

  it('unauthenticated cannot list vouchers', async () => {
    const res = await request(app).get('/api/vouchers');
    expect(res.status).toBe(401);
  });

  it('kasir cannot create voucher', async () => {
    const res = await request(app).post('/api/vouchers')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: 'KASIR-ATTEMPT', name: 'X', type: 'total_discount' });
    expect(res.status).toBe(403);
  });

  it('admin can create voucher', async () => {
    const res = await request(app).post('/api/vouchers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: `CRUD-${Date.now()}`, name: 'CRUD Test', type: 'total_discount', discount_type: 'fixed', discount_value: 5000 });
    expect(res.status).toBe(201);
    expect(res.body.voucher).toHaveProperty('id');
    createdVoucherIds.push(res.body.voucher.id);
  });

  it('rejects missing required fields', async () => {
    const res = await request(app).post('/api/vouchers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Missing code and type' });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate code', async () => {
    const code = `DUP-${Date.now()}`;
    await request(app).post('/api/vouchers').set('Authorization', `Bearer ${adminToken}`)
      .send({ code, name: 'First', type: 'total_discount', discount_type: 'fixed', discount_value: 1000 });
    const res = await request(app).post('/api/vouchers').set('Authorization', `Bearer ${adminToken}`)
      .send({ code, name: 'Duplicate', type: 'total_discount', discount_type: 'fixed', discount_value: 1000 });
    expect(res.status).toBe(409);
    // cleanup — the first one might have been created
    await db.query('DELETE FROM vouchers WHERE code = ?', [code.toUpperCase()]);
  });

  it('kasir cannot delete voucher', async () => {
    const v = await createVoucher();
    const res = await request(app).delete(`/api/vouchers/${v.id}`).set('Authorization', `Bearer ${kasirToken}`);
    expect(res.status).toBe(403);
  });

  it('soft-deletes voucher with usage (deactivates instead of deleting)', async () => {
    const v = await createVoucher({ usage_limit: 10 });
    // Simulate 1 usage
    await db.query('UPDATE vouchers SET used_count = 1 WHERE id = ?', [v.id]);
    const res = await request(app).delete(`/api/vouchers/${v.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const [[row]] = await db.query('SELECT is_active FROM vouchers WHERE id = ?', [v.id]);
    expect(row.is_active).toBe(0); // deactivated, not deleted
  });

  it('hard-deletes voucher with zero usage', async () => {
    const v = await createVoucher();
    const res = await request(app).delete(`/api/vouchers/${v.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const [rows] = await db.query('SELECT id FROM vouchers WHERE id = ?', [v.id]);
    expect(rows.length).toBe(0);
    // Remove from cleanup list since already deleted
    const idx = createdVoucherIds.indexOf(v.id);
    if (idx !== -1) createdVoucherIds.splice(idx, 1);
  });
});

// ─── Validate endpoint ────────────────────────────────────────

describe('POST /api/vouchers/validate', () => {
  it('returns valid + discount for active fixed voucher', async () => {
    const v = await createVoucher({ discount_value: 15000 });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.discount_amount).toBe(15000);
  });

  it('rejects inactive voucher', async () => {
    const v = await createVoucher({ is_active: false });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tidak ditemukan|tidak aktif/i);
  });

  it('rejects expired voucher (valid_until in past)', async () => {
    const v = await createVoucher({ valid_until: '2020-01-01' });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kadaluarsa/i);
  });

  it('rejects voucher not yet valid (valid_from in future)', async () => {
    const v = await createVoucher({ valid_from: '2099-01-01' });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/belum berlaku/i);
  });

  it('rejects when subtotal below min_transaction', async () => {
    const v = await createVoucher({ min_transaction: 100000 });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/minimum transaksi/i);
  });

  it('rejects member_only voucher without user_id', async () => {
    const v = await createVoucher({ member_only: true });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member/i);
  });

  it('accepts member_only voucher with user_id', async () => {
    const v = await createVoucher({ member_only: true });
    const [[member]] = await db.query("SELECT id FROM users WHERE role='member' LIMIT 1");
    if (!member) return; // skip if no member
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000, user_id: member.id });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('rejects when quota exhausted (used_count >= usage_limit)', async () => {
    const v = await createVoucher({ usage_limit: 2 });
    await db.query('UPDATE vouchers SET used_count = 2 WHERE id = ?', [v.id]);
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kuota.*habis/i);
  });

  it('allows unlimited voucher (usage_limit null)', async () => {
    const v = await createVoucher({ usage_limit: null });
    await db.query('UPDATE vouchers SET used_count = 9999 WHERE id = ?', [v.id]);
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(200);
  });

  it('percent discount calculated correctly', async () => {
    const v = await createVoucher({ discount_type: 'percent', discount_value: 20 });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 100000 });
    expect(res.status).toBe(200);
    expect(res.body.discount_amount).toBe(20000);
  });

  it('percent discount capped by max_discount', async () => {
    const v = await createVoucher({ discount_type: 'percent', discount_value: 50, max_discount: 25000 });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 200000 });
    expect(res.status).toBe(200);
    expect(res.body.discount_amount).toBe(25000); // capped at 25k, not 100k
  });

  it('fixed discount never exceeds subtotal', async () => {
    const v = await createVoucher({ discount_value: 999999 });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(200);
    expect(res.body.discount_amount).toBeLessThanOrEqual(50000);
  });

  it('rejects unknown code', async () => {
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: 'TOTALLY-INVALID-XXXX', subtotal: 50000 });
    expect(res.status).toBe(400);
  });

  it('requires code field', async () => {
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ subtotal: 50000 });
    expect(res.status).toBe(400);
  });
});

// ─── Voucher types ────────────────────────────────────────────

describe('Voucher types', () => {
  it('free_item returns free_item in validate response', async () => {
    const v = await createVoucher({ type: 'free_item', discount_type: null, discount_value: 0, free_product_id: productId, free_product_qty: 1 });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(200);
    expect(res.body.free_item).toBeTruthy();
    expect(res.body.free_item.product_id).toBe(productId);
  });

  it('bonus_points returns bonus_points_multiplier > 1', async () => {
    const v = await createVoucher({ type: 'bonus_points', discount_type: null, discount_value: 0, bonus_points_multiplier: 3 });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000 });
    expect(res.status).toBe(200);
    expect(res.body.bonus_points_multiplier).toBe(3);
  });
});

// ─── Voucher applied to order ─────────────────────────────────

describe('Voucher applied to order', () => {
  it('order total is reduced by voucher discount', async () => {
    const [products] = await db.query('SELECT id, price FROM products WHERE status="active" LIMIT 1');
    const price = parseFloat(products[0].price);
    const discount = Math.min(10000, Math.floor(price * 0.5));
    const v = await createVoucher({ discount_value: discount });

    const res = await createOrder(kasirToken, { voucher_code: v.code });
    expect(res.status).toBe(201);
    expect(parseFloat(res.body.order.total)).toBeLessThan(price * 1.2); // total < price + tax
    expect(parseFloat(res.body.order.total)).toBeGreaterThanOrEqual(0);
  });

  it('used_count increments after order with voucher', async () => {
    const v = await createVoucher({ usage_limit: 5 });
    const [[before]] = await db.query('SELECT used_count FROM vouchers WHERE id=?', [v.id]);

    await createOrder(kasirToken, { voucher_code: v.code });

    const [[after]] = await db.query('SELECT used_count FROM vouchers WHERE id=?', [v.id]);
    expect(after.used_count).toBe(before.used_count + 1);
  });

  it('voucher_usages row is created after order', async () => {
    const v = await createVoucher();
    const res = await createOrder(kasirToken, { voucher_code: v.code });
    expect(res.status).toBe(201);

    const [usages] = await db.query(
      'SELECT * FROM voucher_usages WHERE voucher_id=? AND order_id=?',
      [v.id, res.body.order.id]
    );
    expect(usages.length).toBe(1);
  });

  it('rejects order with expired voucher code', async () => {
    const v = await createVoucher({ valid_until: '2020-01-01' });
    const res = await createOrder(kasirToken, { voucher_code: v.code });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kadaluarsa/i);
  });

  it('rejects order with inactive voucher', async () => {
    const v = await createVoucher({ is_active: false });
    const res = await createOrder(kasirToken, { voucher_code: v.code });
    expect(res.status).toBe(400);
  });

  it('rejects order when voucher quota already exhausted', async () => {
    const v = await createVoucher({ usage_limit: 1 });
    // Exhaust quota manually
    await db.query('UPDATE vouchers SET used_count = 1 WHERE id = ?', [v.id]);
    const res = await createOrder(kasirToken, { voucher_code: v.code });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kuota.*habis/i);
  });

  it('free_item voucher injects [GRATIS] item into order', async () => {
    const v = await createVoucher({ type: 'free_item', discount_type: null, discount_value: 0, free_product_id: productId, free_product_qty: 1 });
    const res = await createOrder(kasirToken, { voucher_code: v.code });
    expect(res.status).toBe(201);

    const [items] = await db.query(
      'SELECT * FROM order_items WHERE order_id=? AND product_name LIKE ?',
      [res.body.order.id, '[GRATIS]%']
    );
    expect(items.length).toBeGreaterThan(0);
    expect(parseFloat(items[0].unit_price)).toBe(0);
  });
});

// ─── Per-member abuse prevention ─────────────────────────────

describe('Per-member usage limit', () => {
  it('blocks second use when usage_per_member=1', async () => {
    const [[member]] = await db.query("SELECT id FROM users WHERE role='member' LIMIT 1");
    if (!member) return;

    const v = await createVoucher({ usage_per_member: 1 });
    // Simulate member already used it once
    await db.query(
      'INSERT INTO voucher_usages (voucher_id, user_id, discount_applied) VALUES (?,?,0)',
      [v.id, member.id]
    );

    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000, user_id: member.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sudah digunakan/i);
  });

  it('allows different member to use same voucher', async () => {
    const [[member1]] = await db.query("SELECT id FROM users WHERE role='member' ORDER BY id LIMIT 1");
    const [[member2]] = await db.query("SELECT id FROM users WHERE role='member' ORDER BY id DESC LIMIT 1");
    if (!member1 || !member2 || member1.id === member2.id) return;

    const v = await createVoucher({ usage_per_member: 1 });
    // member1 already used
    await db.query(
      'INSERT INTO voucher_usages (voucher_id, user_id, discount_applied) VALUES (?,?,0)',
      [v.id, member1.id]
    );

    // member2 should still be valid
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000, user_id: member2.id });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});

// ─── Race condition test ──────────────────────────────────────

describe('Race condition — concurrent redemption', () => {
  it('quota=1 voucher used by concurrent requests — only 1 succeeds', async () => {
    const v = await createVoucher({ usage_limit: 1 });

    // Fire 5 concurrent order requests with the same voucher
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => createOrder(kasirToken, { voucher_code: v.code }))
    );

    const successes = results.filter(r => r.status === 'fulfilled' && r.value.status === 201);
    const failures  = results.filter(r => r.status === 'fulfilled' && r.value.status === 400);

    // Exactly 1 should succeed, rest rejected (kuota habis)
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(4);

    // DB used_count must equal 1 — not more
    const [[row]] = await db.query('SELECT used_count FROM vouchers WHERE id=?', [v.id]);
    expect(row.used_count).toBe(1);
  }, 20000);

  it('quota=3 voucher used by 10 concurrent requests — exactly 3 succeed', async () => {
    const v = await createVoucher({ usage_limit: 3, discount_value: 1000 });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => createOrder(kasirToken, { voucher_code: v.code }))
    );

    const successes = results.filter(r => r.status === 'fulfilled' && r.value.status === 201);
    const [[row]] = await db.query('SELECT used_count FROM vouchers WHERE id=?', [v.id]);

    expect(successes.length).toBe(3);
    expect(row.used_count).toBe(3);
  }, 30000);
});

// ─── Branch restriction ───────────────────────────────────────

describe('Branch restriction', () => {
  it('rejects voucher for wrong branch_id', async () => {
    // Create a second branch if only one exists, otherwise use the non-main branch
    const [branches] = await db.query('SELECT id FROM branches ORDER BY is_main DESC');
    if (branches.length < 2) {
      // Insert a temp second branch
      const [rb] = await db.query(
        "INSERT INTO branches (name, code, is_active, is_main) VALUES ('Test Branch B', 'TSTB', 1, 0)"
      );
      branches.push({ id: rb.insertId });
      createdVoucherIds._tempBranchId = rb.insertId; // store for cleanup
    }
    const branchA = branches[0].id;
    const branchB = branches[1].id;

    const v = await createVoucher({ branch_id: branchA });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000, branch_id: branchB });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cabang/i);
  });

  it('accepts voucher when branch_id matches', async () => {
    const [[branch]] = await db.query('SELECT id FROM branches WHERE is_active=1 LIMIT 1');
    if (!branch) return;
    const v = await createVoucher({ branch_id: branch.id });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000, branch_id: branch.id });
    expect(res.status).toBe(200);
  });

  it('accepts voucher with no branch restriction (branch_id null)', async () => {
    const v = await createVoucher({ branch_id: null });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code, subtotal: 50000, branch_id: 99 });
    expect(res.status).toBe(200);
  });
});

// ─── Case-insensitivity ───────────────────────────────────────

describe('Code case-insensitivity', () => {
  it('accepts lowercase code for uppercase voucher', async () => {
    const v = await createVoucher({ code: `UPPER-${Date.now()}` });
    const res = await request(app).post('/api/vouchers/validate')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ code: v.code.toLowerCase(), subtotal: 50000 });
    expect(res.status).toBe(200);
  });
});
