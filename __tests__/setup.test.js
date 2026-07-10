const request = require('supertest');
const app = require('../server');
const db = require('../config/database');

const resetSetupFlag = async () => {
  await db.query("DELETE FROM system_settings WHERE setting_key = 'setup_completed'");
};

const setSetupCompleted = async () => {
  await db.query(
    "INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group) VALUES ('setup_completed', 'true', 'boolean', 'system') ON DUPLICATE KEY UPDATE setting_value = 'true'"
  );
};

afterAll(async () => {
  await setSetupCompleted();
});

describe('GET /api/setup/status', () => {
  it('returns setup status object', async () => {
    const res = await request(app).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('setup_completed');
    expect(res.body).toHaveProperty('has_admin');
    expect(res.body).toHaveProperty('branch_count');
  });

  it('setup_completed is true when flag is set', async () => {
    await setSetupCompleted();
    const res = await request(app).get('/api/setup/status');
    expect(res.body.setup_completed).toBe(true);
  });
});

describe('POST /api/setup/reset', () => {
  it('resets setup_completed flag', async () => {
    await setSetupCompleted();
    const res = await request(app).post('/api/setup/reset');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message');

    const check = await request(app).get('/api/setup/status');
    expect(check.body.setup_completed).toBe(false);
  });
});

describe('POST /api/setup/initialize', () => {
  beforeAll(async () => {
    await resetSetupFlag();
  });

  it('requires cafe_name', async () => {
    const res = await request(app)
      .post('/api/setup/initialize')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Nama cafe');
  });

  it('requires admin email and password', async () => {
    const res = await request(app)
      .post('/api/setup/initialize')
      .send({ cafe_name: 'Test Cafe', admin: { name: 'Admin' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Akun admin');
  });

  it('initializes with minimal data', async () => {
    const unique = Date.now();
    const res = await request(app)
      .post('/api/setup/initialize')
      .send({
        cafe_name: `Cafe Test ${unique}`,
        tagline: 'Test tagline',
        admin: {
          name: 'Admin Test',
          email: `setup.admin.${unique}@test.com`,
          password: 'test123456',
        },
        branches: [{ name: `Cabang Test ${unique}`, code: `TST${unique}`.slice(0, 10), city: 'Jakarta' }],
        kasirs: [{
          name: 'Kasir Test',
          email: `setup.kasir.${unique}@test.com`,
          password: 'kasir123456',
        }],
        features: {
          enable_booking: true,
          enable_takeaway: false,
          enable_delivery: false,
          multi_branch: false,
          shift_enabled: true,
        },
      });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('admin');
    expect(res.body).toHaveProperty('branches');
    expect(res.body).toHaveProperty('kasirs');
    expect(res.body.admin.email).toBe(`setup.admin.${unique}@test.com`);
    expect(res.body.branches.length).toBe(1);
    expect(res.body.kasirs.length).toBe(1);

    // Verify setup_completed is now true
    const statusRes = await request(app).get('/api/setup/status');
    expect(statusRes.body.setup_completed).toBe(true);

    // Cleanup test data
    await db.query("DELETE FROM system_settings WHERE setting_key = 'setup_completed' AND setting_value = 'true'");
    await db.query('DELETE FROM users WHERE email LIKE ?', [`setup.%@test.com`]);
    await db.query('DELETE FROM branches WHERE code = ?', [`TST${unique}`.slice(0, 10)]);
  });

  it('rejects duplicate initialization when setup_completed', async () => {
    await setSetupCompleted();
    const res = await request(app)
      .post('/api/setup/initialize')
      .send({ cafe_name: 'Cafe', admin: { email: 'a@b.com', password: '123456' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sudah pernah');
  });

  it('rejects duplicate email', async () => {
    await resetSetupFlag();
    const unique = Date.now() + 1;
    const res = await request(app)
      .post('/api/setup/initialize')
      .send({
        cafe_name: 'Dup Test',
        admin: { name: 'Admin', email: `dup.admin.${unique}@test.com`, password: '123456' },
        kasirs: [{ name: 'Kasir', email: `dup.admin.${unique}@test.com`, password: '123456' }],
      });
    expect(res.status).toBe(409);

    // Cleanup
    await db.query('DELETE FROM users WHERE email LIKE ?', [`dup.%@test.com`]);
  });
});
