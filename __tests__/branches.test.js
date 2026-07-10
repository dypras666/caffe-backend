/**
 * Unit tests for /api/branches (CRUD cabang) dan /api/roles (CRUD roles)
 */
const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken, getKasirToken } = require('./helpers');

let adminToken;
let kasirToken;
let createdBranchId;
let createdRoleId;

beforeAll(async () => {
  adminToken = await getAdminToken();
  kasirToken = await getKasirToken();
});

afterAll(async () => {
  // Cleanup test branch
  if (createdBranchId) {
    await db.query('DELETE FROM branches WHERE id = ?', [createdBranchId]);
  }
  // Cleanup test role
  if (createdRoleId) {
    await db.query('DELETE FROM roles WHERE id = ?', [createdRoleId]);
  }
});

// ─── BRANCHES ────────────────────────────────────────────────

describe('GET /api/branches', () => {
  it('returns branch list for authenticated user', async () => {
    const res = await request(app)
      .get('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.branches)).toBe(true);
    expect(res.body.branches.length).toBeGreaterThan(0);
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/branches');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/branches/public', () => {
  it('returns active branches without auth', async () => {
    const res = await request(app).get('/api/branches/public');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.branches)).toBe(true);
    // Only active branches
    res.body.branches.forEach(b => {
      expect(Object.keys(b)).toEqual(expect.arrayContaining(['id', 'name', 'code']));
    });
  });
});

describe('POST /api/branches', () => {
  it('admin can create a branch', async () => {
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Cabang Test', code: `TST-${Date.now()}`, city: 'Jakarta' });
    expect(res.status).toBe(201);
    expect(res.body.branch.name).toBe('Cabang Test');
    createdBranchId = res.body.branch.id;
  });

  it('rejects duplicate branch code', async () => {
    const code = `DUP-${Date.now()}`;
    await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Dup A', code });
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Dup B', code });
    expect(res.status).toBe(409);
    // Cleanup dup branch
    await db.query('DELETE FROM branches WHERE code = ?', [code]);
  });

  it('requires name and code', async () => {
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'No Code' });
    expect(res.status).toBe(400);
  });

  it('kasir cannot create a branch', async () => {
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ name: 'Kasir Branch', code: `KSR-${Date.now()}` });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/branches/:id', () => {
  it('admin can update branch', async () => {
    const res = await request(app)
      .put(`/api/branches/${createdBranchId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ city: 'Surabaya' });
    expect(res.status).toBe(200);
    expect(res.body.branch.city).toBe('Surabaya');
  });

  it('kasir cannot update branch', async () => {
    const res = await request(app)
      .put(`/api/branches/${createdBranchId}`)
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ city: 'Bandung' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/branches/:id', () => {
  it('cannot delete main branch', async () => {
    const [rows] = await db.query('SELECT id FROM branches WHERE is_main = 1 LIMIT 1');
    if (rows.length === 0) return;
    const res = await request(app)
      .delete(`/api/branches/${rows[0].id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('admin can delete non-main branch', async () => {
    const res = await request(app)
      .delete(`/api/branches/${createdBranchId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    createdBranchId = null;
  });
});

// ─── ROLES ───────────────────────────────────────────────────

describe('GET /api/roles', () => {
  it('returns role list for authenticated user', async () => {
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.roles)).toBe(true);
    // System roles should be present
    const names = res.body.roles.map(r => r.name);
    expect(names).toContain('admin');
    expect(names).toContain('kasir');
    expect(names).toContain('waiter');
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/roles');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/roles', () => {
  it('admin can create a custom role', async () => {
    const res = await request(app)
      .post('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `role_test_${Date.now()}`, label: 'Role Test', description: 'Test role' });
    expect(res.status).toBe(201);
    expect(res.body.role.label).toBe('Role Test');
    createdRoleId = res.body.role.id;
  });

  it('rejects missing name or label', async () => {
    const res = await request(app)
      .post('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'no-label-role' });
    expect(res.status).toBe(400);
  });

  it('kasir cannot create role', async () => {
    const res = await request(app)
      .post('/api/roles')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ name: 'kasir_role_x', label: 'X' });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/roles/:id', () => {
  it('admin can update custom role label', async () => {
    const res = await request(app)
      .put(`/api/roles/${createdRoleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Role Test Updated' });
    expect(res.status).toBe(200);
    expect(res.body.role.label).toBe('Role Test Updated');
  });
});

describe('DELETE /api/roles/:id', () => {
  it('cannot delete system roles', async () => {
    const [rows] = await db.query('SELECT id FROM roles WHERE is_system = 1 LIMIT 1');
    if (rows.length === 0) return;
    const res = await request(app)
      .delete(`/api/roles/${rows[0].id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('admin can delete custom role', async () => {
    const res = await request(app)
      .delete(`/api/roles/${createdRoleId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    createdRoleId = null;
  });
});
