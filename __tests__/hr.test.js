const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken, getKasirToken } = require('./helpers');

describe('HR Module Tests', () => {
  let adminToken;
  let kasirToken;
  let createdEmployeeId;
  let createdShiftId;
  let createdSwapId;
  let createdPayrollId;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    kasirToken = await getKasirToken();

    // Ensure HR is enabled for tests
    await db.query(
      "INSERT INTO system_settings (setting_key, setting_value) VALUES ('hr_enabled','true') ON DUPLICATE KEY UPDATE setting_value='true'"
    );

    // Cleanup any leftover test data (order matters — FK constraints)
    const [testEmps] = await db.query("SELECT id FROM employees WHERE employee_code LIKE 'TEST-%'");
    if (testEmps.length) {
      const ids = testEmps.map(e => e.id);
      // Remove expense records created by payroll pay
      await db.query("DELETE FROM expenses WHERE reference LIKE 'PAYROLL-%' AND description LIKE '%Test Karyawan%'");
      await db.query('DELETE FROM payroll WHERE employee_id IN (?)', [ids]);
      await db.query('DELETE FROM shift_swaps WHERE requester_employee_id IN (?) OR target_employee_id IN (?)', [ids, ids]);
      await db.query('DELETE FROM attendance WHERE employee_id IN (?)', [ids]);
      await db.query("DELETE FROM employees WHERE employee_code LIKE 'TEST-%'");
    }
    await db.query("DELETE FROM work_shifts WHERE shift_name LIKE 'Test Shift%'");
  });

  afterAll(async () => {
    const [testEmps] = await db.query("SELECT id FROM employees WHERE employee_code LIKE 'TEST-%'");
    if (testEmps.length) {
      const ids = testEmps.map(e => e.id);
      await db.query("DELETE FROM expenses WHERE reference LIKE 'PAYROLL-%' AND description LIKE '%Test Karyawan%'");
      await db.query('DELETE FROM payroll WHERE employee_id IN (?)', [ids]);
      await db.query('DELETE FROM shift_swaps WHERE requester_employee_id IN (?) OR target_employee_id IN (?)', [ids, ids]);
      await db.query('DELETE FROM attendance WHERE employee_id IN (?)', [ids]);
      await db.query("DELETE FROM employees WHERE employee_code LIKE 'TEST-%'");
    }
    await db.query("DELETE FROM work_shifts WHERE shift_name LIKE 'Test Shift%'");
    // Reset HR to disabled
    await db.query(
      "INSERT INTO system_settings (setting_key, setting_value) VALUES ('hr_enabled','false') ON DUPLICATE KEY UPDATE setting_value='false'"
    );
  });

  // ─── Settings ────────────────────────────────────────────────

  describe('GET /api/hr/settings', () => {
    it('admin can get HR settings', async () => {
      const res = await request(app)
        .get('/api/hr/settings')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.settings).toHaveProperty('hr_enabled');
      expect(res.body.settings).toHaveProperty('hr_work_days_per_week');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/hr/settings');
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/hr/settings', () => {
    it('admin can update HR settings', async () => {
      const res = await request(app)
        .put('/api/hr/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hr_work_days_per_week: '6', hr_payroll_day: '25' });

      expect(res.status).toBe(200);
      expect(res.body.settings.hr_work_days_per_week).toBe('6');
    });
  });

  // ─── Employees ───────────────────────────────────────────────

  describe('POST /api/hr/employees', () => {
    it('admin can create employee', async () => {
      const res = await request(app)
        .post('/api/hr/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employee_code: 'TEST-001',
          full_name: 'Test Karyawan Satu',
          department: 'Dapur',
          position: 'Chef',
          employment_type: 'full-time',
          base_salary: 3000000,
          join_date: '2024-01-01',
        });

      expect(res.status).toBe(201);
      expect(res.body.employee.full_name).toBe('Test Karyawan Satu');
      expect(res.body.employee.department).toBe('Dapur');
      createdEmployeeId = res.body.employee.id;
    });

    it('returns 409 on duplicate employee_code', async () => {
      const res = await request(app)
        .post('/api/hr/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employee_code: 'TEST-001', full_name: 'Duplicate' });

      expect(res.status).toBe(409);
    });

    it('returns 400 without full_name', async () => {
      const res = await request(app)
        .post('/api/hr/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employee_code: 'TEST-NONAME' });

      expect(res.status).toBe(400);
    });

    it('kasir cannot create employee', async () => {
      const res = await request(app)
        .post('/api/hr/employees')
        .set('Authorization', `Bearer ${kasirToken}`)
        .send({ employee_code: 'TEST-002', full_name: 'No Permission' });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/hr/employees', () => {
    it('admin can list employees', async () => {
      const res = await request(app)
        .get('/api/hr/employees')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.employees)).toBe(true);
    });

    it('kasir can list employees', async () => {
      const res = await request(app)
        .get('/api/hr/employees')
        .set('Authorization', `Bearer ${kasirToken}`);

      expect(res.status).toBe(200);
    });

    it('filters by status', async () => {
      const res = await request(app)
        .get('/api/hr/employees?status=active')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      res.body.employees.forEach(e => expect(e.status).toBe('active'));
    });
  });

  describe('PUT /api/hr/employees/:id', () => {
    it('admin can update employee', async () => {
      const res = await request(app)
        .put(`/api/hr/employees/${createdEmployeeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ position: 'Senior Chef', base_salary: 3500000 });

      expect(res.status).toBe(200);
      expect(res.body.employee.position).toBe('Senior Chef');
    });
  });

  describe('DELETE /api/hr/employees/:id', () => {
    it('admin can deactivate employee', async () => {
      const res = await request(app)
        .delete(`/api/hr/employees/${createdEmployeeId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);

      // Verify inactive
      const [[emp]] = await db.query('SELECT status FROM employees WHERE id = ?', [createdEmployeeId]);
      expect(emp.status).toBe('inactive');

      // Reactivate for subsequent tests
      await db.query('UPDATE employees SET status = "active" WHERE id = ?', [createdEmployeeId]);
    });
  });

  // ─── Work Shifts ─────────────────────────────────────────────

  describe('POST /api/hr/work-shifts', () => {
    it('admin can create shift', async () => {
      const res = await request(app)
        .post('/api/hr/work-shifts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ shift_name: 'Test Shift Pagi', start_time: '07:00', end_time: '15:00', break_minutes: 60 });

      expect(res.status).toBe(201);
      expect(res.body.shift.shift_name).toBe('Test Shift Pagi');
      createdShiftId = res.body.shift.id;
    });

    it('returns 400 without required fields', async () => {
      const res = await request(app)
        .post('/api/hr/work-shifts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ shift_name: 'Missing Times' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/hr/work-shifts', () => {
    it('returns active shifts', async () => {
      const res = await request(app)
        .get('/api/hr/work-shifts')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.shifts)).toBe(true);
    });
  });

  // ─── Attendance ──────────────────────────────────────────────

  describe('POST /api/hr/attendance/clock-in', () => {
    beforeEach(async () => {
      // Remove any existing attendance for today
      const today = new Date().toISOString().slice(0, 10);
      await db.query('DELETE FROM attendance WHERE employee_id = ? AND work_date = ?', [createdEmployeeId, today]);
    });

    it('admin can clock in an employee', async () => {
      const res = await request(app)
        .post('/api/hr/attendance/clock-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employee_id: createdEmployeeId, shift_id: createdShiftId });

      expect(res.status).toBe(201);
      expect(res.body.attendance.employee_id).toBe(createdEmployeeId);
      expect(res.body.attendance.clock_in).toBeTruthy();
    });

    it('returns 409 on duplicate clock-in same day', async () => {
      // First clock-in
      await request(app)
        .post('/api/hr/attendance/clock-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employee_id: createdEmployeeId });

      // Second attempt
      const res = await request(app)
        .post('/api/hr/attendance/clock-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employee_id: createdEmployeeId });

      expect(res.status).toBe(409);
    });

    it('returns 400 without employee_id', async () => {
      const res = await request(app)
        .post('/api/hr/attendance/clock-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/hr/attendance/clock-out', () => {
    it('can clock out after clocking in', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await db.query('DELETE FROM attendance WHERE employee_id = ? AND work_date = ?', [createdEmployeeId, today]);

      await request(app)
        .post('/api/hr/attendance/clock-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employee_id: createdEmployeeId });

      const res = await request(app)
        .post('/api/hr/attendance/clock-out')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employee_id: createdEmployeeId });

      expect(res.status).toBe(200);
      expect(res.body.attendance.clock_out).toBeTruthy();
      expect(parseFloat(res.body.attendance.total_hours)).toBeGreaterThanOrEqual(0);
    });

    it('returns 404 if not clocked in today', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await db.query('DELETE FROM attendance WHERE employee_id = ? AND work_date = ?', [createdEmployeeId, today]);

      const res = await request(app)
        .post('/api/hr/attendance/clock-out')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employee_id: createdEmployeeId });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/hr/attendance', () => {
    it('returns attendance records filtered by date', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/hr/attendance?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.attendance)).toBe(true);
    });

    it('filters by employee_id', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/hr/attendance?employee_id=${createdEmployeeId}&date_from=2024-01-01&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      res.body.attendance.forEach(a => expect(a.employee_id).toBe(createdEmployeeId));
    });
  });

  // ─── Shift Swaps ─────────────────────────────────────────────

  describe('POST /api/hr/shift-swaps', () => {
    it('creates a shift swap request', async () => {
      if (!createdEmployeeId) return;
      // Create second employee inline
      await db.query("DELETE FROM employees WHERE employee_code = 'TEST-002'");
      const [r2] = await db.query(
        "INSERT INTO employees (employee_code, full_name, department, status) VALUES ('TEST-002', 'Test Karyawan Dua', 'Bar', 'active')"
      );
      const emp2Id = r2.insertId;
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().slice(0, 10);

      const res = await request(app)
        .post('/api/hr/shift-swaps')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          requester_employee_id: createdEmployeeId,
          target_employee_id: emp2Id,
          from_date: tomorrowStr,
          reason: 'Keperluan keluarga',
        });

      expect(res.status).toBe(201);
      expect(res.body.swap.status).toBe('pending');
      createdSwapId = res.body.swap.id;
    });

    it('returns 400 without required fields', async () => {
      const res = await request(app)
        .post('/api/hr/shift-swaps')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ requester_employee_id: createdEmployeeId });

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/hr/shift-swaps/:id/approve', () => {
    it('admin can approve swap', async () => {
      if (!createdSwapId) return;
      const res = await request(app)
        .put(`/api/hr/shift-swaps/${createdSwapId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.swap.status).toBe('approved');
    });

    it('returns 400 for invalid action', async () => {
      if (!createdSwapId) return;
      const res = await request(app)
        .put(`/api/hr/shift-swaps/${createdSwapId}/invalid`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });
  });

  // ─── Payroll ─────────────────────────────────────────────────

  describe('POST /api/hr/payroll/generate', () => {
    it('generates payroll for current month', async () => {
      const month = new Date().toISOString().slice(0, 7);

      // Remove existing payroll for this employee
      await db.query('DELETE FROM payroll WHERE employee_id = ?', [createdEmployeeId]);

      const res = await request(app)
        .post('/api/hr/payroll/generate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month });

      expect(res.status).toBe(200);
      expect(res.body.payroll).toBeInstanceOf(Array);
      const slip = res.body.payroll.find(p => !p.skipped);
      if (slip) createdPayrollId = slip.id;
    });

    it('returns 400 without month', async () => {
      const res = await request(app)
        .post('/api/hr/payroll/generate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/hr/payroll', () => {
    it('returns payroll list for month', async () => {
      const month = new Date().toISOString().slice(0, 7);
      const res = await request(app)
        .get(`/api/hr/payroll?month=${month}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.payroll)).toBe(true);
    });

    it('returns 400 without month param', async () => {
      const res = await request(app)
        .get('/api/hr/payroll')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/hr/payroll/:id', () => {
    it('admin can adjust payroll deductions and bonus', async () => {
      if (!createdPayrollId) return;
      const res = await request(app)
        .put(`/api/hr/payroll/${createdPayrollId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ deductions: 100000, bonus: 50000, notes: 'Test adjustment' });

      expect(res.status).toBe(200);
      expect(parseFloat(res.body.payroll.deductions)).toBe(100000);
      expect(parseFloat(res.body.payroll.bonus)).toBe(50000);
    });
  });

  describe('POST /api/hr/payroll/:id/pay', () => {
    it('admin can mark payroll as paid and it creates expense', async () => {
      if (!createdPayrollId) return;

      const res = await request(app)
        .post(`/api/hr/payroll/${createdPayrollId}/pay`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);

      // Verify expense was created
      const [[expRow]] = await db.query(
        "SELECT id FROM expenses WHERE reference = ?",
        [`PAYROLL-${createdPayrollId}`]
      );
      expect(expRow).toBeTruthy();
    });

    it('returns 409 on double-pay', async () => {
      if (!createdPayrollId) return;
      const res = await request(app)
        .post(`/api/hr/payroll/${createdPayrollId}/pay`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
    });
  });

  // ─── Summary ─────────────────────────────────────────────────

  describe('GET /api/hr/summary', () => {
    it('returns summary for current month', async () => {
      const month = new Date().toISOString().slice(0, 7);
      const res = await request(app)
        .get(`/api/hr/summary?month=${month}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('employees');
      expect(res.body).toHaveProperty('attendance');
      expect(res.body).toHaveProperty('payroll');
      expect(res.body).toHaveProperty('shift_swaps');
    });
  });

  // ─── HR disabled ─────────────────────────────────────────────

  describe('HR blocked when disabled', () => {
    beforeAll(async () => {
      await db.query(
        "INSERT INTO system_settings (setting_key, setting_value) VALUES ('hr_enabled','false') ON DUPLICATE KEY UPDATE setting_value='false'"
      );
    });

    afterAll(async () => {
      await db.query(
        "INSERT INTO system_settings (setting_key, setting_value) VALUES ('hr_enabled','true') ON DUPLICATE KEY UPDATE setting_value='true'"
      );
    });

    it('returns 403 when HR is disabled', async () => {
      const res = await request(app)
        .get('/api/hr/employees')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('tidak aktif');
    });
  });
});
