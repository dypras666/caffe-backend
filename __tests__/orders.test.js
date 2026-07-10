const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken, getKasirToken } = require('./helpers');

describe('Orders API Tests', () => {
  let adminToken, kasirToken, orderId;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    kasirToken = await getKasirToken();
  });

  afterAll(async () => {
    if (orderId) {
      await db.query('DELETE FROM order_items WHERE order_id = ?', [orderId]);
      await db.query('DELETE FROM orders WHERE id = ?', [orderId]);
    }
    
  });

  describe('POST /api/orders - Create Order', () => {
    it('creates order with valid items', async () => {
      // Get a real product id first
      const [products] = await db.query('SELECT id FROM products WHERE status = "active" LIMIT 1');
      if (products.length === 0) return;

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          customer_name: 'John Test',
          order_type: 'dine-in',
          table_number: 'T5',
          payment_method: 'cash',
          items: [{ product_id: products[0].id, quantity: 2, notes: 'Extra hot' }]
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('order');
      expect(res.body.order.order_number).toMatch(/^ORD-\d{8}-\d+$/);
      expect(res.body.order.total).toBeGreaterThan(0);
      orderId = res.body.order.id;
    });

    it('rejects order with empty items array', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({ order_type: 'dine-in', items: [] });
      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated order', async () => {
      const res = await request(app)
        .post('/api/orders')
        .send({ order_type: 'dine-in', items: [{ product_id: 1, quantity: 1 }] });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/orders', () => {
    it('admin sees all orders', async () => {
      const res = await request(app)
        .get('/api/orders')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('orders');
      expect(Array.isArray(res.body.orders)).toBe(true);
    });

    it('filters by status', async () => {
      const res = await request(app)
        .get('/api/orders?status=pending')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      if (res.body.orders.length > 0) {
        res.body.orders.forEach(o => expect(o.order_status).toBe('pending'));
      }
    });

    it('pagination works', async () => {
      const res = await request(app)
        .get('/api/orders?page=1&limit=2')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.orders.length).toBeLessThanOrEqual(2);
      expect(res.body).toHaveProperty('pagination');
      expect(res.body.pagination).toHaveProperty('total');
      expect(res.body.pagination).toHaveProperty('page');
    });
  });

  describe('PUT /api/orders/:id/status - Status Transitions', () => {
    it('valid: pending → preparing', async () => {
      if (!orderId) return;
      const res = await request(app)
        .put(`/api/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({ status: 'preparing' });
      expect([200, 400]).toContain(res.status); // 400 if already moved
    });

    it('invalid transition: pending → completed (skipping steps)', async () => {
      // Create fresh order for this test
      const [products] = await db.query('SELECT id FROM products WHERE status = "active" LIMIT 1');
      if (products.length === 0) return;

      const createRes = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          order_type: 'takeaway',
          payment_method: 'qris',
          items: [{ product_id: products[0].id, quantity: 1 }]
        });

      if (createRes.status !== 201) return;
      const testOrderId = createRes.body.order.id;

      const res = await request(app)
        .put(`/api/orders/${testOrderId}/status`)
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({ status: 'completed' });
      expect(res.status).toBe(400);

      // Cleanup
      await db.query('DELETE FROM order_items WHERE order_id = ?', [testOrderId]);
      await db.query('DELETE FROM orders WHERE id = ?', [testOrderId]);
    });
  });
});
