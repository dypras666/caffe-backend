/**
 * Branch Stock Isolation Tests
 *
 * Verifies that:
 * 1. Stock is tracked independently per branch (product_branch_stock)
 * 2. Kasir from branch A cannot see or affect branch B's stock
 * 3. Order creation deducts stock from the correct branch
 * 4. Admin can view/adjust stock across all branches
 * 5. Ingredient stock is also isolated per branch
 * 6. GET /products returns branch-scoped stock when branch_id provided
 */

const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const bcrypt = require('bcryptjs');

// ─── Test fixtures ────────────────────────────────────────────

let branchA, branchB;
let kasirAToken, kasirBToken, adminToken;
let kasirAId, kasirBId;
let productId, ingredientId;
const STOCK_A = 50;
const STOCK_B = 30;

const login = async (email, password) => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (!res.body.token) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
};

beforeAll(async () => {
  // Get admin token
  adminToken = await login('admin@cafeazzura.com', 'admin123');

  // Create two test branches
  const rA = await request(app).post('/api/branches')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Test Branch A', code: `TBA-${Date.now()}`, city: 'Jakarta' });
  expect(rA.status).toBe(201);
  branchA = rA.body.branch;

  const rB = await request(app).post('/api/branches')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Test Branch B', code: `TBB-${Date.now()}`, city: 'Surabaya' });
  expect(rB.status).toBe(201);
  branchB = rB.body.branch;

  // Create kasir for each branch
  const hashPw = await bcrypt.hash('test123', 10);
  const [rUA] = await db.query(
    'INSERT INTO users (name, email, password, role, branch_id, status) VALUES (?,?,?,?,?,?)',
    [`Kasir A ${Date.now()}`, `kasir.a.${Date.now()}@test.com`, hashPw, 'kasir', branchA.id, 'active']
  );
  kasirAId = rUA.insertId;
  kasirAToken = await login(`kasir.a.${Date.now() - 5}@test.com`, 'test123').catch(async () => {
    // Re-fetch email since Date.now() may differ
    const [[u]] = await db.query('SELECT email FROM users WHERE id=?', [kasirAId]);
    return login(u.email, 'test123');
  });
  // Simpler: just log in directly
  const [[uA]] = await db.query('SELECT email FROM users WHERE id=?', [kasirAId]);
  kasirAToken = await login(uA.email, 'test123');

  const [rUB] = await db.query(
    'INSERT INTO users (name, email, password, role, branch_id, status) VALUES (?,?,?,?,?,?)',
    [`Kasir B ${Date.now()}`, `kasir.b.${Date.now()}@test.com`, hashPw, 'kasir', branchB.id, 'active']
  );
  kasirBId = rUB.insertId;
  const [[uB]] = await db.query('SELECT email FROM users WHERE id=?', [kasirBId]);
  kasirBToken = await login(uB.email, 'test123');

  // Create a test product
  const rP = await request(app).post('/api/products')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      name: `BranchStockTest ${Date.now()}`,
      price: 15000,
      status: 'active',
      is_available: true,
      stock: 0,
    });
  expect([200, 201]).toContain(rP.status);
  productId = rP.body.product?.id || rP.body.id;

  // Create a test ingredient
  const rI = await request(app).post('/api/ingredients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `TestIng ${Date.now()}`, unit: 'kg', unit_cost: 5000, stock_qty: 0 });
  expect([200, 201]).toContain(rI.status);
  ingredientId = rI.body.ingredient?.id;

  // Seed branch stock for product
  await db.query(
    `INSERT INTO product_branch_stock (product_id, branch_id, stock, min_stock)
     VALUES (?,?,?,0),(?,?,?,0)
     ON DUPLICATE KEY UPDATE stock=VALUES(stock)`,
    [productId, branchA.id, STOCK_A, productId, branchB.id, STOCK_B]
  );

  // Seed branch stock for ingredient
  await db.query(
    `INSERT INTO ingredient_branch_stock (ingredient_id, branch_id, stock_qty, min_stock)
     VALUES (?,?,?,0),(?,?,?,0)
     ON DUPLICATE KEY UPDATE stock_qty=VALUES(stock_qty)`,
    [ingredientId, branchA.id, 100, ingredientId, branchB.id, 60]
  );
});

