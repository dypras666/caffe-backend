const db = require('../../config/database');

/**
 * HR Module Seeder
 * Seeds: Employees, Work Shifts, Attendance, and Payroll
 */

async function seedHR() {
  console.log('🌱 Starting HR Module Seeding...\n');

  try {
    // Enable HR Module
    await db.query(
      "INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label) VALUES ('hr_enabled', 'true', 'boolean', 'hr', 'HR Module Enabled') ON DUPLICATE KEY UPDATE setting_value='true'"
    );
    console.log('✅ HR Module enabled\n');

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 1. SEED WORK SHIFTS
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('📋 Seeding Work Shifts...');

    await db.query('DELETE FROM work_shifts WHERE shift_name LIKE "Shift %"');

    const shifts = [
      { name: 'Shift Pagi', start: '07:00:00', end: '15:00:00', break: 60 },
      { name: 'Shift Siang', start: '11:00:00', end: '19:00:00', break: 60 },
      { name: 'Shift Malam', start: '15:00:00', end: '23:00:00', break: 60 },
      { name: 'Shift Full', start: '09:00:00', end: '18:00:00', break: 60 },
    ];

    const shiftIds = [];
    for (const shift of shifts) {
      const [result] = await db.query(
        'INSERT INTO work_shifts (shift_name, start_time, end_time, break_minutes, is_active) VALUES (?, ?, ?, ?, 1)',
        [shift.name, shift.start, shift.end, shift.break]
      );
      shiftIds.push(result.insertId);
      console.log(`   ✓ ${shift.name} (${shift.start} - ${shift.end})`);
    }
    console.log(`✅ Created ${shifts.length} work shifts\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 2. SEED EMPLOYEES
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('👥 Seeding Employees...');

    // Delete in correct order (FK constraints)
    const [existingEmps] = await db.query('SELECT id FROM employees WHERE employee_code LIKE "EMP-%"');
    if (existingEmps.length > 0) {
      const empIds = existingEmps.map(e => e.id);
      await db.query('DELETE FROM payroll WHERE employee_id IN (?)', [empIds]);
      await db.query('DELETE FROM shift_swaps WHERE requester_employee_id IN (?) OR target_employee_id IN (?)', [empIds, empIds]);
      await db.query('DELETE FROM attendance WHERE employee_id IN (?)', [empIds]);
      await db.query('DELETE FROM employees WHERE id IN (?)', [empIds]);
    }

    const employees = [
      {
        code: 'EMP-001',
        name: 'Budi Santoso',
        email: 'budi@cafeazzura.com',
        phone: '081234567801',
        department: 'Dapur',
        position: 'Head Chef',
        type: 'full-time',
        salary: 6000000,
        join_date: '2023-01-15',
      },
      {
        code: 'EMP-002',
        name: 'Siti Nurhaliza',
        email: 'siti@cafeazzura.com',
        phone: '081234567802',
        department: 'Dapur',
        position: 'Sous Chef',
        type: 'full-time',
        salary: 4500000,
        join_date: '2023-03-01',
      },
      {
        code: 'EMP-003',
        name: 'Ahmad Hidayat',
        email: 'ahmad@cafeazzura.com',
        phone: '081234567803',
        department: 'Dapur',
        position: 'Cook',
        type: 'full-time',
        salary: 3500000,
        join_date: '2023-06-10',
      },
      {
        code: 'EMP-004',
        name: 'Dewi Kartika',
        email: 'dewi@cafeazzura.com',
        phone: '081234567804',
        department: 'Service',
        position: 'Head Waiter',
        type: 'full-time',
        salary: 4000000,
        join_date: '2023-02-20',
      },
      {
        code: 'EMP-005',
        name: 'Rina Marlina',
        email: 'rina@cafeazzura.com',
        phone: '081234567805',
        department: 'Service',
        position: 'Waiter',
        type: 'full-time',
        salary: 3200000,
        join_date: '2023-05-15',
      },
      {
        code: 'EMP-006',
        name: 'Joko Widodo',
        email: 'joko@cafeazzura.com',
        phone: '081234567806',
        department: 'Service',
        position: 'Waiter',
        type: 'part-time',
        salary: 2000000,
        join_date: '2023-08-01',
      },
      {
        code: 'EMP-007',
        name: 'Maya Puspita',
        email: 'maya@cafeazzura.com',
        phone: '081234567807',
        department: 'Bar',
        position: 'Head Barista',
        type: 'full-time',
        salary: 4500000,
        join_date: '2023-01-20',
      },
      {
        code: 'EMP-008',
        name: 'Andi Pratama',
        email: 'andi@cafeazzura.com',
        phone: '081234567808',
        department: 'Bar',
        position: 'Barista',
        type: 'full-time',
        salary: 3500000,
        join_date: '2023-04-10',
      },
      {
        code: 'EMP-009',
        name: 'Linda Wijaya',
        email: 'linda@cafeazzura.com',
        phone: '081234567809',
        department: 'Bar',
        position: 'Barista',
        type: 'part-time',
        salary: 2200000,
        join_date: '2023-09-01',
      },
      {
        code: 'EMP-010',
        name: 'Rudi Hartono',
        email: 'rudi@cafeazzura.com',
        phone: '081234567810',
        department: 'Kasir',
        position: 'Cashier',
        type: 'full-time',
        salary: 3000000,
        join_date: '2023-03-15',
      },
    ];

    const employeeIds = [];
    for (const emp of employees) {
      const [result] = await db.query(
        `INSERT INTO employees (
          employee_code, full_name, phone,
          department, position, employment_type,
          base_salary, join_date, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [emp.code, emp.name, emp.phone, emp.department, emp.position, emp.type, emp.salary, emp.join_date]
      );
      employeeIds.push(result.insertId);
      console.log(`   ✓ ${emp.code} - ${emp.name} (${emp.position})`);
    }
    console.log(`✅ Created ${employees.length} employees\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 3. SEED ATTENDANCE
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('📅 Seeding Attendance Records...');

    // Generate attendance for last 30 days
    const today = new Date();
    let attendanceCount = 0;

    for (let i = 30; i >= 1; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      // Skip Sundays (day 0)
      if (date.getDay() === 0) continue;

      for (const employeeId of employeeIds) {
        // Random 80% attendance rate
        if (Math.random() < 0.8) {
          const shiftId = shiftIds[Math.floor(Math.random() * shiftIds.length)];

          // Get shift times
          const [[shift]] = await db.query('SELECT start_time, end_time, break_minutes FROM work_shifts WHERE id = ?', [shiftId]);

          // Clock in time (with some randomness)
          const clockInMinutes = Math.floor(Math.random() * 15) - 5; // -5 to +10 minutes
          const clockIn = new Date(date);
          const [startHour, startMin] = shift.start_time.split(':');
          clockIn.setHours(parseInt(startHour), parseInt(startMin) + clockInMinutes, 0);

          // Clock out time
          const clockOutMinutes = Math.floor(Math.random() * 20) - 10; // -10 to +10 minutes
          const clockOut = new Date(date);
          const [endHour, endMin] = shift.end_time.split(':');
          clockOut.setHours(parseInt(endHour), parseInt(endMin) + clockOutMinutes, 0);

          // Calculate total hours
          const totalMs = clockOut - clockIn;
          const totalHours = ((totalMs / 1000 / 60) - (shift.break_minutes || 0)) / 60;

          // Determine status
          const isLate = clockInMinutes > 10;
          const isEarly = clockOutMinutes < -10;
          let status = 'present';
          if (isLate && isEarly) status = 'late-early-leave';
          else if (isLate) status = 'late';
          else if (isEarly) status = 'early-leave';

          await db.query(
            `INSERT INTO attendance (
              employee_id, shift_id, work_date, clock_in, clock_out,
              total_hours, status, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              employeeId, shiftId, dateStr,
              clockIn.toISOString().slice(0, 19).replace('T', ' '),
              clockOut.toISOString().slice(0, 19).replace('T', ' '),
              totalHours.toFixed(2),
              status,
              status === 'present' ? null : `Auto-generated: ${status}`
            ]
          );
          attendanceCount++;
        }
      }
    }
    console.log(`✅ Created ${attendanceCount} attendance records (last 30 days)\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 4. SEED PAYROLL
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('💰 Seeding Payroll Records...');

    // Generate payroll for last 3 months
    const months = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      months.push(d.toISOString().slice(0, 7)); // YYYY-MM
    }

    let payrollCount = 0;
    for (const month of months) {
      const [year, monthNum] = month.split('-');
      const daysInMonth = new Date(year, monthNum, 0).getDate();

      for (let i = 0; i < employeeIds.length; i++) {
        const employeeId = employeeIds[i];
        const employee = employees[i];

        // Get attendance for this month
        const [[attendanceStats]] = await db.query(
          `SELECT
            COUNT(*) as days_worked,
            SUM(total_hours) as total_hours
           FROM attendance
           WHERE employee_id = ?
           AND DATE_FORMAT(work_date, '%Y-%m') = ?`,
          [employeeId, month]
        );

        const daysWorked = attendanceStats.days_worked || 0;
        const totalHours = parseFloat(attendanceStats.total_hours || 0);

        // Calculate salary components
        const baseSalary = employee.salary;
        const workDaysPerMonth = 26; // Standard work days
        const dailySalary = baseSalary / workDaysPerMonth;
        const calculatedSalary = Math.round(dailySalary * daysWorked);

        // Random allowances and deductions
        const transportAllowance = employee.type === 'full-time' ? 500000 : 0;
        const mealAllowance = employee.type === 'full-time' ? 300000 : 0;
        const bonus = daysWorked >= 25 ? Math.floor(Math.random() * 500000) : 0;
        const deductions = Math.floor(Math.random() * 100000);

        const totalAllowance = transportAllowance + mealAllowance;
        const netSalary = calculatedSalary + totalAllowance + bonus - deductions;

        // Payment status (80% paid, 20% pending)
        const paymentStatus = Math.random() < 0.8 ? 'paid' : 'pending';
        const paidAt = paymentStatus === 'paid' ? new Date(`${year}-${monthNum}-28 10:00:00`) : null;

        await db.query(
          `INSERT INTO payroll (
            employee_id, period_month, work_days, total_hours,
            base_salary, gross_salary, deductions, net_salary,
            overtime_pay, status, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            employeeId, month, daysWorked, totalHours.toFixed(2),
            calculatedSalary, calculatedSalary + totalAllowance + bonus, deductions, netSalary,
            bonus, paymentStatus === 'paid' ? 'paid' : 'draft',
            `Transport: Rp ${transportAllowance.toLocaleString('id')}, Meal: Rp ${mealAllowance.toLocaleString('id')}`
          ]
        );
        payrollCount++;
      }
      console.log(`   ✓ Payroll for ${month}`);
    }
    console.log(`✅ Created ${payrollCount} payroll records (last 3 months)\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 5. SUMMARY
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ HR Module Seeding Complete!\n');
    console.log('📊 Summary:');
    console.log(`   • Work Shifts:     ${shifts.length}`);
    console.log(`   • Employees:       ${employees.length}`);
    console.log(`   • Attendance:      ${attendanceCount} records`);
    console.log(`   • Payroll:         ${payrollCount} records`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Print sample data
    console.log('📋 Sample Employees:');
    const [[sample1]] = await db.query(
      'SELECT employee_code, full_name, position, department FROM employees WHERE employee_code LIKE "EMP-%" LIMIT 3'
    );
    console.table([sample1]);

    console.log('\n📅 Recent Attendance (Today):');
    const today_str = new Date().toISOString().split('T')[0];
    const [recentAtt] = await db.query(
      `SELECT
        e.employee_code, e.full_name,
        DATE_FORMAT(a.clock_in, '%H:%i') as clock_in,
        DATE_FORMAT(a.clock_out, '%H:%i') as clock_out,
        a.total_hours, a.status
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.work_date = ?
       LIMIT 5`,
      [today_str]
    );
    if (recentAtt.length > 0) {
      console.table(recentAtt);
    } else {
      console.log('   (No attendance today - checking yesterday)');
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const [yesterdayAtt] = await db.query(
        `SELECT
          e.employee_code, e.full_name,
          DATE_FORMAT(a.clock_in, '%H:%i') as clock_in,
          DATE_FORMAT(a.clock_out, '%H:%i') as clock_out,
          a.total_hours, a.status
         FROM attendance a
         JOIN employees e ON e.id = a.employee_id
         WHERE a.work_date = ?
         LIMIT 5`,
        [yesterday.toISOString().split('T')[0]]
      );
      console.table(yesterdayAtt);
    }

    console.log('\n💰 Current Month Payroll:');
    const currentMonth = new Date().toISOString().slice(0, 7);
    const [payrollSample] = await db.query(
      `SELECT
        e.employee_code, e.full_name,
        p.work_days, p.net_salary, p.status
       FROM payroll p
       JOIN employees e ON e.id = p.employee_id
       WHERE p.period_month = ?
       LIMIT 5`,
      [currentMonth]
    );
    console.table(payrollSample);

  } catch (error) {
    console.error('❌ Error seeding HR module:', error);
    throw error;
  }
}

// Run seeder if called directly
if (require.main === module) {
  seedHR()
    .then(() => {
      console.log('\n✅ Seeding completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Seeding failed:', error);
      process.exit(1);
    });
}

module.exports = { seedHR };
