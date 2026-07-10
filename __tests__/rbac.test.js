const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken, getKasirToken, cleanupKasir } = require('./helpers');

describe('RBAC - Role Based Access Control', () => {
  let adminToken, kasirToken;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    kasirToken = await getKasirToken();
  });

  afterAll(async () => {
    await cleanupKasir();
  });

  describe('Admin-only endpoints', () => {
    const adminOnlyEndpoints = [
      { method: 'get', path: '/api/users' },
      { method: 'delete', path: '/api/products/1' },
    ];

    adminOnlyEndpoints.forEach(({ method, path }) => {
      it(`ADMIN can access ${method.toUpperCase()} ${path}`, async () => {
        const res = await request(app)[method](path)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(401);
      });

      it(`KASIR cannot access ${method.toUpperCase()} ${path}`, async () => {
        const res = await request(app)[method](path)
          .set('Authorization', `Bearer ${kasirToken}`);
        expect(res.status).toBe(403);
      });

      it(`PUBLIC cannot access ${method.toUpperCase()} ${path}`, async () => {
        const res = await request(app)[method](path);
        expect(res.status).toBe(401);
      });
    });
  });

  describe('Kasir-accessible endpoints', () => {
    it('KASIR can read products', async () => {
      const res = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${kasirToken}`);
      expect(res.status).toBe(200);
    });

    it('KASIR can create orders', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({
          customer_name: 'Test Customer',
          order_type: 'dine-in',
          table_number: 'T1',
          payment_method: 'cash',
          items: [{ product_id: 1, quantity: 2 }]
        });
      // 201 or 400 (if product missing), not 401/403
      expect([200, 201, 400]).toContain(res.status);
    });

    it('KASIR cannot delete orders', async () => {
      const res = await request(app)
        .delete('/api/orders/1')
        .set('Authorization', `Bearer ${kasirToken}`);
      expect(res.status).toBe(403);
    });

    it('KASIR cannot manage settings', async () => {
      const res = await request(app)
        .post('/api/settings')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({ setting_key: 'test', setting_value: 'val', setting_type: 'text', setting_group: 'test', label: 'Test' });
      expect(res.status).toBe(403);
    });
  });

  describe('Public endpoints', () => {
    it('Anyone can GET /api/products', async () => {
      const res = await request(app).get('/api/products');
      expect(res.status).toBe(200);
    });

    it('Anyone can POST /api/bookings', async () => {
      const uniqueEmail = `guest.rbactest.${Date.now()}@test.com`;
      const res = await request(app)
        .post('/api/bookings')
        .send({
          name: 'Test Guest',
          email: uniqueEmail,
          phone: '+6281234567',
          booking_date: '2026-12-01',
          booking_time: '18:00',
          guests: 2
        });
      expect([200, 201]).toContain(res.status);
    });

    it('Anyone can GET /api/settings (public settings only)', async () => {
      const res = await request(app).get('/api/settings');
      expect(res.status).toBe(200);
      // All returned settings must be public
      if (res.body.settings) {
        res.body.settings.forEach(s => {
          expect(s.is_public).toBe(1);
        });
      }
    });
  });
});
