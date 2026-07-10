const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/audit — full trail with filters, admin only
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const {
      page = 1, limit = 30,
      module, action, severity, user_id,
      date_from, date_to, search,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'WHERE 1=1';
    const params = [];

    if (module)    { where += ' AND a.module = ?';         params.push(module); }
    if (action)    { where += ' AND a.action LIKE ?';      params.push(`%${action}%`); }
    if (severity)  { where += ' AND a.severity = ?';       params.push(severity); }
    if (user_id)   { where += ' AND a.user_id = ?';        params.push(user_id); }
    if (date_from) { where += ' AND DATE(a.created_at) >= ?'; params.push(date_from); }
    if (date_to)   { where += ' AND DATE(a.created_at) <= ?'; params.push(date_to); }
    if (search)    {
      where += ' AND (a.action LIKE ? OR a.description LIKE ? OR u.name LIKE ? OR u.email LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id ${where}`,
      params
    );

    const [logs] = await db.query(
      `SELECT a.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      logs,
      pagination: {
        total, page: parseInt(page), limit: parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/stats — summary counts per module/severity
router.get('/stats', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    let dateWhere = '';
    const params = [];
    if (date_from) { dateWhere += ' AND DATE(created_at) >= ?'; params.push(date_from); }
    if (date_to)   { dateWhere += ' AND DATE(created_at) <= ?'; params.push(date_to); }

    const [byModule] = await db.query(
      `SELECT module, COUNT(*) AS count FROM activity_logs WHERE 1=1 ${dateWhere} GROUP BY module ORDER BY count DESC`,
      params
    );
    const [bySeverity] = await db.query(
      `SELECT severity, COUNT(*) AS count FROM activity_logs WHERE 1=1 ${dateWhere} GROUP BY severity`,
      params
    );
    const [byUser] = await db.query(
      `SELECT u.name AS user_name, u.role, COUNT(*) AS count
       FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.user_id IS NOT NULL ${dateWhere}
       GROUP BY a.user_id ORDER BY count DESC LIMIT 10`,
      params
    );
    const [byDay] = await db.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM activity_logs WHERE 1=1 ${dateWhere}
       GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 30`,
      params
    );
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) AS critical,
         SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) AS warnings,
         SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS today
       FROM activity_logs WHERE 1=1 ${dateWhere}`,
      params
    );

    res.json({ totals, by_module: byModule, by_severity: bySeverity, by_user: byUser, by_day: byDay });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/:id — detail single log with parsed values
router.get('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[log]] = await db.query(
      `SELECT a.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`,
      [req.params.id]
    );
    if (!log) return res.status(404).json({ error: 'Log tidak ditemukan' });

    // Parse JSON fields
    try { if (log.old_values && typeof log.old_values === 'string') log.old_values = JSON.parse(log.old_values); } catch {}
    try { if (log.new_values && typeof log.new_values === 'string') log.new_values = JSON.parse(log.new_values); } catch {}

    res.json({ log });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
