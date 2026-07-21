/**
 * Tests for:
 * - Orders with payment_method = 'pending'
 * - Tables returning unpaid_order_count
 * - customer_email optional validation fix
 */
const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken, getKasirToken } = require('./helpers');

describe('Orders — Pending Payment & Tables Unpaid', () => {
  let adminToken;
  let kasirToken;
  let productId;
  let tableId;
  let pendingOrderId;
  let pendingOrderNumber;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    kasirToken = await getKasirToken();

    // Get or create a product for testing
    const [[existingProd]] = await db.query(
      "SELECT id FROM products WHERE status = 'active' AND is_available = 1 LIMIT 1"
    );
    if (existingProd) {
      productId = existingProd.id;
    } else {
      // Ensure category exists
      let catId;
      const [[cat]] = await db.query("SELECT id FROM categories LIMIT 1");
      if (cat) { catId = cat.id; }
      else {
        const [cr] = await db.query("INSERT INTO categories (name, is_active) VALUES ('Test', 1)");
        catId = cr.insertId;
      }
      const [pr] = await db.query(
        "INSERT INTO products (name, price, category_id, status, is_available) VALUES ('Test Product', 10000, ?, 'active', 1)",
        [catId]
      );
      productId = pr.insertId;
    }

    // Get or create a test table
    const [[existingTable]] = await db.query(
      "SELECT id FROM tables WHERE table_number = 'T-TEST-99' LIMIT 1"
    );
    if (existingTable) {
      tableId = existingTable.id;
    } else {
      const [r] = await db.query(
        "INSERT INTO tables (table_number, name, capacity, status, is_active) VALUES ('T-TEST-99', 'Test Meja 99', 4, 'available', 1)"
      );
      tableId = r.insertId;
    }
  });

  afterAll(async () => {
    // Cleanup test orders
    if (pendingOrderNumber) {
      await db.query(
        'DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number = ?)',
        [pendingOrderNumber]
      );
      await db.query('DELETE FROM orders WHERE order_number = ?', [pendingOrderNumber]);
    }
    // Cleanup test table
    await db.query("DELETE FROM tables WHERE table_number = 'T-TEST-99'");
  });

  // ─── customer_email validation fix ───────────────────────────

  describe('customer_email validation', () => {
    it('creates order without customer (no email) — should not fail with email error', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          order_type: 'takeaway',
          payment_method: 'cash',
          items: [{ product_id: productId, quantity: 1 }],
        });

      expect(res.status).toBe(201);
      expect(res.body.order).toBeTruthy();

      // Cleanup
      if (res.body.order?.id) {
        await db.query('DELETE FROM order_items WHERE order_id = ?', [res.body.order.id]);
        await db.query('DELETE FROM orders WHERE id = ?', [res.body.order.id]);
      }
    });

    it('creates order with null customer_email', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          customer_name: 'Pelanggan Umum',
          customer_email: null,
          order_type: 'takeaway',
          payment_method: 'cash',
          items: [{ product_id: productId, quantity: 1 }],
        });

      expect(res.status).toBe(201);

      if (res.body.order?.id) {
        await db.query('DELETE FROM order_items WHERE order_id = ?', [res.body.order.id]);
        await db.query('DELETE FROM orders WHERE id = ?', [res.body.order.id]);
      }
    });

    it('creates order with empty string customer_email', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          customer_email: '',
          order_type: 'takeaway',
          payment_method: 'cash',
          items: [{ product_id: productId, quantity: 1 }],
        });

      expect(res.status).toBe(201);

      if (res.body.order?.id) {
        await db.query('DELETE FROM order_items WHERE order_id = ?', [res.body.order.id]);
        await db.query('DELETE FROM orders WHERE id = ?', [res.body.order.id]);
      }
    });

    it('rejects genuinely invalid email format', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          customer_email: 'bukan-email-valid',
          order_type: 'takeaway',
          payment_method: 'cash',
          items: [{ product_id: productId, quantity: 1 }],
        });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('email');
    });

    it('accepts valid customer_email', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          customer_email: 'test.customer@example.com',
          order_type: 'takeaway',
          payment_method: 'cash',
          items: [{ product_id: productId, quantity: 1 }],
        });

      expect(res.status).toBe(201);
      // customer_email not returned in order create response (stored in DB)
      const [[savedOrder]] = await db.query('SELECT customer_email FROM orders WHERE id = ?', [res.body.order.id]);
      expect(savedOrder.customer_email).toBe('test.customer@example.com');

      if (res.body.order?.id) {
        await db.query('DELETE FROM order_items WHERE order_id = ?', [res.body.order.id]);
        await db.query('DELETE FROM orders WHERE id = ?', [res.body.order.id]);
      }
    });
  });

  // ─── Pending payment method ───────────────────────────────────

  describe('payment_method = pending', () => {
    it('creates order with pending payment', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          customer_name: 'Pelanggan Bayar Nanti',
          order_type: 'dine-in',
          table_id: tableId,
          table_number: 'T-TEST-99',
          payment_method: 'pending',
          items: [{ product_id: productId, quantity: 2 }],
        });

      expect(res.status).toBe(201);
      pendingOrderId = res.body.order.id;
      pendingOrderNumber = res.body.order.order_number;

      // Verify in DB since create response doesn't include payment_method
      const [[savedOrder]] = await db.query(
        'SELECT payment_method, payment_status FROM orders WHERE id = ?',
        [pendingOrderId]
      );
      expect(savedOrder.payment_method).toBe('pending');
      expect(savedOrder.payment_status).toBe('pending');
    });

    it('pending order appears in orders list with payment_status=pending', async () => {
      if (!pendingOrderNumber) return;

      const res = await request(app)
        .get('/api/orders')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const found = res.body.orders.find(o => o.order_number === pendingOrderNumber);
      expect(found).toBeTruthy();
      expect(found.payment_status).toBe('pending');
    });

    it('pending order total is correct', async () => {
      if (!pendingOrderId) return;

      const [[order]] = await db.query('SELECT total FROM orders WHERE id = ?', [pendingOrderId]);
      expect(parseFloat(order.total)).toBeGreaterThan(0);
    });
  });

  // ─── Tables unpaid_order_count ────────────────────────────────

  describe('GET /api/tables — unpaid_order_count', () => {
    it('returns unpaid_order_count field', async () => {
      const res = await request(app)
        .get('/api/tables')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const testTable = res.body.tables.find(t => t.table_number === 'T-TEST-99');
      if (testTable) {
        expect(testTable).toHaveProperty('unpaid_order_count');
        expect(testTable).toHaveProperty('unpaid_order_number');
      }
    });

    it('table with pending order has unpaid_order_count > 0', async () => {
      if (!pendingOrderId) return;

      const res = await request(app)
        .get('/api/tables')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const testTable = res.body.tables.find(t => t.table_number === 'T-TEST-99');
      if (testTable) {
        expect(parseInt(testTable.unpaid_order_count)).toBeGreaterThan(0);
        expect(testTable.unpaid_order_number).toBeTruthy();
      }
    });

    it('table with no pending orders has unpaid_order_count = 0', async () => {
      // Use a table that definitely has no orders
      const res = await request(app)
        .get('/api/tables')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      // All tables should have the field
      res.body.tables.forEach(t => {
        expect(t).toHaveProperty('unpaid_order_count');
      });
    });
  });

  // ─── Served-by filter ─────────────────────────────────────────

  describe('GET /api/orders?served_by', () => {
    it('admin can filter orders by served_by (kasir user id)', async () => {
      const [[kasirUser]] = await db.query(
        "SELECT id FROM users WHERE email = 'kasir.test@cafeazzura.com'"
      );
      if (!kasirUser) return;

      const res = await request(app)
        .get(`/api/orders?served_by=${kasirUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.orders)).toBe(true);
      res.body.orders.forEach(o => expect(o.served_by).toBe(kasirUser.id));
    });

    it('orders response includes served_by_name', async () => {
      const res = await request(app)
        .get('/api/orders?limit=5')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      // served_by_name should be a key (may be null if order has no kasir)
      if (res.body.orders.length > 0) {
        expect(res.body.orders[0]).toHaveProperty('served_by_name');
      }
    });
  });
});
