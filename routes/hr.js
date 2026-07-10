/**
 * HR Module — Karyawan, Absensi, Penggajian, Tukar Shift
 * Opsional: hanya aktif jika system_settings hr_enabled = 'true'
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

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
    const { status, department, branch_id } = req.query;
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
    sql += ' ORDER BY e.full_name';
    const [rows] = await db.query(sql, params);
    res.json({ employees: rows });
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
      create_user_account, email, password, user_role,
    } = req.body;
    if (!full_name) return res.status(400).json({ error: 'Nama lengkap wajib diisi' });

    let linkedUserId = user_id || null;

    // Optionally create a linked user account in the same request
    if (create_user_account && email && password) {
      const bcrypt = require('bcryptjs');
      const [[existing]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing) return res.status(409).json({ error: 'Email sudah terdaftar' });
      const hashed = await bcrypt.hash(password, 10);
      const [ur] = await db.query(
        'INSERT INTO users (name, email, password, role, phone, branch_id) VALUES (?, ?, ?, ?, ?, ?)',
        [full_name, email, hashed, user_role || 'kasir', phone || null, branch_id || req.user.branch_id || null]
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
      'bank_account_name','branch_id','status'];
    const updates = [];
    const params = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
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

// POST /api/hr/payroll/generate — generate payroll dari attendance bulan tsb
router.post('/payroll/generate', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { month } = req.body; // YYYY-MM
    if (!month) return res.status(400).json({ error: 'month wajib' });
    const dateFrom = `${month}-01`;
    const dateTo = new Date(month + '-01');
    dateTo.setMonth(dateTo.getMonth() + 1);
    dateTo.setDate(0);
    const dateToStr = dateTo.toISOString().slice(0, 10);

    // Get all active employees
    const [employees] = await db.query("SELECT * FROM employees WHERE status = 'active'");

    const generated = [];
    for (const emp of employees) {
      // Check existing payroll
      const [[existing]] = await db.query(
        'SELECT id FROM payroll WHERE employee_id = ? AND period_month = ?',
        [emp.id, month]
      );
      if (existing) { generated.push({ ...existing, skipped: true, employee_name: emp.full_name }); continue; }

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

      const baseSalary = parseFloat(emp.base_salary || 0);
      const hourlyRate = parseFloat(emp.hourly_rate || 0);
      const workDays = parseInt(attStats.work_days || 0);
      const totalHours = parseFloat(attStats.total_hours || 0);
      const overtimeHours = parseFloat(attStats.overtime_hours || 0);

      // Calculation
      let grossSalary = baseSalary;
      if (emp.employment_type === 'hourly' && hourlyRate > 0) {
        grossSalary = totalHours * hourlyRate;
      }
      const overtimePay = overtimeHours * (hourlyRate || baseSalary / 173) * 1.5;
      const totalGross = parseFloat((grossSalary + overtimePay).toFixed(2));

      const [result] = await db.query(
        `INSERT INTO payroll
          (employee_id, period_month, base_salary, total_hours, overtime_hours, overtime_pay,
           gross_salary, deductions, net_salary, work_days, absent_days, sick_days, leave_days, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'draft')`,
        [emp.id, month, baseSalary, totalHours, overtimeHours, overtimePay, totalGross, totalGross,
         workDays, attStats.absent_days || 0, attStats.sick_days || 0, attStats.leave_days || 0]
      );
      generated.push({ id: result.insertId, employee_name: emp.full_name, net_salary: totalGross });
    }

    res.json({ message: `${generated.length} slip gaji di-generate`, payroll: generated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/hr/payroll/:id — edit/adjust payroll
router.put('/payroll/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    const { deductions, allowances, notes, status, bonus } = req.body;
    const [[p]] = await db.query('SELECT * FROM payroll WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Payroll tidak ditemukan' });
    const newDeductions = deductions !== undefined ? parseFloat(deductions) : parseFloat(p.deductions);
    const newBonus = bonus !== undefined ? parseFloat(bonus) : parseFloat(p.bonus || 0);
    const net = parseFloat((parseFloat(p.gross_salary) + newBonus - newDeductions).toFixed(2));
    await db.query(
      'UPDATE payroll SET deductions=?, bonus=?, net_salary=?, notes=COALESCE(?,notes), status=COALESCE(?,status), updated_at=NOW() WHERE id=?',
      [newDeductions, newBonus, net, notes || null, status || null, req.params.id]
    );
    const [[updated]] = await db.query('SELECT * FROM payroll WHERE id = ?', [req.params.id]);
    res.json({ payroll: updated });
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

router.delete('/schedules/:id', authenticate, authorize('admin'), hrEnabled, async (req, res) => {
  try {
    await db.query('DELETE FROM employee_schedules WHERE id=?', [req.params.id]);
    res.json({ message: 'Jadwal dihapus' });
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
      'emergency_contact_phone','emergency_contact_relation','photo'];
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

module.exports = router;
