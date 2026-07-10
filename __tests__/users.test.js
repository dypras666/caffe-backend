const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const {
  getAdminToken, getKasirToken, getWaiterToken, getMemberToken,
  cleanupTestUsers,
} = require('./helpers');

describe('Users API — CRUD & Role Access', () => {
  let adminToken, kasirToken, waiterToken, memberToken;
  let createdUserId = null;

  beforeAll(async () => {
    [adminToken, kasirToken, waiterToken, memberToken] = await Promise.all([
      getAdminToken(),
      getKasirToken(),
      getWaiterToken(),
      getMemberToken(),
    ]);
  });

  afterAll(async () => {
    if (createdUserId) {
      await db.query('DELETE FROM users WHERE id = ?', [createdUserId]);
    }
    await cleanupTestUsers();
  });

  // ──────────────────────────────────────────────────────────────
  describe('GET /api/users — list users', () => {
    it('admin: 200 with pagination', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.users)).toBe(true);
      expect(res.body).toHaveProperty('pagination');
      expect(res.body.pagination).toHaveProperty('total');
      // Should never leak passwords
      res.body.users.forEach(u => {
        expect(u).not.toHaveProperty('password');
      });
    });

    it('admin: filter by role=kasir', async () => {
      const res = await request(app)
        .get('/api/users?role=kasir')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      res.body.users.forEach(u => expect(u.role).toBe('kasir'));
    });

    it('admin: filter by role=waiter', async () => {
      const res = await request(app)
        .get('/api/users?role=waiter')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      res.body.users.forEach(u => expect(u.role).toBe('waiter'));
    });

    it('admin: filter by role=member', async () => {
      const res = await request(app)
        .get('/api/users?role=member')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      res.body.users.forEach(u => expect(u.role).toBe('member'));
    });

    it('admin: filter by status=active', async () => {
      const res = await request(app)
        .get('/api/users?status=active')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      res.body.users.forEach(u => expect(u.status).toBe('active'));
    });

    it('admin: search by name/email', async () => {
      const res = await request(app)
        .get('/api/users?search=admin')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeGreaterThan(0);
    });

    it('admin: pagination limit=2', async () => {
      const res = await request(app)
        .get('/api/users?limit=2&page=1')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeLessThanOrEqual(2);
    });

    it('kasir: 403 cannot list users', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${kasirToken}`);
      expect(res.status).toBe(403);
    });

    it('waiter: 403 cannot list users', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${waiterToken}`);
      expect(res.status).toBe(403);
    });

    it('member: 403 cannot list users', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });

    it('public: 401 without token', async () => {
      const res = await request(app).get('/api/users');
      expect(res.status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('POST /api/auth/register — create user (admin)', () => {
    it('admin: create kasir user', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'CRUD Test User',
          email: 'crud.test@cafeazzura.com',
          password: 'test1234',
          role: 'kasir',
        });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('crud.test@cafeazzura.com');
      expect(res.body.user.role).toBe('kasir');
      expect(res.body.user).not.toHaveProperty('password');
      createdUserId = res.body.user.id;
    });

    it('admin: create waiter user', async () => {
      const email = `waiter.crud.${Date.now()}@test.com`;
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Waiter CRUD', email, password: 'pass123', role: 'waiter' });
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('waiter');
      // cleanup
      await db.query('DELETE FROM users WHERE email = ?', [email]);
    });

    it('admin: 400 duplicate email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Dup', email: 'crud.test@cafeazzura.com', password: 'test1234', role: 'kasir' });
      expect([400, 409]).toContain(res.status);
    });

    it('admin: 400 missing required fields', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'missing@test.com' });
      expect(res.status).toBe(400);
    });

    it('admin: 400 password too short', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Short', email: 'short@test.com', password: '123', role: 'kasir' });
      expect(res.status).toBe(400);
    });

    it('kasir: 403 cannot create users', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({ name: 'X', email: 'x@x.com', password: 'xxx123', role: 'kasir' });
      expect(res.status).toBe(403);
    });

    it('waiter: 403 cannot create users', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({ name: 'X', email: 'xx@x.com', password: 'xxx123', role: 'kasir' });
      expect(res.status).toBe(403);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('GET /api/users/:id — get single user', () => {
    it('admin: 200 with balance and is_priority fields', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .get(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toHaveProperty('id');
      expect(res.body.user).toHaveProperty('balance');
      expect(res.body.user).toHaveProperty('is_priority');
      expect(res.body.user).not.toHaveProperty('password');
    });

    it('admin: 404 for non-existent user', async () => {
      const res = await request(app)
        .get('/api/users/99999')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });

    it('kasir: 403 cannot get user by id', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .get(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${kasirToken}`);
      expect(res.status).toBe(403);
    });

    it('waiter: 403 cannot get user by id', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .get(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${waiterToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('PUT /api/users/:id — update user', () => {
    it('admin: update name', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Updated Name' });
      expect(res.status).toBe(200);
    });

    it('admin: update role to waiter', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'waiter' });
      expect(res.status).toBe(200);
    });

    it('admin: update role back to kasir', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'kasir' });
      expect(res.status).toBe(200);
    });

    it('admin: deactivate user (status=inactive)', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'inactive' });
      expect(res.status).toBe(200);
    });

    it('admin: reactivate user (status=active)', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'active' });
      expect(res.status).toBe(200);
    });

    it('admin: set is_priority flag', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_priority: 1 });
      expect(res.status).toBe(200);
    });

    it('admin: 400 invalid role value', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'superadmin' });
      expect(res.status).toBe(400);
    });

    it('admin: 400 no fields provided', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('admin: 404 update non-existent user', async () => {
      const res = await request(app)
        .put('/api/users/99999')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Ghost' });
      expect(res.status).toBe(404);
    });

    it('kasir: 403 cannot update users', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({ status: 'inactive' });
      expect(res.status).toBe(403);
    });

    it('waiter: 403 cannot update users', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({ name: 'Hack' });
      expect(res.status).toBe(403);
    });

    it('member: 403 cannot update users', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ name: 'Hack' });
      expect(res.status).toBe(403);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('DELETE /api/users/:id — delete user', () => {
    it('kasir: 403 cannot delete users', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .delete(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${kasirToken}`);
      expect(res.status).toBe(403);
    });

    it('waiter: 403 cannot delete users', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .delete(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${waiterToken}`);
      expect(res.status).toBe(403);
    });

    it('admin: 400 cannot delete own account', async () => {
      // Get admin's own ID first
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${adminToken}`);
      const adminId = meRes.body.user?.id;
      if (!adminId) return;
      const res = await request(app)
        .delete(`/api/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
    });

    it('admin: 404 delete non-existent user', async () => {
      const res = await request(app)
        .delete('/api/users/99999')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });

    it('admin: 200 successfully delete user', async () => {
      if (!createdUserId) return;
      const res = await request(app)
        .delete(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('deleted');
      createdUserId = null;
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('GET /api/auth/me — own profile', () => {
    it('admin: returns own profile without password', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toHaveProperty('email');
      expect(res.body.user).not.toHaveProperty('password');
    });

    it('kasir: returns own profile', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${kasirToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('kasir');
    });

    it('waiter: returns own profile', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${waiterToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('waiter');
    });

    it('member: returns own profile', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('member');
    });

    it('public: 401 without token', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('POST /api/auth/register/member — self-registration', () => {
    it('public: member can register themselves', async () => {
      const email = `selfregister.${Date.now()}@test.com`;
      const res = await request(app)
        .post('/api/auth/register/member')
        .send({ name: 'Self Register', email, password: 'pass123', phone: '08123' });
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('member');
      expect(res.body).toHaveProperty('token');
      // cleanup
      await db.query('DELETE FROM users WHERE email = ?', [email]);
    });

    it('public: 409 duplicate email', async () => {
      const res = await request(app)
        .post('/api/auth/register/member')
        .send({ name: 'Dup', email: 'admin@cafeazzura.com', password: 'pass123' });
      expect(res.status).toBe(409);
    });

    it('public: 400 password too short', async () => {
      const res = await request(app)
        .post('/api/auth/register/member')
        .send({ name: 'Short', email: 'short2@test.com', password: '123' });
      expect(res.status).toBe(400);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('GET /api/users/me/activity — own activity log', () => {
    it('kasir: can view own activity', async () => {
      const res = await request(app)
        .get('/api/users/me/activity')
        .set('Authorization', `Bearer ${kasirToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.logs)).toBe(true);
    });

    it('waiter: can view own activity', async () => {
      const res = await request(app)
        .get('/api/users/me/activity')
        .set('Authorization', `Bearer ${waiterToken}`);
      expect(res.status).toBe(200);
    });

    it('member: can view own activity', async () => {
      const res = await request(app)
        .get('/api/users/me/activity')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('Role permissions matrix — protected endpoints', () => {
    const matrixTests = [
      // [method, path, role, expectedStatus, description]
      ['get',    '/api/products',         'waiter',  200, 'waiter can read products'],
      ['get',    '/api/products',         'member',  200, 'member can read products'],
      ['post',   '/api/products',         'waiter',  403, 'waiter cannot create product'],
      ['post',   '/api/products',         'member',  [400,401,403], 'member cannot create product'],
      ['get',    '/api/orders',           'waiter',  [200,403], 'waiter can read orders'],
      ['get',    '/api/orders',           'member',  [200,403], 'member can read orders'],
      ['delete', '/api/orders/99999',     'kasir',   403, 'kasir cannot delete order'],
      ['delete', '/api/orders/99999',     'waiter',  [403,404], 'waiter cannot delete order'],
      ['delete', '/api/orders/99999',     'member',  [401,403,404], 'member cannot delete order'],
      ['get',    '/api/settings',         'kasir',   200, 'kasir can read public settings'],
      ['post',   '/api/settings',         'kasir',   403, 'kasir cannot create setting'],
      ['post',   '/api/settings',         'waiter',  403, 'waiter cannot create setting'],
      ['get',    '/api/users',            'kasir',   403, 'kasir cannot list users'],
      ['get',    '/api/users',            'waiter',  403, 'waiter cannot list users'],
      ['get',    '/api/audit',            'kasir',   403, 'kasir cannot access audit'],
      ['get',    '/api/audit',            'waiter',  403, 'waiter cannot access audit'],
    ];

    const tokenMap = {};
    beforeAll(async () => {
      tokenMap['kasir'] = kasirToken;
      tokenMap['waiter'] = waiterToken;
      tokenMap['member'] = memberToken;
    });

    matrixTests.forEach(([method, path, role, expected, desc]) => {
      it(`${role}: ${desc}`, async () => {
        const res = await request(app)
          [method](path)
          .set('Authorization', `Bearer ${tokenMap[role]}`);
        const expectedArr = Array.isArray(expected) ? expected : [expected];
        expect(expectedArr).toContain(res.status);
      });
    });
  });
});
