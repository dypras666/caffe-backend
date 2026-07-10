const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken, getKasirToken } = require('./helpers');

describe('Settings API Tests', () => {
  let adminToken, kasirToken;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    kasirToken = await getKasirToken();
  });

  afterAll(async () => {
    await db.query('DELETE FROM system_settings WHERE setting_key LIKE "test_%"');
    
  });

  describe('GET /api/settings', () => {
    it('public gets only is_public settings', async () => {
      const res = await request(app).get('/api/settings');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.settings)).toBe(true);
      res.body.settings.forEach(s => expect(s.is_public).toBe(1));
    });

    it('admin gets all settings', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.settings.length).toBeGreaterThan(0);
    });

    it('returns JSON settings parsed', async () => {
      const res = await request(app).get('/api/settings');
      const jsonSetting = res.body.settings.find(s => s.setting_type === 'json');
      if (jsonSetting) {
        expect(typeof jsonSetting.setting_value).toBe('object');
      }
    });
  });

  describe('GET /api/settings/:key', () => {
    it('gets setting by key', async () => {
      const res = await request(app).get('/api/settings/site_name');
      expect(res.status).toBe(200);
      expect(res.body.setting.setting_value).toBe('Café Azzura');
    });

    it('returns 404 for unknown key', async () => {
      const res = await request(app).get('/api/settings/nonexistent_key_xyz');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/settings - Create Setting', () => {
    it('admin can create new setting', async () => {
      const res = await request(app)
        .post('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          setting_key: 'test_new_setting',
          setting_value: 'hello',
          setting_type: 'text',
          setting_group: 'test',
          label: 'Test New Setting'
        });
      expect(res.status).toBe(201);
    });

    it('rejects duplicate key', async () => {
      const res = await request(app)
        .post('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          setting_key: 'site_name', // already exists
          setting_value: 'Duplicate',
          setting_type: 'text',
          setting_group: 'general',
          label: 'Duplicate'
        });
      expect([400, 409]).toContain(res.status);
    });

    it('kasir cannot create settings', async () => {
      const res = await request(app)
        .post('/api/settings')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({ setting_key: 'test_k', setting_value: 'v', setting_type: 'text', setting_group: 'x', label: 'x' });
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/settings - Update Settings', () => {
    it('admin can update settings', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          settings: [{ key: 'test_new_setting', value: 'updated_value' }]
        });
      expect(res.status).toBe(200);
      expect(res.body.updated).toContain('test_new_setting');
    });

    it('reports not_found keys', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          settings: [{ key: 'totally_fake_key_xyz', value: 'v' }]
        });
      expect(res.status).toBe(200);
      expect(res.body.not_found).toContain('totally_fake_key_xyz');
    });
  });
});
