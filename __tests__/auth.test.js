const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken } = require('./helpers');

// Use dynamic admin email — works across tenants with different seed users
let ADMIN_EMAIL = 'admin@cafeazzura.com';
let ADMIN_PASSWORD = 'admin123';

describe('Auth API Tests', () => {
  let authToken;
  let testUserId;

  beforeAll(async () => {
    // Cleanup any leftover test users
    await db.query('DELETE FROM users WHERE email LIKE "%testuser%"');

    // Resolve admin user dynamically — works on any tenant DB
    authToken = await getAdminToken();
    // Get actual admin email for assertions
    const [admins] = await db.query("SELECT email FROM users WHERE role='admin' AND status='active' LIMIT 1");
    if (admins.length) { ADMIN_EMAIL = admins[0].email; ADMIN_PASSWORD = 'admin123'; }
  });

  afterAll(async () => {
    await db.query('DELETE FROM users WHERE email LIKE "%testuser%"');
    // Do NOT call db.end() — let --forceExit handle it
  });

  describe('POST /api/auth/login', () => {
    it('logs in with valid credentials', async () => {
      // Use authToken from beforeAll — if that worked, login works
      expect(authToken).toBeTruthy();
      // Also verify via /me endpoint
      const me = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${authToken}`);
      expect(me.status).toBe(200);
      expect(me.body.user.role).toBe('admin');
    });

    it('fails with wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: 'wrongpassword' });

      expect(res.status).toBe(401);
    });

    it('fails with invalid email format (no such user → 401)', async () => {
      // Login does not validate email format — it just fails to find user
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'notanemail', password: 'password123' });

      expect([400, 401]).toContain(res.status);
    });

    it('fails with missing password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@test.com' });

      expect([400, 401]).toContain(res.status); // 400 validation or 401 wrong creds
    });

    it('does not expose password hash in response', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

      expect(JSON.stringify(res.body)).not.toContain('$2a$');
      expect(JSON.stringify(res.body)).not.toMatch(/"password"/);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns current user with valid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('admin'); // check role, not email (email varies per tenant)
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('returns 401 with garbage token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer garbage.token.here');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/register', () => {
    it('admin creates a kasir user', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Test Kasir',
          email: 'testuser.kasir@cafeazzura.com',
          password: 'password123',
          role: 'kasir',
        });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('testuser.kasir@cafeazzura.com');
      testUserId = res.body.user.id;
    });

    it('fails on duplicate email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Duplicate',
          email: 'testuser.kasir@cafeazzura.com',
          password: 'password123',
          role: 'kasir',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already registered');
    });

    it('returns 401 without token', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'No Auth', email: 'noauth@test.com', password: 'pass', role: 'kasir' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/change-password', () => {
    it('changes password with correct current password', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ currentPassword: 'admin123', newPassword: 'admin123' }); // same for idempotency

      expect(res.status).toBe(200);
    });

    it('rejects wrong current password', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ currentPassword: 'badpassword', newPassword: 'newpass123' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('logs out successfully', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Logout successful');
    });
  });
});
