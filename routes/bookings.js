const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize, optionalAuth } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');
const { triggerBookingEvent } = require('../services/integrations');

// Helper: sequential booking number
const generateBookingNumber = async () => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE order_sequences SET last_number = last_number + 1 WHERE seq_key = "booking"');
    const [[row]] = await conn.query('SELECT last_number FROM order_sequences WHERE seq_key = "booking"');
    await conn.commit();
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `BKG-${datePart}-${String(row.last_number).padStart(5, '0')}`;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
};

// Helper: get booking setting
const getBookingSetting = async (key) => {
  const [[row]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
  return row ? row.setting_value : null;
};

// Helper: log activity
const logActivity = async (userId, action, recordId, oldValues, newValues) => {
  await db.query(
    'INSERT INTO activity_logs (user_id, action, table_name, record_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)',
    [
      userId,
      action,
      'bookings',
      recordId || null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ]
  );
};

// GET / — admin/kasir get all; public (no auth) gets own via email query param
router.get('/',
  optionalAuth,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['pending', 'confirmed', 'cancelled', 'completed']),
    query('date').optional().isISO8601(),
    query('email').optional().isEmail(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const offset = (page - 1) * limit;
      const { status, date, email } = req.query;

      const isStaff = req.user && (req.user.role === 'admin' || req.user.role === 'kasir');

      const baseFrom = 'FROM bookings b';
      const baseJoins = 'LEFT JOIN branches br ON br.id = b.branch_id';
      let baseWhere = 'WHERE 1=1';
      const params = [];

      if (!isStaff) {
        // Public access: require email filter to look up own bookings
        if (!email) {
          return res.status(400).json({ error: 'Email is required for public booking lookup' });
        }
        baseWhere += ' AND email = ?';
        params.push(email);
      } else {
        // Staff: optional email filter
        if (email) {
          baseWhere += ' AND email = ?';
          params.push(email);
        }
      }

      if (status) {
        baseWhere += ' AND status = ?';
        params.push(status);
      }

      if (date) {
        baseWhere += ' AND booking_date = ?';
        params.push(date);
      }

      const [[{ total }]] = await db.query(
        `SELECT COUNT(*) AS total ${baseFrom} ${baseJoins} ${baseWhere}`, params
      );

      const [bookings] = await db.query(
        `SELECT b.id, b.name, b.email, b.phone, b.booking_date, b.booking_time, b.guests,
                b.table_number, b.special_request, b.status, b.branch_id, b.created_at, b.updated_at,
                br.name AS branch_name
         ${baseFrom} ${baseJoins}
         ${baseWhere} ORDER BY b.booking_date DESC, b.booking_time DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      res.json({
        bookings,
        pagination: {
          total,
          page,
          limit,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('Get bookings error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /:id
router.get('/:id',
  optionalAuth,
  param('id').isInt({ min: 1 }).withMessage('Invalid booking ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const [bookings] = await db.query(
        `SELECT b.id, b.name, b.email, b.phone, b.booking_date, b.booking_time, b.guests,
                b.table_number, b.special_request, b.status, b.branch_id, b.created_at, b.updated_at,
                br.name AS branch_name
         FROM bookings b
         LEFT JOIN branches br ON br.id = b.branch_id
         WHERE b.id = ?`,
        [req.params.id]
      );

      if (bookings.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const booking = bookings[0];
      const isStaff = req.user && (req.user.role === 'admin' || req.user.role === 'kasir');


      // Public users can only view if they provide matching email via query
      if (!isStaff) {
        const email = req.query.email;
        if (!email || email !== booking.email) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      res.json({ booking });
    } catch (error) {
      console.error('Get booking error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST / — public, create booking
router.post('/',
  optionalAuth,
  sanitizeInput,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('booking_date').isISO8601().withMessage('Valid booking_date is required (YYYY-MM-DD)'),
    body('booking_time').matches(/^\d{2}:\d{2}(:\d{2})?$/).withMessage('Valid booking_time is required (HH:MM)'),
    body('guests').isInt({ min: 1 }).withMessage('guests must be at least 1'),
    body('special_request').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, phone, booking_date, booking_time, guests, branch_id, special_request } = req.body;

      // Prevent duplicate booking for same email/date/time
      const [existing] = await db.query(
        'SELECT id FROM bookings WHERE email = ? AND booking_date = ? AND booking_time = ? AND status NOT IN ("cancelled")',
        [email, booking_date, booking_time]
      );

      if (existing.length > 0) {
        return res.status(409).json({
          error: 'A booking for this email at the same date and time already exists',
        });
      }

      // Fetch DP settings
      const requireDp = await getBookingSetting('booking_require_dp');
      const dpType = await getBookingSetting('booking_dp_type') || 'percent';
      const dpAmount = parseFloat(await getBookingSetting('booking_dp_amount') || '0');
      const prioritySkipDp = await getBookingSetting('booking_priority_skip_dp');

      // Check if logged-in user is priority → skip DP
      const isPriority = req.user && req.user.is_priority;
      const needDp = requireDp === 'true' && !isPriority;

      // Calculate DP amount if needed (based on guests × avg price or flat amount)
      let dpRequired = 0;
      if (needDp) {
        if (dpType === 'fixed') dpRequired = dpAmount;
        else dpRequired = dpAmount; // Percent mode: amount is the flat DP Rp for now (can be extended)
      }

      const bookingNumber = await generateBookingNumber();
      const userId = req.user ? req.user.id : null;

      const [result] = await db.query(
        `INSERT INTO bookings (booking_number, name, email, phone, booking_date, booking_time, guests,
           branch_id, special_request, status, user_id, dp_amount, payment_status, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0)`,
        [bookingNumber, name, email, phone, booking_date, booking_time, guests,
         branch_id || null, special_request || null, userId, dpRequired, dpRequired > 0 ? 'unpaid' : 'unpaid']
      );

      const actorId = req.user ? req.user.id : null;
      await logActivity(actorId, 'create_booking', result.insertId, null, { name, email, booking_date, booking_time });

      res.status(201).json({
        message: 'Booking berhasil dibuat',
        booking: {
          id: result.insertId,
          booking_number: bookingNumber,
          name,
          email,
          booking_date,
          booking_time,
          guests,
          branch_id: branch_id || null,
          status: 'pending',
          dp_required: dpRequired,
          dp_amount: dpRequired,
          payment_status: 'unpaid',
          require_dp: needDp,
        },
      });
    } catch (error) {
      console.error('Create booking error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id/status — admin/kasir: confirmed/cancelled/completed
router.put('/:id/status',
  authenticate,
  authorize('admin', 'kasir'),
  sanitizeInput,
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid booking ID'),
    body('status')
      .isIn(['confirmed', 'cancelled', 'completed'])
      .withMessage('status must be confirmed, cancelled, or completed'),
    body('table_number').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const bookingId = req.params.id;
      const { status, table_number } = req.body;

      const [bookings] = await db.query(
        'SELECT id, status FROM bookings WHERE id = ?',
        [bookingId]
      );

      if (bookings.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const oldStatus = bookings[0].status;

      const updates = ['status = ?'];
      const values = [status];

      if (table_number !== undefined) {
        updates.push('table_number = ?');
        values.push(table_number);
      }

      values.push(bookingId);
      await db.query(`UPDATE bookings SET ${updates.join(', ')} WHERE id = ?`, values);

      await logActivity(
        req.user.id,
        'update_booking_status',
        bookingId,
        { status: oldStatus },
        { status, table_number }
      );

      if (status === 'confirmed' && oldStatus !== 'confirmed') {
        const [[booking]] = await db.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
        triggerBookingEvent('booking.confirmed', booking).catch((err) =>
          console.error('[Integration] booking.confirmed failed:', err.message)
        );
      }

      res.json({ message: 'Booking status updated', status });
    } catch (error) {
      console.error('Update booking status error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /:id — admin
router.delete('/:id',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }).withMessage('Invalid booking ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const bookingId = req.params.id;

      const [bookings] = await db.query(
        'SELECT id, name, email, booking_date FROM bookings WHERE id = ?',
        [bookingId]
      );

      if (bookings.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      await db.query('DELETE FROM bookings WHERE id = ?', [bookingId]);

      await logActivity(req.user.id, 'delete_booking', bookingId, bookings[0], null);

      res.json({ message: 'Booking deleted successfully' });
    } catch (error) {
      console.error('Delete booking error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
