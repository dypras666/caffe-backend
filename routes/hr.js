/**
 * HR Module — Karyawan, Absensi, Penggajian, Tukar Shift
 * Opsional: hanya aktif jika system_settings hr_enabled = 'true'
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { isDemoTenant } = require('../middleware/demoProtection');

// ─── Middleware: cek hr enabled ──────────────────────────────
async function hrEnabled(req, res, next) {
  try {
    const [[row]] = await db.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'hr_enabled'"
    );
    if (!row || row.setting_value !== 'true') {
      return res.status(403).json({ error: 'Modul HR tidak aktif. Aktifkan di Pengaturan → HR.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── EMPLOYEES ───────────────────────────────────────────────

// GET /api/hr/employees
router.get('/employees', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { status, department, branch_id, search, q, page, limit } = req.query;
    const searchTerm = (search || q || '').trim();
    let sql = `
      SELECT e.*, u.name AS user_name, u.email AS user_email, u.role AS user_role,
             b.name AS branch_name
      FROM employees e
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN branches b ON b.id = e.branch_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { sql += ' AND e.status = ?'; params.push(status); }
    if (department) { sql += ' AND e.department = ?'; params.push(department); }
    if (branch_id) {
      sql += ' AND e.branch_id = ?'; params.push(branch_id);
    } else if (req.user.branch_id) {
      sql += ' AND e.branch_id = ?'; params.push(req.user.branch_id);
    }
    if (searchTerm) {
      sql += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR e.phone LIKE ? OR e.department LIKE ? OR e.position LIKE ?)';
      const s = `%${searchTerm}%`;
      params.push(s, s, s, s, s);
    }

    let total = null;
    if (limit) {
      const countSql = `SELECT COUNT(*) as total FROM (${sql}) AS counted`;
      const [[{ total: cnt }]] = await db.query(countSql, params);
      total = cnt;
    }

    sql += ' ORDER BY e.full_name';

    if (limit) {
      const l = Math.max(1, parseInt(limit));
      const p = Math.max(1, parseInt(page) || 1);
      const offset = (p - 1) * l;
      sql += ' LIMIT ? OFFSET ?';
      params.push(l, offset);
    }

    const [rows] = await db.query(sql, params);
    res.json({
      employees: rows,
      ...(total !== null ? {
        total,
        page: Math.max(1, parseInt(page) || 1),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      } : {})
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/hr/employees/:id
router.get('/employees/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const [[emp]] = await db.query(
      `SELECT e.*, u.name AS user_name, u.email AS user_email
       FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`,
      [req.params.id]
    );
    if (!emp) return res.status(404).json({ error: 'Karyawan tidak ditemukan' });
    res.json({ employee: emp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr/employees
router.post('/employees', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const {
      user_id, employee_code, full_name, nik, phone, address,
      department, position, employment_type, join_date,
      base_salary, hourly_rate, bank_name, bank_account, bank_account_name, branch_id,
      create_user_account, email, password, user_role, station_id
    } = req.body;
    if (!full_name) return res.status(400).json({ error: 'Nama lengkap wajib diisi' });

    let linkedUserId = user_id || null;

    if (await isDemoTenant()) {
      if (create_user_account) {
        if (user_role === 'admin' || (email && (email.toLowerCase().startsWith('admin@') || email.toLowerCase().startsWith('owner@')))) {
          return res.status(403).json({
            error: 'Mode Demo Aktif',
            message: 'Tidak dapat membuat akun admin utama pada demo kafe.',
          });
        }
      }
      if (linkedUserId) {
        const [[linkedUser]] = await db.query('SELECT role, email FROM users WHERE id = ?', [linkedUserId]);
        if (linkedUser && (linkedUser.role === 'admin' || linkedUser.email.toLowerCase().startsWith('admin@') || linkedUser.email.toLowerCase().startsWith('owner@'))) {
          return res.status(403).json({
            error: 'Mode Demo Aktif',
            message: 'Tidak dapat menghubungkan karyawan ke akun admin utama pada demo kafe.',
          });
        }
      }
    }

    // Optionally create a linked user account in the same request
    if (create_user_account && email && password) {
      const bcrypt = require('bcryptjs');
      const [[existing]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing) return res.status(409).json({ error: 'Email sudah terdaftar' });
      const hashed = await bcrypt.hash(password, 10);
      const [ur] = await db.query(
        'INSERT INTO users (name, email, password, role, phone, branch_id, station_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [full_name, email, hashed, user_role || 'kasir', phone || null, branch_id || req.user.branch_id || null, station_id || null]
      );
      linkedUserId = ur.insertId;
    }

    const code = employee_code || `EMP-${Date.now().toString().slice(-6)}`;
    const effectiveBranchId = branch_id || req.user.branch_id || null;
    const [result] = await db.query(
      `INSERT INTO employees
        (user_id, employee_code, full_name, nik, phone, address,
         department, position, employment_type, join_date,
         base_salary, hourly_rate, bank_name, bank_account, bank_account_name, branch_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        linkedUserId, code, full_name, nik || null, phone || null, address || null,
        department || null, position || null, employment_type || 'full-time', join_date || null,
        base_salary || 0, hourly_rate || 0, bank_name || null, bank_account || null, bank_account_name || null,
        effectiveBranchId,
      ]
    );
    const [[emp]] = await db.query(
      `SELECT e.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ employee: emp });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Kode karyawan sudah ada' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/hr/employees/:id
router.put('/employees/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const fields = ['user_id','full_name','nik','phone','address','department','position',
      'employment_type','join_date','base_salary','hourly_rate','bank_name','bank_account',
      'bank_account_name','branch_id','status','pin_code','face_photo','face_descriptor'];
    const updates = [];
    const params = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) { 
        updates.push(`${f} = ?`); 
        params.push(req.body[f] === '' ? null : req.body[f]); 
      }
    });
    if (!updates.length) return res.status(400).json({ error: 'Tidak ada perubahan' });
    params.push(req.params.id);
    await db.query(`UPDATE employees SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
    const [[emp]] = await db.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    res.json({ employee: emp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/hr/employees/:id
router.delete('/employees/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    await db.query('UPDATE employees SET status = ? WHERE id = ?', ['inactive', req.params.id]);
    res.json({ message: 'Karyawan dinonaktifkan' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ATTENDANCE ──────────────────────────────────────────────

// GET /api/hr/attendance?employee_id=&date_from=&date_to=&branch_id=
router.get('/attendance', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { employee_id, date_from, date_to } = req.query;
    const branch_id = req.query.branch_id || req.user.branch_id || null;
    let sql = `
      SELECT a.*, e.full_name, e.employee_code, e.department, e.position, e.branch_id,
             s.shift_name, s.start_time AS shift_start, s.end_time AS shift_end
      FROM attendance a
      JOIN employees e ON e.id = a.employee_id
      LEFT JOIN work_shifts s ON s.id = a.shift_id
      WHERE 1=1
    `;
    const params = [];
    if (branch_id) { sql += ' AND e.branch_id = ?'; params.push(branch_id); }
    if (employee_id) { sql += ' AND a.employee_id = ?'; params.push(employee_id); }
    if (date_from) { sql += ' AND a.work_date >= ?'; params.push(date_from); }
    if (date_to) { sql += ' AND a.work_date <= ?'; params.push(date_to); }
    sql += ' ORDER BY a.work_date DESC, e.full_name';
    const [rows] = await db.query(sql, params);
    res.json({ attendance: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr/attendance/clock-in
router.post('/attendance/clock-in', authenticate, hrEnabled, async (req, res) => {
  try {
    const { employee_id, shift_id, notes } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id wajib' });
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toTimeString().slice(0, 8);

    // Cek sudah clock-in hari ini?
    const [[existing]] = await db.query(
      'SELECT id FROM attendance WHERE employee_id = ? AND work_date = ?',
      [employee_id, today]
    );
    if (existing) return res.status(409).json({ error: 'Sudah clock-in hari ini' });

    const [result] = await db.query(
      `INSERT INTO attendance (employee_id, shift_id, work_date, clock_in, status, notes, recorded_by)
       VALUES (?, ?, ?, ?, 'present', ?, ?)`,
      [employee_id, shift_id || null, today, now, notes || null, req.user.id]
    );
    const [[att]] = await db.query('SELECT a.*, e.full_name FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?', [result.insertId]);
    res.status(201).json({ attendance: att });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr/attendance/clock-out
router.post('/attendance/clock-out', authenticate, hrEnabled, async (req, res) => {
  try {
    const { employee_id, notes } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id wajib' });
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toTimeString().slice(0, 8);

    const [[att]] = await db.query(
      'SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? AND clock_out IS NULL',
      [employee_id, today]
    );
    if (!att) return res.status(404).json({ error: 'Belum clock-in atau sudah clock-out' });

    // Hitung total jam
    const [h1, m1] = att.clock_in.split(':').map(Number);
    const [h2, m2] = now.split(':').map(Number);
    const totalMins = (h2 * 60 + m2) - (h1 * 60 + m1);
    const totalHours = Math.max(0, parseFloat((totalMins / 60).toFixed(2)));

    await db.query(
      'UPDATE attendance SET clock_out = ?, total_hours = ?, notes = CONCAT(COALESCE(notes,""), ?) WHERE id = ?',
      [now, totalHours, notes ? ` | ${notes}` : '', att.id]
    );
    const [[updated]] = await db.query('SELECT a.*, e.full_name FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?', [att.id]);
    res.json({ attendance: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/hr/attendance/:id — edit manual (admin)
router.put('/attendance/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { clock_in, clock_out, status, notes, shift_id, overtime_hours } = req.body;
    const updates = [];
    const params = [];
    if (clock_in !== undefined) { updates.push('clock_in = ?'); params.push(clock_in); }
    if (clock_out !== undefined) { updates.push('clock_out = ?'); params.push(clock_out); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
    if (shift_id !== undefined) { updates.push('shift_id = ?'); params.push(shift_id); }
    if (overtime_hours !== undefined) { updates.push('overtime_hours = ?'); params.push(overtime_hours); }

    // Recalculate total hours if both clock_in and clock_out provided
    if (clock_in && clock_out) {
      const [h1, m1] = clock_in.split(':').map(Number);
      const [h2, m2] = clock_out.split(':').map(Number);
      const totalMins = (h2 * 60 + m2) - (h1 * 60 + m1);
      updates.push('total_hours = ?'); params.push(Math.max(0, parseFloat((totalMins / 60).toFixed(2))));
    }

    params.push(req.params.id);
    await db.query(`UPDATE attendance SET ${updates.join(', ')} WHERE id = ?`, params);
    const [[att]] = await db.query('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
    res.json({ attendance: att });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── WORK SHIFTS (jadwal shift) ──────────────────────────────

// GET /api/hr/work-shifts
router.get('/work-shifts', authenticate, hrEnabled, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM work_shifts WHERE is_active = 1 ORDER BY start_time');
    res.json({ shifts: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/work-shifts', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { shift_name, start_time, end_time, break_minutes, color } = req.body;
    if (!shift_name || !start_time || !end_time) return res.status(400).json({ error: 'shift_name, start_time, end_time wajib' });
    const [result] = await db.query(
      'INSERT INTO work_shifts (shift_name, start_time, end_time, break_minutes, color) VALUES (?, ?, ?, ?, ?)',
      [shift_name, start_time, end_time, break_minutes || 0, color || '#6366f1']
    );
    const [[s]] = await db.query('SELECT * FROM work_shifts WHERE id = ?', [result.insertId]);
    res.status(201).json({ shift: s });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/work-shifts/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { shift_name, start_time, end_time, break_minutes, color, is_active } = req.body;
    await db.query(
      'UPDATE work_shifts SET shift_name=COALESCE(?,shift_name), start_time=COALESCE(?,start_time), end_time=COALESCE(?,end_time), break_minutes=COALESCE(?,break_minutes), color=COALESCE(?,color), is_active=COALESCE(?,is_active) WHERE id=?',
      [shift_name||null, start_time||null, end_time||null, break_minutes??null, color||null, is_active??null, req.params.id]
    );
    const [[s]] = await db.query('SELECT * FROM work_shifts WHERE id = ?', [req.params.id]);
    res.json({ shift: s });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/work-shifts/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    await db.query('UPDATE work_shifts SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Shift dinonaktifkan' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SHIFT SWAP (tukar shift) ────────────────────────────────

// GET /api/hr/shift-swaps
router.get('/shift-swaps', authenticate, hrEnabled, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT ss.*,
        e1.full_name AS requester_name, e1.employee_code AS requester_code,
        e2.full_name AS target_name, e2.employee_code AS target_code,
        ws1.shift_name AS from_shift_name, ws2.shift_name AS to_shift_name
      FROM shift_swaps ss
      JOIN employees e1 ON e1.id = ss.requester_employee_id
      JOIN employees e2 ON e2.id = ss.target_employee_id
      LEFT JOIN work_shifts ws1 ON ws1.id = ss.from_shift_id
      LEFT JOIN work_shifts ws2 ON ws2.id = ss.to_shift_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { sql += ' AND ss.status = ?'; params.push(status); }
    sql += ' ORDER BY ss.created_at DESC';
    const [rows] = await db.query(sql, params);
    res.json({ swaps: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/shift-swaps', authenticate, hrEnabled, async (req, res) => {
  try {
    const { requester_employee_id, target_employee_id, from_date, to_date, from_shift_id, to_shift_id, reason } = req.body;
    if (!requester_employee_id || !target_employee_id || !from_date)
      return res.status(400).json({ error: 'Kolom wajib kurang' });
    const [result] = await db.query(
      `INSERT INTO shift_swaps (requester_employee_id, target_employee_id, from_date, to_date, from_shift_id, to_shift_id, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [requester_employee_id, target_employee_id, from_date, to_date || from_date, from_shift_id || null, to_shift_id || null, reason || null]
    );
    const [[swap]] = await db.query('SELECT * FROM shift_swaps WHERE id = ?', [result.insertId]);
    res.status(201).json({ swap });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/hr/shift-swaps/:id/approve | reject
router.put('/shift-swaps/:id/:action', authenticate, authorize('admin', 'kasir'), hrEnabled, async (req, res) => {
  try {
    const { action } = req.params;
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Action tidak valid' });
    const status = action === 'approve' ? 'approved' : 'rejected';
    await db.query(
      'UPDATE shift_swaps SET status = ?, approved_by = ?, approved_at = NOW(), notes = ? WHERE id = ?',
      [status, req.user.id, req.body?.notes || null, req.params.id]
    );
    const [[swap]] = await db.query('SELECT * FROM shift_swaps WHERE id = ?', [req.params.id]);
    res.json({ swap });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PAYROLL ─────────────────────────────────────────────────

// GET /api/hr/payroll?month=2025-01
router.get('/payroll', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { month } = req.query; // format: YYYY-MM
    if (!month) return res.status(400).json({ error: 'month wajib (format: YYYY-MM)' });
    const [rows] = await db.query(
      `SELECT p.*, e.full_name, e.employee_code, e.department, e.position,
              e.bank_name, e.bank_account, e.bank_account_name
       FROM payroll p
       JOIN employees e ON e.id = p.employee_id
       WHERE p.period_month = ?
       ORDER BY e.full_name`,
      [month]
    );
    res.json({ payroll: rows, month });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr/payroll/generate — generate payroll dari attendance & lembur bulan tsb
router.post('/payroll/generate', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { month, overwrite_paid } = req.body; // YYYY-MM
    if (!month) return res.status(400).json({ error: 'month wajib' });
    const dateFrom = `${month}-01`;
    const dateTo = new Date(month + '-01');
    dateTo.setMonth(dateTo.getMonth() + 1);
    dateTo.setDate(0);
    const dateToStr = dateTo.toISOString().slice(0, 10);

    const [settRows] = await db.query(
      "SELECT setting_key, setting_value FROM system_settings WHERE setting_key = 'hr_overtime_multiplier'"
    );
    const otMultiplier = parseFloat(settRows[0]?.setting_value || 1.5);

    // Get all active employees
    const [employees] = await db.query("SELECT * FROM employees WHERE status = 'active'");

    const generated = [];
    for (const emp of employees) {
      // Check existing payroll
      const [[existing]] = await db.query(
        'SELECT * FROM payroll WHERE employee_id = ? AND period_month = ?',
        [emp.id, month]
      );
      if (existing && existing.status === 'paid' && !overwrite_paid) {
        generated.push({ ...existing, skipped: true, employee_name: emp.full_name, reason: 'Sudah dibayar' });
        continue;
      }

      // Sum attendance hours
      const [[attStats]] = await db.query(
        `SELECT
           COUNT(*) AS work_days,
           COALESCE(SUM(total_hours), 0) AS total_hours,
           COALESCE(SUM(overtime_hours), 0) AS overtime_hours,
           SUM(status = 'absent') AS absent_days,
           SUM(status = 'sick') AS sick_days,
           SUM(status = 'leave') AS leave_days
         FROM attendance
         WHERE employee_id = ? AND work_date BETWEEN ? AND ?`,
        [emp.id, dateFrom, dateToStr]
      );

      // Sum approved overtime table
      const [[otStats]] = await db.query(
        `SELECT
           COALESCE(SUM(total_hours), 0) AS ot_hours,
           COALESCE(SUM(total_pay), 0) AS ot_pay
         FROM overtime
         WHERE employee_id = ? AND status = 'approved' AND overtime_date BETWEEN ? AND ?`,
        [emp.id, dateFrom, dateToStr]
      );

      const baseSalary = parseFloat(emp.base_salary || 0);
      const hourlyRate = parseFloat(emp.hourly_rate || 0);
      const workDays = parseInt(attStats.work_days || 0);
      const totalHours = parseFloat(attStats.total_hours || 0);
      const attOtHours = parseFloat(attStats.overtime_hours || 0);
      const extraOtHours = parseFloat(otStats.ot_hours || 0);
      const totalOtHours = parseFloat((attOtHours + extraOtHours).toFixed(2));

      // Overtime Pay Calculation
      const standardHourly = hourlyRate > 0 ? hourlyRate : (baseSalary > 0 ? baseSalary / 173 : 0);
      let calculatedOtPay = attOtHours * standardHourly * otMultiplier;
      const explicitOtPay = parseFloat(otStats.ot_pay || 0);
      if (explicitOtPay > 0) {
        calculatedOtPay += explicitOtPay;
      } else if (extraOtHours > 0) {
        calculatedOtPay += extraOtHours * standardHourly * otMultiplier;
      }
      const overtimePay = parseFloat(calculatedOtPay.toFixed(2));

      // Calculation
      let grossSalary = baseSalary;
      if (emp.employment_type === 'hourly' && hourlyRate > 0) {
        grossSalary = totalHours * hourlyRate;
      }
      const totalGross = parseFloat((grossSalary + overtimePay).toFixed(2));

      if (existing) {
        const bonus = parseFloat(existing.bonus || 0);
        const deductions = parseFloat(existing.deductions || 0);
        const totalNet = parseFloat((totalGross + bonus - deductions).toFixed(2));

        await db.query(
          `UPDATE payroll SET
             base_salary = ?, total_hours = ?, overtime_hours = ?, overtime_pay = ?,
             gross_salary = ?, net_salary = ?, work_days = ?, absent_days = ?,
             sick_days = ?, leave_days = ?, updated_at = NOW()
           WHERE id = ?`,
          [baseSalary, totalHours, totalOtHours, overtimePay, totalGross, totalNet,
           workDays, attStats.absent_days || 0, attStats.sick_days || 0, attStats.leave_days || 0, existing.id]
        );

        if (existing.status === 'paid') {
          await db.query('UPDATE expenses SET amount = ? WHERE reference = ?', [totalNet, `PAYROLL-${existing.id}`]);
        }

        generated.push({ id: existing.id, employee_name: emp.full_name, net_salary: totalNet, updated: true });
      } else {
        const [result] = await db.query(
          `INSERT INTO payroll
            (employee_id, period_month, base_salary, total_hours, overtime_hours, overtime_pay,
             gross_salary, bonus, deductions, net_salary, work_days, absent_days, sick_days, leave_days, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'draft')`,
          [emp.id, month, baseSalary, totalHours, totalOtHours, overtimePay, totalGross, totalGross,
           workDays, attStats.absent_days || 0, attStats.sick_days || 0, attStats.leave_days || 0]
        );
        generated.push({ id: result.insertId, employee_name: emp.full_name, net_salary: totalGross, created: true });
      }
    }

    const updatedCount = generated.filter(g => g.updated).length;
    const createdCount = generated.filter(g => g.created).length;
    const skippedCount = generated.filter(g => g.skipped).length;

    let msg = `Payroll selesai diproses: `;
    const parts = [];
    if (createdCount > 0) parts.push(`${createdCount} baru dibuat`);
    if (updatedCount > 0) parts.push(`${updatedCount} diperbarui`);
    if (skippedCount > 0) parts.push(`${skippedCount} di-skip (sudah dibayar)`);
    msg += parts.join(', ') || 'tidak ada perubahan';

    res.json({ message: msg, payroll: generated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/hr/payroll/:id — edit/adjust payroll (bisa untuk draft ataupun paid bagi owner)
router.put('/payroll/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { base_salary, overtime_hours, overtime_pay, deductions, notes, status, bonus } = req.body;
    const [[p]] = await db.query('SELECT * FROM payroll WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Payroll tidak ditemukan' });

    const newBaseSalary = base_salary !== undefined ? parseFloat(base_salary) : parseFloat(p.base_salary || 0);
    const newOtHours = overtime_hours !== undefined ? parseFloat(overtime_hours) : parseFloat(p.overtime_hours || 0);
    const newOtPay = overtime_pay !== undefined ? parseFloat(overtime_pay) : parseFloat(p.overtime_pay || 0);
    const newBonus = bonus !== undefined ? parseFloat(bonus) : parseFloat(p.bonus || 0);
    const newDeductions = deductions !== undefined ? parseFloat(deductions) : parseFloat(p.deductions || 0);

    const newGross = parseFloat((newBaseSalary + newOtPay).toFixed(2));
    const newNet = parseFloat((newGross + newBonus - newDeductions).toFixed(2));

    await db.query(
      `UPDATE payroll SET
         base_salary = ?,
         overtime_hours = ?,
         overtime_pay = ?,
         gross_salary = ?,
         bonus = ?,
         deductions = ?,
         net_salary = ?,
         notes = COALESCE(?, notes),
         status = COALESCE(?, status),
         updated_at = NOW()
       WHERE id = ?`,
      [
        newBaseSalary,
        newOtHours,
        newOtPay,
        newGross,
        newBonus,
        newDeductions,
        newNet,
        notes !== undefined ? notes : null,
        status !== undefined ? status : null,
        req.params.id
      ]
    );

    // Sync expense if payroll is paid
    if (p.status === 'paid' || status === 'paid') {
      await db.query(
        'UPDATE expenses SET amount = ? WHERE reference = ?',
        [newNet, `PAYROLL-${p.id}`]
      );
    }

    const [[updated]] = await db.query(
      `SELECT p.*, e.full_name, e.employee_code, e.department, e.position
       FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`,
      [req.params.id]
    );
    res.json({ payroll: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr/payroll/:id/recalculate — hitung ulang satu slip gaji dari absensi & lembur
router.post('/payroll/:id/recalculate', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const [[p]] = await db.query(
      `SELECT p.*, e.base_salary AS emp_base_salary, e.hourly_rate, e.employment_type, e.full_name
       FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`,
      [req.params.id]
    );
    if (!p) return res.status(404).json({ error: 'Payroll tidak ditemukan' });

    const month = p.period_month;
    const dateFrom = `${month}-01`;
    const dateTo = new Date(month + '-01');
    dateTo.setMonth(dateTo.getMonth() + 1);
    dateTo.setDate(0);
    const dateToStr = dateTo.toISOString().slice(0, 10);

    const [settRows] = await db.query(
      "SELECT setting_key, setting_value FROM system_settings WHERE setting_key = 'hr_overtime_multiplier'"
    );
    const otMultiplier = parseFloat(settRows[0]?.setting_value || 1.5);

    const [[attStats]] = await db.query(
      `SELECT
         COUNT(*) AS work_days,
         COALESCE(SUM(total_hours), 0) AS total_hours,
         COALESCE(SUM(overtime_hours), 0) AS overtime_hours,
         SUM(status = 'absent') AS absent_days,
         SUM(status = 'sick') AS sick_days,
         SUM(status = 'leave') AS leave_days
       FROM attendance
       WHERE employee_id = ? AND work_date BETWEEN ? AND ?`,
      [p.employee_id, dateFrom, dateToStr]
    );

    const [[otStats]] = await db.query(
      `SELECT
         COALESCE(SUM(total_hours), 0) AS ot_hours,
         COALESCE(SUM(total_pay), 0) AS ot_pay
       FROM overtime
       WHERE employee_id = ? AND status = 'approved' AND overtime_date BETWEEN ? AND ?`,
      [p.employee_id, dateFrom, dateToStr]
    );

    const baseSalary = parseFloat(p.emp_base_salary || p.base_salary || 0);
    const hourlyRate = parseFloat(p.hourly_rate || 0);
    const workDays = parseInt(attStats.work_days || 0);
    const totalHours = parseFloat(attStats.total_hours || 0);

    const attOtHours = parseFloat(attStats.overtime_hours || 0);
    const extraOtHours = parseFloat(otStats.ot_hours || 0);
    const totalOtHours = parseFloat((attOtHours + extraOtHours).toFixed(2));

    const standardHourly = hourlyRate > 0 ? hourlyRate : (baseSalary > 0 ? baseSalary / 173 : 0);
    let calculatedOtPay = attOtHours * standardHourly * otMultiplier;
    const explicitOtPay = parseFloat(otStats.ot_pay || 0);
    if (explicitOtPay > 0) {
      calculatedOtPay += explicitOtPay;
    } else if (extraOtHours > 0) {
      calculatedOtPay += extraOtHours * standardHourly * otMultiplier;
    }
    const overtimePay = parseFloat(calculatedOtPay.toFixed(2));

    let grossSalary = baseSalary;
    if (p.employment_type === 'hourly' && hourlyRate > 0) {
      grossSalary = totalHours * hourlyRate;
    }
    const totalGross = parseFloat((grossSalary + overtimePay).toFixed(2));
    const bonus = parseFloat(p.bonus || 0);
    const deductions = parseFloat(p.deductions || 0);
    const totalNet = parseFloat((totalGross + bonus - deductions).toFixed(2));

    await db.query(
      `UPDATE payroll SET
         base_salary = ?, total_hours = ?, overtime_hours = ?, overtime_pay = ?,
         gross_salary = ?, net_salary = ?, work_days = ?, absent_days = ?,
         sick_days = ?, leave_days = ?, updated_at = NOW()
       WHERE id = ?`,
      [baseSalary, totalHours, totalOtHours, overtimePay, totalGross, totalNet,
       workDays, attStats.absent_days || 0, attStats.sick_days || 0, attStats.leave_days || 0, p.id]
    );

    if (p.status === 'paid') {
      await db.query('UPDATE expenses SET amount = ? WHERE reference = ?', [totalNet, `PAYROLL-${p.id}`]);
    }

    const [[updated]] = await db.query(
      `SELECT p.*, e.full_name, e.employee_code, e.department, e.position
       FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`,
      [p.id]
    );

    res.json({ message: `Slip gaji ${p.full_name} berhasil dihitung ulang`, payroll: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr/payroll/:id/unpay — batalkan status bayar & hapus dari expenses (owner/admin)
router.post('/payroll/:id/unpay', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const [[p]] = await db.query(
      `SELECT p.*, e.full_name FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`,
      [req.params.id]
    );
    if (!p) return res.status(404).json({ error: 'Payroll tidak ditemukan' });
    if (p.status !== 'paid') return res.status(400).json({ error: 'Payroll belum berstatus dibayar' });

    await db.query(
      "UPDATE payroll SET status='draft', paid_at=NULL, paid_by=NULL, updated_at=NOW() WHERE id=?",
      [req.params.id]
    );

    // Hapus pencatatan pengeluaran terkait
    await db.query(
      "DELETE FROM expenses WHERE reference = ?",
      [`PAYROLL-${p.id}`]
    );

    res.json({ message: `Pembayaran gaji ${p.full_name} berhasil dibatalkan, status kembali ke Draft`, payroll_id: p.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr/payroll/:id/pay — mark as paid + catat ke expenses
router.post('/payroll/:id/pay', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const [[p]] = await db.query(
      `SELECT p.*, e.full_name, e.employee_code FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`,
      [req.params.id]
    );
    if (!p) return res.status(404).json({ error: 'Payroll tidak ditemukan' });
    if (p.status === 'paid') return res.status(409).json({ error: 'Sudah dibayar' });

    await db.query(
      "UPDATE payroll SET status='paid', paid_at=NOW(), paid_by=? WHERE id=?",
      [req.user.id, req.params.id]
    );

    // Auto-insert ke expenses
    const [[expCat]] = await db.query(
      "SELECT id FROM expense_categories WHERE LOWER(name) LIKE '%gaji%' OR LOWER(name) LIKE '%payroll%' LIMIT 1"
    );
    const catId = expCat?.id || null;

    const expNumber = `EXP-PAY-${Date.now().toString().slice(-8)}`;
    const expTitle = `Gaji ${p.full_name} - ${p.period_month}`;
    await db.query(
      `INSERT INTO expenses (expense_number, category_id, title, amount, description, expense_date, payment_method, reference, created_by, status)
       VALUES (?, ?, ?, ?, ?, CURDATE(), 'transfer', ?, ?, 'approved')`,
      [
        expNumber,
        catId,
        expTitle,
        p.net_salary,
        `${expTitle} (${p.employee_code})`,
        `PAYROLL-${p.id}`,
        req.user.id,
      ]
    );

    res.json({ message: 'Gaji dibayar dan dicatat ke pengeluaran', payroll_id: p.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SUMMARY (untuk dashboard / laporan) ────────────────────

// GET /api/hr/summary?month=YYYY-MM
router.get('/summary', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const dateFrom = `${month}-01`;
    const dateTo = new Date(month + '-01');
    dateTo.setMonth(dateTo.getMonth() + 1); dateTo.setDate(0);
    const dateToStr = dateTo.toISOString().slice(0, 10);

    const [[empStats]] = await db.query(
      "SELECT COUNT(*) AS total, SUM(status='active') AS active, SUM(status='inactive') AS inactive FROM employees"
    );
    const [[attStats]] = await db.query(
      `SELECT COUNT(*) AS total_records,
              COALESCE(SUM(total_hours),0) AS total_hours,
              SUM(status='present') AS present,
              SUM(status='absent') AS absent,
              SUM(status='sick') AS sick,
              SUM(status='late') AS late
       FROM attendance WHERE work_date BETWEEN ? AND ?`,
      [dateFrom, dateToStr]
    );
    const [[payStats]] = await db.query(
      `SELECT COUNT(*) AS total_slips,
              COALESCE(SUM(net_salary),0) AS total_payroll,
              SUM(status='paid') AS paid_count,
              SUM(status='draft') AS draft_count
       FROM payroll WHERE period_month = ?`,
      [month]
    );
    const [[swapStats]] = await db.query(
      "SELECT COUNT(*) AS total, SUM(status='pending') AS pending FROM shift_swaps"
    );
    const [[kpiStats]] = await db.query(
      "SELECT COUNT(*) AS filled FROM employee_kpi WHERE period_month=?", [month]
    );

    res.json({
      month,
      employees: empStats,
      attendance: attStats,
      payroll: payStats,
      shift_swaps: swapStats,
      kpi: kpiStats,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SETTINGS ────────────────────────────────────────────────

// GET /api/hr/settings
router.get('/settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const keys = ['hr_enabled', 'hr_work_days_per_week', 'hr_work_hours_per_day', 'hr_overtime_multiplier', 'hr_payroll_day'];
    const placeholders = keys.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${placeholders})`,
      keys
    );
    const settings = {};
    keys.forEach(k => { settings[k] = null; });
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    res.json({ settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/hr/settings
router.put('/settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const keys = ['hr_enabled', 'hr_work_days_per_week', 'hr_work_hours_per_day', 'hr_overtime_multiplier', 'hr_payroll_day'];
    for (const key of keys) {
      if (req.body[key] !== undefined) {
        await db.query(
          'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
          [key, String(req.body[key])]
        );
      }
    }
    const [rows] = await db.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${keys.map(()=>'?').join(',')})`, keys);
    const settings = {};
    keys.forEach(k => { settings[k] = null; });
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    res.json({ settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ADVANCED SETTINGS ───────────────────────────────────────

router.get('/advanced-settings', authenticate, authorize('admin'), async (req, res) => {
  const keys = ['hr_advanced_enabled','attendance_office_lat','attendance_office_lng',
    'attendance_radius_meters','attendance_allowed_methods','attendance_require_selfie','attendance_face_api_url'];
  try {
    const [rows] = await db.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${keys.map(()=>'?').join(',')})`, keys);
    const s = {}; keys.forEach(k=>{s[k]=null}); rows.forEach(r=>{s[r.setting_key]=r.setting_value});
    res.json({ settings: s });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/advanced-settings', authenticate, authorize('admin'), async (req, res) => {
  const keys = ['hr_advanced_enabled','attendance_office_lat','attendance_office_lng',
    'attendance_radius_meters','attendance_allowed_methods','attendance_require_selfie','attendance_face_api_url'];
  try {
    for (const k of keys) {
      if (req.body[k] !== undefined) {
        await db.query('INSERT INTO system_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)', [k, String(req.body[k])]);
      }
    }
    const [rows] = await db.query(`SELECT setting_key,setting_value FROM system_settings WHERE setting_key IN (${keys.map(()=>'?').join(',')})`, keys);
    const s = {}; keys.forEach(k=>{s[k]=null}); rows.forEach(r=>{s[r.setting_key]=r.setting_value});
    res.json({ settings: s });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── SCHEDULES ───────────────────────────────────────────────

router.get('/schedules', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { employee_id, date_from, date_to, week_start } = req.query;
    let sql = `
      SELECT es.*, e.full_name, e.employee_code, e.department,
             ws.shift_name, ws.start_time, ws.end_time, ws.color
      FROM employee_schedules es
      JOIN employees e ON e.id = es.employee_id
      LEFT JOIN work_shifts ws ON ws.id = es.shift_id
      WHERE 1=1
    `;
    const params = [];
    if (employee_id) { sql += ' AND es.employee_id=?'; params.push(employee_id); }
    if (date_from) { sql += ' AND es.work_date>=?'; params.push(date_from); }
    if (date_to) { sql += ' AND es.work_date<=?'; params.push(date_to); }
    if (week_start) {
      sql += ' AND es.work_date>=? AND es.work_date<=DATE_ADD(?,INTERVAL 6 DAY)';
      params.push(week_start, week_start);
    }
    sql += ' ORDER BY es.work_date, e.full_name';
    const [rows] = await db.query(sql, params);
    res.json({ schedules: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/schedules', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { employee_id, work_date, shift_id, notes } = req.body;
    if (!employee_id || !work_date) return res.status(400).json({ error: 'employee_id dan work_date wajib' });
    const [result] = await db.query(
      'INSERT INTO employee_schedules (employee_id, work_date, shift_id, notes, created_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE shift_id=VALUES(shift_id), notes=VALUES(notes), status="scheduled"',
      [employee_id, work_date, shift_id||null, notes||null, req.user.id]
    );
    const [[sched]] = await db.query(`
      SELECT es.*, e.full_name, ws.shift_name, ws.start_time, ws.end_time, ws.color
      FROM employee_schedules es JOIN employees e ON e.id=es.employee_id LEFT JOIN work_shifts ws ON ws.id=es.shift_id
      WHERE es.employee_id=? AND es.work_date=?`, [employee_id, work_date]);
    res.status(201).json({ schedule: sched });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Bulk schedule: assign shift to multiple employees for date range
router.post('/schedules/bulk', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { employee_ids, date_from, date_to, shift_id, skip_days = [] } = req.body;
    if (!employee_ids?.length || !date_from || !date_to) return res.status(400).json({ error: 'employee_ids, date_from, date_to wajib' });
    const start = new Date(date_from), end = new Date(date_to);
    let count = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
      const dayOfWeek = d.getDay(); // 0=Sun,6=Sat
      if (skip_days.includes(dayOfWeek)) continue;
      const dateStr = d.toISOString().slice(0,10);
      for (const empId of employee_ids) {
        await db.query(
          'INSERT INTO employee_schedules (employee_id,work_date,shift_id,created_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE shift_id=VALUES(shift_id)',
          [empId, dateStr, shift_id||null, req.user.id]
        );
        count++;
      }
    }
    res.json({ message: `${count} jadwal dibuat/diperbarui` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/schedules/bulk-delete', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { date_from, date_to } = req.body;
    if (!date_from || !date_to) return res.status(400).json({ error: 'date_from, date_to wajib' });
    const [result] = await db.query(
      'DELETE FROM employee_schedules WHERE work_date >= ? AND work_date <= ?',
      [date_from, date_to]
    );
    res.json({ message: `${result.affectedRows} jadwal dihapus` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/schedules/auto-generate', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { date_from, date_to, algorithm = 'fair_rotation', off_days_count = 1, randomize = true } = req.body;
    if (!date_from || !date_to) return res.status(400).json({ error: 'date_from, date_to wajib' });
    
    const [employees] = await db.query('SELECT id, full_name, department FROM employees WHERE status="active" ORDER BY id');
    const [shifts] = await db.query('SELECT id, shift_name FROM work_shifts WHERE is_active=1 ORDER BY start_time');
    
    if (!employees.length || !shifts.length) {
      return res.status(400).json({ error: 'Data karyawan aktif atau shift kosong' });
    }

    const start = new Date(date_from), end = new Date(date_to);
    let count = 0;
    const numShifts = shifts.length;
    const numEmp = employees.length;

    // Seed or random offset so that generating again doesn't produce identical patterns!
    const baseShiftOffset = randomize ? Math.floor(Math.random() * numShifts) : 0;
    const randomOffDaySeed = randomize ? Math.floor(Math.random() * 7) : 0;

    // Map each employee to a staggered off-day (0=Sun .. 6=Sat)
    const empOffDays = {};
    employees.forEach((emp, i) => {
      const primaryOff = (i * 2 + randomOffDaySeed) % 7;
      const secondaryOff = (primaryOff + 3) % 7;
      empOffDays[emp.id] = parseInt(off_days_count) === 2 ? [primaryOff, secondaryOff] : [primaryOff];
    });

    if (algorithm === 'department') {
      // Group employees by department
      const depts = {};
      employees.forEach(emp => {
        const dept = emp.department || 'Umum';
        if (!depts[dept]) depts[dept] = [];
        depts[dept].push(emp);
      });

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const dayOfWeek = d.getDay();
        const dayIndex = Math.floor((d - start) / (1000 * 60 * 60 * 24));

        for (const [dept, deptEmps] of Object.entries(depts)) {
          for (let deptIdx = 0; deptIdx < deptEmps.length; deptIdx++) {
            const emp = deptEmps[deptIdx];
            const isOff = empOffDays[emp.id].includes(dayOfWeek);
            if (isOff) continue;

            const shiftIndex = (deptIdx + dayIndex + baseShiftOffset) % numShifts;
            const shiftId = shifts[shiftIndex].id;

            await db.query(
              'INSERT INTO employee_schedules (employee_id,work_date,shift_id,created_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE shift_id=VALUES(shift_id)',
              [emp.id, dateStr, shiftId, req.user.id]
            );
            count++;
          }
        }
      }
    } else if (algorithm === 'fair_shuffle') {
      // Fair randomized allocation per day
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const dayOfWeek = d.getDay();

        // Filter working employees today (not off)
        const workingEmps = employees.filter(emp => !empOffDays[emp.id].includes(dayOfWeek));
        // Shuffle working employees
        const shuffled = [...workingEmps].sort(() => Math.random() - 0.5);

        for (let i = 0; i < shuffled.length; i++) {
          const shiftIndex = i % numShifts;
          const shiftId = shifts[shiftIndex].id;
          await db.query(
            'INSERT INTO employee_schedules (employee_id,work_date,shift_id,created_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE shift_id=VALUES(shift_id)',
            [shuffled[i].id, dateStr, shiftId, req.user.id]
          );
          count++;
        }
      }
    } else {
      // 'fair_rotation' — Progressive shift rotation with varied off-days
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dayIndex = Math.floor((d - start) / (1000 * 60 * 60 * 24));
        const dateStr = d.toISOString().slice(0, 10);
        const dayOfWeek = d.getDay();

        for (let i = 0; i < numEmp; i++) {
          const isOff = empOffDays[employees[i].id].includes(dayOfWeek);
          if (isOff) continue;

          const shiftIndex = (i + dayIndex + baseShiftOffset) % numShifts;
          const shiftId = shifts[shiftIndex].id;

          await db.query(
            'INSERT INTO employee_schedules (employee_id,work_date,shift_id,created_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE shift_id=VALUES(shift_id)',
            [employees[i].id, dateStr, shiftId, req.user.id]
          );
          count++;
        }
      }
    }

    const algoName = algorithm === 'department' ? 'Berbasis Departemen' : algorithm === 'fair_shuffle' ? 'Acak Adil & Merata' : 'Rotasi Cerdas';
    res.json({ message: `${count} jadwal berhasil dibuat (${algoName})` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/schedules/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    await db.query('DELETE FROM employee_schedules WHERE id=?', [req.params.id]);
    res.json({ message: 'Jadwal dihapus' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/schedules/:id/move', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { target_employee_id, target_date } = req.body;
    if (!target_employee_id || !target_date) return res.status(400).json({ error: 'target_employee_id dan target_date wajib' });
    
    // Check if target already has a schedule
    const [[existing]] = await db.query(
      'SELECT id, shift_id, notes FROM employee_schedules WHERE employee_id = ? AND work_date = ?',
      [target_employee_id, target_date]
    );

    if (existing) {
      if (existing.id == req.params.id) return res.json({ message: 'Tidak ada perubahan' });
      // Swap shift_id and notes
      const [[source]] = await db.query('SELECT shift_id, notes FROM employee_schedules WHERE id = ?', [req.params.id]);
      await db.query('UPDATE employee_schedules SET shift_id = ?, notes = ? WHERE id = ?', [source.shift_id, source.notes, existing.id]);
      await db.query('UPDATE employee_schedules SET shift_id = ?, notes = ? WHERE id = ?', [existing.shift_id, existing.notes, req.params.id]);
      return res.json({ message: 'Jadwal berhasil ditukar (swap)' });
    } else {
      // Move (update employee_id and work_date)
      await db.query(
        'UPDATE employee_schedules SET employee_id = ?, work_date = ? WHERE id = ?',
        [target_employee_id, target_date, req.params.id]
      );
      return res.json({ message: 'Jadwal berhasil dipindahkan' });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── ADVANCED CLOCK-IN (GPS + Selfie) ───────────────────────

router.post('/attendance/clock-in-advanced', authenticate, hrEnabled, async (req, res) => {
  try {
    const { employee_id, shift_id, method = 'manual', latitude, longitude, selfie_photo, notes } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id wajib' });
    const today = new Date().toISOString().slice(0,10);
    const now = new Date().toTimeString().slice(0,8);

    // Check duplicate
    const [[existing]] = await db.query('SELECT id FROM attendance WHERE employee_id=? AND work_date=?', [employee_id, today]);
    if (existing) return res.status(409).json({ error: 'Sudah clock-in hari ini' });

    // GPS radius check if method = gps
    let distanceMeters = null;
    let isVerified = method === 'manual' ? 1 : 0;
    if (method === 'gps' && latitude && longitude) {
      const [[latSetting]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='attendance_office_lat'");
      const [[lngSetting]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='attendance_office_lng'");
      const [[radiusSetting]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='attendance_radius_meters'");
      const officeLat = parseFloat(latSetting?.setting_value || 0);
      const officeLng = parseFloat(lngSetting?.setting_value || 0);
      const allowedRadius = parseInt(radiusSetting?.setting_value || 100);
      // Haversine
      const R = 6371000;
      const dLat = (latitude - officeLat) * Math.PI/180;
      const dLng = (longitude - officeLng) * Math.PI/180;
      const a = Math.sin(dLat/2)**2 + Math.cos(officeLat*Math.PI/180)*Math.cos(latitude*Math.PI/180)*Math.sin(dLng/2)**2;
      distanceMeters = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
      isVerified = distanceMeters <= allowedRadius ? 1 : 0;
      if (!isVerified) return res.status(400).json({ error: `Di luar radius. Jarak Anda: ${distanceMeters}m, batas: ${allowedRadius}m` });
    }

    const [result] = await db.query(
      `INSERT INTO attendance (employee_id, shift_id, work_date, clock_in, status, notes, recorded_by, method, latitude, longitude, distance_meters, selfie_photo, is_verified)
       VALUES (?, ?, ?, ?, 'present', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employee_id, shift_id||null, today, now, notes||null, req.user.id, method, latitude||null, longitude||null, distanceMeters, selfie_photo||null, isVerified]
    );
    const [[att]] = await db.query('SELECT a.*,e.full_name FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.id=?', [result.insertId]);
    res.status(201).json({ attendance: att, distance_meters: distanceMeters });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── KPI ─────────────────────────────────────────────────────

router.get('/kpi/metrics', authenticate, authorize('admin','kasir'), hrEnabled, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM kpi_metrics WHERE is_active=1 ORDER BY sort_order, name');
    res.json({ metrics: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/kpi/metrics', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { name, description, unit, target_type, higher_is_better } = req.body;
    if (!name) return res.status(400).json({ error: 'name wajib' });
    const [r] = await db.query(
      'INSERT INTO kpi_metrics (name,description,unit,target_type,higher_is_better) VALUES (?,?,?,?,?)',
      [name, description||null, unit||null, target_type||'numeric', higher_is_better!==false?1:0]
    );
    const [[m]] = await db.query('SELECT * FROM kpi_metrics WHERE id=?', [r.insertId]);
    res.status(201).json({ metric: m });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/kpi/metrics/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { name, description, unit, target_type, higher_is_better, is_active, sort_order } = req.body;
    await db.query(
      'UPDATE kpi_metrics SET name=COALESCE(?,name),description=COALESCE(?,description),unit=COALESCE(?,unit),target_type=COALESCE(?,target_type),higher_is_better=COALESCE(?,higher_is_better),is_active=COALESCE(?,is_active),sort_order=COALESCE(?,sort_order) WHERE id=?',
      [name||null,description||null,unit||null,target_type||null,higher_is_better??null,is_active??null,sort_order??null,req.params.id]
    );
    const [[m]] = await db.query('SELECT * FROM kpi_metrics WHERE id=?', [req.params.id]);
    res.json({ metric: m });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /hr/kpi?employee_id=&month=YYYY-MM
router.get('/kpi', authenticate, hrEnabled, async (req, res) => {
  try {
    const { employee_id, month } = req.query;
    if (!month) return res.status(400).json({ error: 'month wajib' });
    let sql = `
      SELECT ek.*, e.full_name, e.employee_code, e.department,
             km.name AS metric_name, km.unit, km.target_type, km.higher_is_better
      FROM employee_kpi ek
      JOIN employees e ON e.id=ek.employee_id
      JOIN kpi_metrics km ON km.id=ek.metric_id
      WHERE ek.period_month=?
    `;
    const params = [month];
    if (employee_id) { sql += ' AND ek.employee_id=?'; params.push(employee_id); }
    sql += ' ORDER BY e.full_name, km.sort_order';
    const [rows] = await db.query(sql, params);
    res.json({ kpi: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /hr/kpi — upsert
router.post('/kpi', authenticate, authorize('admin','kasir'), hrEnabled, async (req, res) => {
  try {
    const { employee_id, metric_id, period_month, target_value, actual_value, notes } = req.body;
    if (!employee_id || !metric_id || !period_month) return res.status(400).json({ error: 'employee_id, metric_id, period_month wajib' });
    // Auto-calculate score
    const target = parseFloat(target_value || 0);
    const actual = parseFloat(actual_value || 0);
    const score = target > 0 ? Math.min(100, parseFloat((actual/target*100).toFixed(2))) : 0;
    await db.query(
      `INSERT INTO employee_kpi (employee_id,metric_id,period_month,target_value,actual_value,score,notes,recorded_by)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE target_value=VALUES(target_value),actual_value=VALUES(actual_value),score=VALUES(score),notes=VALUES(notes),recorded_by=VALUES(recorded_by)`,
      [employee_id, metric_id, period_month, target, actual, score, notes||null, req.user.id]
    );
    const [[kpi]] = await db.query(`
      SELECT ek.*,e.full_name,km.name AS metric_name,km.unit
      FROM employee_kpi ek JOIN employees e ON e.id=ek.employee_id JOIN kpi_metrics km ON km.id=ek.metric_id
      WHERE ek.employee_id=? AND ek.metric_id=? AND ek.period_month=?`, [employee_id, metric_id, period_month]);
    res.json({ kpi });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /hr/kpi/summary?month=&employee_id= — average score per employee
router.get('/kpi/summary', authenticate, hrEnabled, async (req, res) => {
  try {
    const { month, employee_id } = req.query;
    if (!month) return res.status(400).json({ error: 'month wajib' });
    let sql = `
      SELECT e.id, e.full_name, e.employee_code, e.department, e.position,
             COUNT(ek.id) AS metric_count,
             ROUND(AVG(ek.score),1) AS avg_score,
             MIN(ek.score) AS min_score,
             MAX(ek.score) AS max_score
      FROM employees e
      LEFT JOIN employee_kpi ek ON ek.employee_id=e.id AND ek.period_month=?
      WHERE e.status='active'
    `;
    const params = [month];
    if (employee_id) { sql += ' AND e.id=?'; params.push(employee_id); }
    sql += ' GROUP BY e.id ORDER BY avg_score DESC';
    const [rows] = await db.query(sql, params);
    res.json({ summary: rows, month });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── EMPLOYEE ADVANCED PROFILE ───────────────────────────────

// PUT /hr/employees/:id/advanced — update advanced fields
router.put('/employees/:id/advanced', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const advancedFields = ['ktp_number','ktp_photo','birth_date','birth_place','gender',
      'marital_status','blood_type','religion','education','emergency_contact_name',
      'emergency_contact_phone','emergency_contact_relation','photo','pin_code','face_photo','face_descriptor'];
    const updates = []; const params = [];
    advancedFields.forEach(f => {
      if (req.body[f] !== undefined) { updates.push(`${f}=?`); params.push(req.body[f]||null); }
    });
    if (!updates.length) return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    params.push(req.params.id);
    await db.query(`UPDATE employees SET ${updates.join(',')}, updated_at=NOW() WHERE id=?`, params);
    const [[emp]] = await db.query('SELECT * FROM employees WHERE id=?', [req.params.id]);
    res.json({ employee: emp });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /hr/employees/:id/schedule?date_from=&date_to= — employee schedule with attendance status
router.get('/employees/:id/schedule', authenticate, hrEnabled, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: 'date_from dan date_to wajib' });
    // Merge schedule + attendance
    const [schedules] = await db.query(`
      SELECT es.work_date, es.shift_id, es.status AS schedule_status,
             ws.shift_name, ws.start_time, ws.end_time, ws.color,
             a.id AS att_id, a.clock_in, a.clock_out, a.total_hours, a.status AS att_status,
             a.method, a.distance_meters, a.is_verified
      FROM employee_schedules es
      LEFT JOIN work_shifts ws ON ws.id=es.shift_id
      LEFT JOIN attendance a ON a.employee_id=es.employee_id AND a.work_date=es.work_date
      WHERE es.employee_id=? AND es.work_date BETWEEN ? AND ?
      ORDER BY es.work_date`, [req.params.id, date_from, date_to]);
    res.json({ schedule: schedules });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── OVERTIME ────────────────────────────────────────────────

// ─── KIOSK ATTENDANCE (No Auth Required) ─────────────────────
const kioskRouter = express.Router();

async function getKioskTimezone() {
  try {
    const [[tzSetting]] = await db.query(
      "SELECT setting_value FROM system_settings WHERE setting_key IN ('attendance_timezone', 'timezone') ORDER BY FIELD(setting_key, 'attendance_timezone', 'timezone') LIMIT 1"
    );
    if (tzSetting?.setting_value) return tzSetting.setting_value;
    const [[mainBranch]] = await db.query(
      "SELECT timezone FROM branches WHERE is_main = 1 OR is_active = 1 LIMIT 1"
    );
    return mainBranch?.timezone || 'Asia/Jakarta';
  } catch (_) {
    return 'Asia/Jakarta';
  }
}

function getZonedTime(timezone = 'Asia/Jakarta', dateObj = new Date()) {
  try {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(dateObj);

    const now = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(dateObj);

    return { today, now };
  } catch (_) {
    return {
      today: dateObj.toISOString().slice(0, 10),
      now: dateObj.toTimeString().slice(0, 8)
    };
  }
}

// GET /api/kiosk/time — get server time & configured timezone
kioskRouter.get('/time', async (req, res) => {
  try {
    const timezone = await getKioskTimezone();
    const now = new Date();
    const { today, now: timeStr } = getZonedTime(timezone, now);

    let timezone_abbr = 'WIB';
    let timezone_label = 'Waktu Indonesia Barat (WIB)';
    if (timezone === 'Asia/Makassar') {
      timezone_abbr = 'WITA';
      timezone_label = 'Waktu Indonesia Tengah (WITA)';
    } else if (timezone === 'Asia/Jayapura') {
      timezone_abbr = 'WIT';
      timezone_label = 'Waktu Indonesia Timur (WIT)';
    } else if (timezone === 'Asia/Jakarta') {
      timezone_abbr = 'WIB';
      timezone_label = 'Waktu Indonesia Barat (WIB)';
    } else {
      timezone_abbr = timezone;
      timezone_label = timezone;
    }

    const dateFormatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    res.json({
      server_time: now.getTime(),
      iso: now.toISOString(),
      timezone,
      timezone_abbr,
      timezone_label,
      today,
      formatted_time: timeStr.replace(/:/g, '.'),
      formatted_date: dateFormatter.format(now)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kiosk/employees — list active employees with today's status & shift
kioskRouter.get('/employees', async (req, res) => {
  try {
    const timezone = await getKioskTimezone();
    const { today } = getZonedTime(timezone);
    const { search, q, limit } = req.query;
    const searchTerm = (search || q || '').trim();

    let sql = `
      SELECT e.id, e.employee_code, e.full_name, e.department, e.position,
             e.photo, e.face_photo, e.face_descriptor,
             (CASE WHEN e.pin_code IS NOT NULL AND e.pin_code != '' THEN 1 ELSE 0 END) AS has_pin,
             a.id AS attendance_id, a.clock_in, a.clock_out, a.total_hours, a.status AS attendance_status,
             ws.shift_name, ws.start_time AS shift_start, ws.end_time AS shift_end, ws.color AS shift_color
      FROM employees e
      LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
      LEFT JOIN employee_schedules es ON es.employee_id = e.id AND es.work_date = ?
      LEFT JOIN work_shifts ws ON ws.id = es.shift_id
      WHERE e.status = 'active'
    `;
    const params = [today, today];

    if (searchTerm) {
      sql += ` AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR e.department LIKE ? OR e.position LIKE ?)`;
      const p = `%${searchTerm}%`;
      params.push(p, p, p, p);
    }

    sql += ` ORDER BY e.department, e.full_name`;

    if (limit && Number(limit) > 0) {
      sql += ` LIMIT ?`;
      params.push(Number(limit));
    }

    const [employees] = await db.query(sql, params);
    res.json({ employees, today, timezone });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/kiosk/verify-pin — verify employee by PIN
kioskRouter.post('/verify-pin', async (req, res) => {
  try {
    const { pin_code } = req.body;
    if (!pin_code) return res.status(400).json({ error: 'PIN wajib diisi' });
    const [[emp]] = await db.query(
      `SELECT e.id, e.full_name, e.department, e.position, e.photo, e.face_photo, e.employee_code,
              b.name AS branch_name
       FROM employees e LEFT JOIN branches b ON b.id=e.branch_id
       WHERE e.pin_code=? AND e.status='active'`, [pin_code]
    );
    if (!emp) return res.status(404).json({ error: 'PIN tidak ditemukan atau karyawan tidak aktif' });
    
    // Get today's attendance status & scheduled shift (using timezone)
    const timezone = await getKioskTimezone();
    const { today } = getZonedTime(timezone);
    const [[att]] = await db.query('SELECT id, clock_in, clock_out, total_hours FROM attendance WHERE employee_id=? AND work_date=?', [emp.id, today]);
    const [[sched]] = await db.query(`
      SELECT ws.shift_name, ws.start_time, ws.end_time, ws.color 
      FROM employee_schedules es JOIN work_shifts ws ON ws.id=es.shift_id 
      WHERE es.employee_id=? AND es.work_date=?`, [emp.id, today]);
    
    res.json({ employee: emp, today_attendance: att || null, shift_today: sched || null });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/kiosk/register-face — register face photo & descriptor for employee
kioskRouter.post('/register-face', async (req, res) => {
  try {
    const { employee_id, face_photo, face_descriptor, pin_code } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id wajib' });
    const updates = []; const params = [];
    if (face_photo) { updates.push('face_photo=?'); params.push(face_photo); }
    if (face_descriptor) {
      updates.push('face_descriptor=?');
      params.push(typeof face_descriptor === 'string' ? face_descriptor : JSON.stringify(face_descriptor));
    }
    if (pin_code !== undefined) { updates.push('pin_code=?'); params.push(pin_code || null); }
    if (!updates.length) return res.status(400).json({ error: 'Tidak ada data untuk disimpan' });
    params.push(employee_id);
    await db.query(`UPDATE employees SET ${updates.join(', ')} WHERE id=?`, params);
    res.json({ message: 'Data wajah/PIN berhasil disimpan' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/kiosk/clock — clock in or out via kiosk
kioskRouter.post('/clock', async (req, res) => {
  try {
    const { employee_id, action, method = 'pin', selfie_photo, latitude, longitude } = req.body;
    if (!employee_id || !action) return res.status(400).json({ error: 'employee_id dan action wajib' });
    
    const timezone = await getKioskTimezone();
    const { today, now } = getZonedTime(timezone);

    if (action === 'clock_in') {
      const [[existing]] = await db.query('SELECT id FROM attendance WHERE employee_id=? AND work_date=?', [employee_id, today]);
      if (existing) return res.status(409).json({ error: 'Sudah clock-in hari ini' });

      // GPS radius check
      let distanceMeters = null, isVerified = 1;
      const [[reqRadS]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='kiosk_require_radius'");
      const requireRadius = reqRadS?.setting_value === 'true';
      const [[radS]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='attendance_radius_meters'");
      const maxR = parseInt(radS?.setting_value || 0);

      if (requireRadius && maxR > 0) {
        if (!latitude || !longitude) {
          return res.status(400).json({ error: 'Lokasi GPS diperlukan untuk validasi radius absensi kantor.' });
        }
        const [[latS]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='attendance_office_lat'");
        const [[lngS]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='attendance_office_lng'");
        const oLat = parseFloat(latS?.setting_value || 0), oLng = parseFloat(lngS?.setting_value || 0);
        if (oLat && oLng) {
          const R = 6371000;
          const dLat = (latitude-oLat)*Math.PI/180, dLng = (longitude-oLng)*Math.PI/180;
          const a = Math.sin(dLat/2)**2 + Math.cos(oLat*Math.PI/180)*Math.cos(latitude*Math.PI/180)*Math.sin(dLng/2)**2;
          distanceMeters = Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
          isVerified = distanceMeters <= maxR ? 1 : 0;
          if (!isVerified) return res.status(400).json({ error: `Di luar radius kantor. Jarak: ${distanceMeters}m, batas maksimal: ${maxR}m` });
        }
      } else if (latitude && longitude) {
        const [[latS]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='attendance_office_lat'");
        const [[lngS]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key='attendance_office_lng'");
        const oLat = parseFloat(latS?.setting_value || 0), oLng = parseFloat(lngS?.setting_value || 0);
        if (oLat && oLng) {
          const R = 6371000;
          const dLat = (latitude-oLat)*Math.PI/180, dLng = (longitude-oLng)*Math.PI/180;
          const a = Math.sin(dLat/2)**2 + Math.cos(oLat*Math.PI/180)*Math.cos(latitude*Math.PI/180)*Math.sin(dLng/2)**2;
          distanceMeters = Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
        }
      }

      // Get scheduled shift & linked user
      const [[sched]] = await db.query('SELECT shift_id FROM employee_schedules WHERE employee_id=? AND work_date=?', [employee_id, today]);
      const [[empRow]] = await db.query('SELECT user_id FROM employees WHERE id=?', [employee_id]);
      const recordedBy = empRow?.user_id || null;
      
      const [result] = await db.query(
        `INSERT INTO attendance (employee_id, shift_id, work_date, clock_in, status, recorded_by, method, latitude, longitude, distance_meters, selfie_photo, is_verified)
         VALUES (?,?,?,?,'present',?,?,?,?,?,?,?)`,
        [employee_id, sched?.shift_id || null, today, now, recordedBy, method, latitude||null, longitude||null, distanceMeters, selfie_photo||null, isVerified]
      );
      const [[att]] = await db.query('SELECT a.*,e.full_name FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.id=?', [result.insertId]);
      res.status(201).json({ attendance: att, message: 'Clock-in berhasil' });
    } 
    else if (action === 'clock_out') {
      const [[att]] = await db.query('SELECT * FROM attendance WHERE employee_id=? AND work_date=? AND clock_out IS NULL', [employee_id, today]);
      if (!att) return res.status(404).json({ error: 'Belum clock-in atau sudah clock-out' });
      
      const clockIn = new Date(`${today}T${att.clock_in}`);
      const clockOut = new Date(`${today}T${now}`);
      const totalHours = ((clockOut - clockIn) / 3600000).toFixed(2);
      
      await db.query('UPDATE attendance SET clock_out=?, total_hours=? WHERE id=?', [now, totalHours, att.id]);
      const [[updated]] = await db.query('SELECT a.*,e.full_name FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.id=?', [att.id]);
      res.json({ attendance: updated, message: 'Clock-out berhasil' });
    } 
    else {
      res.status(400).json({ error: 'action harus clock_in atau clock_out' });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/kiosk/settings — get attendance settings for kiosk display
kioskRouter.get('/settings', async (req, res) => {
  try {
    const keys = [
      'attendance_office_lat','attendance_office_lng','attendance_radius_meters',
      'kiosk_require_radius','kiosk_mode','attendance_allowed_methods','attendance_require_selfie',
      'attendance_timezone','kiosk_bg_type','kiosk_bg_preset','kiosk_bg_image','kiosk_bg_overlay',
      'kiosk_bg_blur','kiosk_theme_color'
    ];
    const [rows] = await db.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${keys.map(()=>'?').join(',')})`, keys);
    const s = {}; keys.forEach(k=>{s[k]=null}); rows.forEach(r=>{s[r.setting_key]=r.setting_value});
    if (!s.attendance_timezone) {
      s.attendance_timezone = await getKioskTimezone();
    }
    s.kiosk_bg_type = s.kiosk_bg_type || 'preset';
    s.kiosk_bg_preset = s.kiosk_bg_preset || 'default_slate';
    s.kiosk_bg_overlay = s.kiosk_bg_overlay || '0.75';
    s.kiosk_bg_blur = s.kiosk_bg_blur || 'sm';
    s.kiosk_theme_color = s.kiosk_theme_color || 'violet';
    res.json({ settings: s });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/kiosk/settings — save attendance & kiosk settings
kioskRouter.put('/settings', async (req, res) => {
  try {
    const {
      attendance_office_lat, attendance_office_lng, attendance_radius_meters,
      kiosk_require_radius, kiosk_mode, attendance_require_selfie, attendance_timezone,
      kiosk_bg_type, kiosk_bg_preset, kiosk_bg_image, kiosk_bg_overlay, kiosk_bg_blur, kiosk_theme_color
    } = req.body;

    const toSave = {
      attendance_office_lat, attendance_office_lng, attendance_radius_meters,
      kiosk_require_radius, kiosk_mode, attendance_require_selfie, attendance_timezone,
      kiosk_bg_type, kiosk_bg_preset, kiosk_bg_image, kiosk_bg_overlay, kiosk_bg_blur, kiosk_theme_color
    };

    for (const [k, v] of Object.entries(toSave)) {
      if (v !== undefined) {
        await db.query(
          'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
          [k, String(v), String(v)]
        );
      }
    }
    res.json({ message: 'Pengaturan kiosk berhasil disimpan' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/kiosk/upload-bg — upload custom background image for kiosk
kioskRouter.post('/upload-bg', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Data gambar wajib diisi' });

    const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: 'Format base64 tidak valid' });
    }

    const fs = require('fs');
    const path = require('path');
    const ext = matches[1].includes('png') ? '.png' : (matches[1].includes('webp') ? '.webp' : '.jpg');
    const filename = `kiosk-bg-${Date.now()}${ext}`;
    const uploadDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const filePath = path.join(uploadDir, filename);
    const buffer = Buffer.from(matches[2], 'base64');
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${filename}`;
    res.json({ url: publicUrl, message: 'Background berhasil diunggah' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OVERTIME ────────────────────────────────────────────────

router.get('/overtime', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { month, employee_id, status, search, q } = req.query;
    const searchTerm = (search || q || '').trim();
    let sql = `
      SELECT o.*, e.full_name, e.department, e.employee_code, e.hourly_rate
      FROM overtime o
      JOIN employees e ON e.id = o.employee_id
      WHERE 1=1
    `;
    const params = [];
    if (month) { sql += ' AND DATE_FORMAT(o.overtime_date, "%Y-%m") = ?'; params.push(month); }
    if (employee_id) { sql += ' AND o.employee_id = ?'; params.push(employee_id); }
    if (status && status !== 'all') { sql += ' AND o.status = ?'; params.push(status); }
    if (searchTerm) {
      sql += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR o.reason LIKE ?)';
      const s = `%${searchTerm}%`;
      params.push(s, s, s);
    }
    sql += ' ORDER BY o.overtime_date DESC, o.created_at DESC';
    const [rows] = await db.query(sql, params);
    res.json({ overtime: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/overtime', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { employee_id, overtime_date, start_time, end_time, reason, rate_per_hour } = req.body;
    if (!employee_id || !overtime_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'employee_id, overtime_date, start_time, end_time wajib' });
    }
    const s = new Date(`2000-01-01T${start_time}`);
    const e = new Date(`2000-01-01T${end_time}`);
    const totalHours = ((e - s) / 3600000).toFixed(2);
    const rate = rate_per_hour || 0;
    const totalPay = (totalHours * rate).toFixed(0);

    const [result] = await db.query(
      `INSERT INTO overtime (employee_id, overtime_date, start_time, end_time, total_hours, reason, rate_per_hour, total_pay, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,'pending',?)`,
      [employee_id, overtime_date, start_time, end_time, totalHours, reason||null, rate, totalPay, req.user.id]
    );
    const [[row]] = await db.query('SELECT o.*, e.full_name FROM overtime o JOIN employees e ON e.id=o.employee_id WHERE o.id=?', [result.insertId]);
    res.status(201).json({ overtime: row });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/overtime/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { status, start_time, end_time, reason, rate_per_hour } = req.body;
    const updates = []; const params = [];
    if (status) { updates.push('status=?'); params.push(status); }
    if (reason !== undefined) { updates.push('reason=?'); params.push(reason); }
    if (rate_per_hour !== undefined) { updates.push('rate_per_hour=?'); params.push(rate_per_hour); }
    if (start_time && end_time) {
      const s = new Date(`2000-01-01T${start_time}`);
      const e = new Date(`2000-01-01T${end_time}`);
      const totalHours = ((e - s) / 3600000).toFixed(2);
      updates.push('start_time=?', 'end_time=?', 'total_hours=?', 'total_pay=?');
      params.push(start_time, end_time, totalHours, (totalHours * (rate_per_hour || 0)).toFixed(0));
    }
    if (!updates.length) return res.status(400).json({ error: 'Tidak ada data untuk diupdate' });
    params.push(req.params.id);
    await db.query(`UPDATE overtime SET ${updates.join(', ')} WHERE id=?`, params);
    const [[row]] = await db.query('SELECT o.*, e.full_name FROM overtime o JOIN employees e ON e.id=o.employee_id WHERE o.id=?', [req.params.id]);
    res.json({ overtime: row });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/overtime/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    await db.query('DELETE FROM overtime WHERE id=?', [req.params.id]);
    res.json({ message: 'Data lembur dihapus' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.kioskRouter = kioskRouter;