afterAll(async () => {
  // Cleanup
  if (productId) await db.query('DELETE FROM products WHERE id=?', [productId]);
  if (ingredientId) await db.query('DELETE FROM ingredients WHERE id=?', [ingredientId]);
  if (kasirAId) await db.query('DELETE FROM users WHERE id=?', [kasirAId]);
  if (kasirBId) await db.query('DELETE FROM users WHERE id=?', [kasirBId]);
  if (branchA) await db.query('DELETE FROM branches WHERE id=?', [branchA.id]);
  if (branchB) await db.query('DELETE FROM branches WHERE id=?', [branchB.id]);
  await db.end?.();
});

// ─── Tests ────────────────────────────────────────────────────

describe('Branch Stock Isolation', () => {

  // ── 1. GET /products returns correct branch stock ──────────
  describe('GET /products — branch-scoped stock', () => {
    it('returns branch A stock when branch_id=A provided', async () => {
      const res = await request(app)
        .get(`/api/products?branch_id=${branchA.id}&status=active`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const p = res.body.products.find(p => p.id === productId);
      expect(p).toBeDefined();
      expect(p.stock).toBe(STOCK_A);
    });

    it('returns branch B stock when branch_id=B provided', async () => {
      const res = await request(app)
        .get(`/api/products?branch_id=${branchB.id}&status=active`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const p = res.body.products.find(p => p.id === productId);
      expect(p).toBeDefined();
      expect(p.stock).toBe(STOCK_B);
    });

    it('kasir A gets own branch stock automatically (via user.branch_id)', async () => {
      const res = await request(app)
        .get('/api/products?status=active')
        .set('Authorization', `Bearer ${kasirAToken}`);
      expect(res.status).toBe(200);
      const p = res.body.products.find(p => p.id === productId);
      expect(p).toBeDefined();
      expect(p.stock).toBe(STOCK_A);
    });

    it('kasir B gets own branch stock, different from A', async () => {
      const res = await request(app)
        .get('/api/products?status=active')
        .set('Authorization', `Bearer ${kasirBToken}`);
      expect(res.status).toBe(200);
      const p = res.body.products.find(p => p.id === productId);
      expect(p).toBeDefined();
      expect(p.stock).toBe(STOCK_B);
      // Must differ from branch A
      expect(p.stock).not.toBe(STOCK_A);
    });
  });

  // ── 2. Stock adjustment scoped to branch ───────────────────
  describe('POST /stock/adjustment — branch isolation', () => {
    it('adjusting stock for branch A does not affect branch B', async () => {
      const delta = -5;

      const res = await request(app)
        .post('/api/stock/adjustment')
        .set('Authorization', `Bearer ${kasirAToken}`)
        .send({ product_id: productId, qty_change: delta, movement_type: 'adjustment', note: 'test' });
      expect(res.status).toBe(200);

      const [[bsA]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchA.id]
      );
      const [[bsB]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchB.id]
      );

      expect(bsA.stock).toBe(STOCK_A + delta);
      expect(bsB.stock).toBe(STOCK_B); // unchanged
    });

    it('admin can adjust branch B stock via branch_id param', async () => {
      const delta = -3;
      const res = await request(app)
        .post('/api/stock/adjustment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ product_id: productId, qty_change: delta, movement_type: 'waste', branch_id: branchB.id });
      expect(res.status).toBe(200);

      const [[bsB]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchB.id]
      );
      expect(bsB.stock).toBe(STOCK_B + delta);
    });
  });

  // ── 3. Order deducts correct branch stock ──────────────────
  describe('POST /orders — stock deduction per branch', () => {
    it('order by kasir A deducts branch A stock only', async () => {
      const [[bsABefore]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchA.id]
      );
      const [[bsBBefore]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchB.id]
      );

      const orderQty = 2;
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirAToken}`)
        .send({
          customer_name: 'Test Customer',
          order_type: 'takeaway',
          payment_method: 'cash',
          items: [{ product_id: productId, quantity: orderQty }],
        });
      expect([200, 201]).toContain(res.status);

      const [[bsAAfter]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchA.id]
      );
      const [[bsBAfter]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchB.id]
      );

      expect(bsAAfter.stock).toBe(bsABefore.stock - orderQty); // deducted
      expect(bsBAfter.stock).toBe(bsBBefore.stock);            // untouched
    });

    it('order by kasir B deducts branch B stock only', async () => {
      const [[bsABefore]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchA.id]
      );
      const [[bsBBefore]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchB.id]
      );

      const orderQty = 1;
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirBToken}`)
        .send({
          customer_name: 'Test Customer B',
          order_type: 'takeaway',
          payment_method: 'cash',
          items: [{ product_id: productId, quantity: orderQty }],
        });
      expect([200, 201]).toContain(res.status);

      const [[bsAAfter]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchA.id]
      );
      const [[bsBAfter]] = await db.query(
        'SELECT stock FROM product_branch_stock WHERE product_id=? AND branch_id=?',
        [productId, branchB.id]
      );

      expect(bsAAfter.stock).toBe(bsABefore.stock);            // untouched
      expect(bsBAfter.stock).toBe(bsBBefore.stock - orderQty); // deducted
    });
  });

  // ── 4. Ingredient stock per branch ─────────────────────────
  describe('POST /ingredients/:id/adjust — branch isolation', () => {
    it('adjusting ingredient for branch A does not affect branch B', async () => {
      const delta = -10;
      const res = await request(app)
        .post(`/api/ingredients/${ingredientId}/adjust`)
        .set('Authorization', `Bearer ${kasirAToken}`)
        .send({ qty_change: delta, movement_type: 'adjustment' });
      expect(res.status).toBe(200);

      const [[ibsA]] = await db.query(
        'SELECT stock_qty FROM ingredient_branch_stock WHERE ingredient_id=? AND branch_id=?',
        [ingredientId, branchA.id]
      );
      const [[ibsB]] = await db.query(
        'SELECT stock_qty FROM ingredient_branch_stock WHERE ingredient_id=? AND branch_id=?',
        [ingredientId, branchB.id]
      );

      expect(parseFloat(ibsA.stock_qty)).toBe(100 + delta);
      expect(parseFloat(ibsB.stock_qty)).toBe(60); // unchanged
    });
  });

  // ── 5. Stock summary scoped to branch ──────────────────────
  describe('GET /stock/summary — branch filter', () => {
    it('summary for branch A reflects branch A stock', async () => {
      const res = await request(app)
        .get(`/api/stock/summary?branch_id=${branchA.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.branch_id).toBe(String(branchA.id));
      expect(res.body.summary).toBeDefined();
    });

    it('kasir gets summary for own branch automatically', async () => {
      const res = await request(app)
        .get('/api/stock/summary')
        .set('Authorization', `Bearer ${kasirAToken}`);
      expect(res.status).toBe(200);
      expect(String(res.body.branch_id)).toBe(String(branchA.id));
    });
  });

  // ── 6. GET /ingredients returns branch-scoped stock ────────
  describe('GET /ingredients — branch-scoped stock', () => {
    it('returns branch A ingredient stock when branch_id=A', async () => {
      const res = await request(app)
        .get(`/api/ingredients?branch_id=${branchA.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ing = res.body.ingredients.find(i => i.id === ingredientId);
      expect(ing).toBeDefined();
      // Stock should reflect branch A value (90 after -10 above)
      expect(parseFloat(ing.stock_qty)).toBe(90);
    });

    it('returns branch B ingredient stock when branch_id=B', async () => {
      const res = await request(app)
        .get(`/api/ingredients?branch_id=${branchB.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ing = res.body.ingredients.find(i => i.id === ingredientId);
      expect(ing).toBeDefined();
      expect(parseFloat(ing.stock_qty)).toBe(60); // unchanged
    });
  });
});
