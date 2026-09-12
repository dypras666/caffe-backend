const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const crypto = require('crypto');

// GET /api/branches
router.get('/', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, COUNT(t.id) AS total_tables FROM branches b
       LEFT JOIN tables t ON t.branch_id = b.id
       GROUP BY b.id ORDER BY b.is_main DESC, b.name`
    );
    res.json({ branches: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/public', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, code, address, phone, city FROM branches WHERE is_active=1 ORDER BY is_main DESC, name');
    res.json({ branches: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { name, code, address, phone, email, city, timezone } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name dan code wajib' });
  try {
    const [r] = await db.query(
      'INSERT INTO branches (name, code, address, phone, email, city, timezone) VALUES (?,?,?,?,?,?,?)',
      [name, code.toUpperCase(), address || null, phone || null, email || null, city || null, timezone || 'Asia/Jakarta']
    );
    const [[branch]] = await db.query('SELECT * FROM branches WHERE id=?', [r.insertId]);
    res.status(201).json({ branch });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Kode cabang sudah ada' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, code, address, phone, email, city, timezone, is_active, is_main } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (address !== undefined) { fields.push('address=?'); vals.push(address); }
  if (phone !== undefined) { fields.push('phone=?'); vals.push(phone); }
  if (email !== undefined) { fields.push('email=?'); vals.push(email); }
  if (city !== undefined) { fields.push('city=?'); vals.push(city); }
  if (timezone !== undefined) { fields.push('timezone=?'); vals.push(timezone); }
  if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (is_main) { await db.query('UPDATE branches SET is_main=0'); fields.push('is_main=1'); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  try {
    vals.push(req.params.id);
    await db.query(`UPDATE branches SET ${fields.join(',')} WHERE id=?`, vals);
    const [[branch]] = await db.query('SELECT * FROM branches WHERE id=?', [req.params.id]);
    res.json({ branch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[b]] = await db.query('SELECT is_main FROM branches WHERE id=?', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Cabang tidak ditemukan' });
    if (b.is_main) return res.status(400).json({ error: 'Tidak bisa hapus cabang utama' });
    await db.query('DELETE FROM branches WHERE id=?', [req.params.id]);
    res.json({ message: 'Cabang dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── QR Code management ───────────────────────────────────────

// GET /api/branches/qr/list — MUST be before /qr/:tableId to avoid route collision
router.get('/qr/list', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT q.*, t.table_number, t.name AS table_name, b.name AS branch_name
       FROM table_qr_codes q
       JOIN tables t ON t.id = q.table_id
       LEFT JOIN branches b ON b.id = q.branch_id
       ORDER BY q.is_active DESC, t.table_number`
    );
    res.json({ qr_codes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/branches/qr/:tableId
router.get('/qr/:tableId', async (req, res) => {
  try {
    const [[qr]] = await db.query(
      `SELECT q.*, t.table_number, t.name AS table_name, b.name AS branch_name
       FROM table_qr_codes q
       JOIN tables t ON t.id = q.table_id
       LEFT JOIN branches b ON b.id = q.branch_id
       WHERE q.table_id=? AND q.is_active=1
       ORDER BY q.id DESC LIMIT 1`,
      [req.params.tableId]
    );
    if (!qr) return res.status(404).json({ error: 'QR tidak ditemukan' });

    // Increment scan count
    await db.query('UPDATE table_qr_codes SET scan_count=scan_count+1, last_scanned_at=NOW() WHERE id=?', [qr.id]);

    res.json({ qr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/branches/qr/generate — generate QR for table
router.post('/qr/generate', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  const {
    table_id, qr_type = 'static', base_url,
    radius_enabled = false, radius_meters = 50,
    table_lat, table_lng, branch_id,
  } = req.body;
  if (!table_id) return res.status(400).json({ error: 'table_id wajib' });

  try {
    const [[table]] = await db.query('SELECT id, table_number, name FROM tables WHERE id=?', [table_id]);
    if (!table) return res.status(404).json({ error: 'Meja tidak ditemukan' });

    // Get base_url from settings if not provided
    let finalBaseUrl = base_url;
    if (!finalBaseUrl) {
      const [[setting]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key="qr_base_url"');
      finalBaseUrl = setting?.setting_value || '';
      if (!finalBaseUrl) {
        const origin = req.headers.origin || (req.headers.host ? 'https://' + req.headers.host : '');
        if (origin) {
          finalBaseUrl = origin.replace('office-', '').replace('admin.', '');
        } else {
          finalBaseUrl = 'http://localhost:5174';
        }
      }
    }

    // Generate unique token for dynamic QR
    const qrToken = crypto.randomBytes(16).toString('hex');

    // QR payload
    const qrData = JSON.stringify({
      t: table_id,                      // table id
      tn: table.table_number,           // table number
      b: branch_id || 1,                // branch id
      type: qr_type,
      token: qrToken,
      ...(radius_enabled ? { lat: table_lat, lng: table_lng, r: radius_meters } : {}),
    });

    const qrUrl = `${finalBaseUrl}?qr=${qrToken}&table=${table.table_number}`;

    // Deactivate old QR for this table
    await db.query('UPDATE table_qr_codes SET is_active=0 WHERE table_id=?', [table_id]);

    const expiresAt = qr_type === 'dynamic'
      ? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
      : null;

    const [r] = await db.query(
      `INSERT INTO table_qr_codes
         (table_id, branch_id, qr_type, qr_token, qr_data, base_url,
          radius_enabled, radius_meters, table_lat, table_lng, expires_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [table_id, branch_id || 1, qr_type, qrToken, qrData, finalBaseUrl,
       radius_enabled ? 1 : 0, radius_meters, table_lat || null, table_lng || null,
       expiresAt, req.user.id]
    );

    res.status(201).json({
      qr_id: r.insertId,
      table,
      qr_token: qrToken,
      qr_url: qrUrl,
      qr_data: qrData,
      qr_type,
      expires_at: expiresAt,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/branches/qr/:qrId — update QR settings WITHOUT changing token
router.put('/qr/:qrId', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  const { qr_type, radius_enabled, radius_meters, table_lat, table_lng, base_url, is_active } = req.body;
  try {
    const [[qr]] = await db.query('SELECT * FROM table_qr_codes WHERE id=?', [req.params.qrId]);
    if (!qr) return res.status(404).json({ error: 'QR tidak ditemukan' });

    const fields = [], vals = [];
    if (qr_type !== undefined) {
      fields.push('qr_type=?'); vals.push(qr_type);
      // If switching to dynamic, set new expiry
      if (qr_type === 'dynamic') {
        const exp = new Date(Date.now() + 8*60*60*1000).toISOString().slice(0,19).replace('T',' ');
        fields.push('expires_at=?'); vals.push(exp);
      } else {
        fields.push('expires_at=NULL');
      }
    }
    if (radius_enabled !== undefined) { fields.push('radius_enabled=?'); vals.push(radius_enabled ? 1 : 0); }
    if (radius_meters !== undefined) { fields.push('radius_meters=?'); vals.push(radius_meters); }
    if (table_lat !== undefined) { fields.push('table_lat=?'); vals.push(table_lat || null); }
    if (table_lng !== undefined) { fields.push('table_lng=?'); vals.push(table_lng || null); }
    if (base_url !== undefined) { fields.push('base_url=?'); vals.push(base_url); }
    if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }

    if (!fields.length) return res.status(400).json({ error: 'Tidak ada field yang diubah' });

    vals.push(req.params.qrId);
    await db.query(`UPDATE table_qr_codes SET ${fields.join(',')} WHERE id=?`, vals);

    const [[updated]] = await db.query('SELECT * FROM table_qr_codes WHERE id=?', [req.params.qrId]);
    const qrUrl = `${updated.base_url}?qr=${updated.qr_token}&table=${qr.table_id}`;

    res.json({ qr: updated, qr_url: qrUrl, message: 'QR diperbarui (token tidak berubah)' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/branches/qr/:qrId
router.delete('/qr/:qrId', authenticate, authorize('admin', 'kasir'), async (req, res) => {
  try {
    const [[qr]] = await db.query('SELECT id FROM table_qr_codes WHERE id=?', [req.params.qrId]);
    if (!qr) return res.status(404).json({ error: 'QR tidak ditemukan' });
    await db.query('DELETE FROM table_qr_codes WHERE id=?', [req.params.qrId]);
    res.json({ message: 'QR dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/branches/qr/validate — validate QR token on scan
router.post('/qr/validate', async (req, res) => {
  const { token, lat, lng } = req.body;
  if (!token) return res.status(400).json({ error: 'token wajib' });

  try {
    const [[qr]] = await db.query(
      `SELECT q.*, t.table_number, t.name AS table_name, t.status AS table_status, t.capacity
       FROM table_qr_codes q JOIN tables t ON t.id = q.table_id
       WHERE q.qr_token=? AND q.is_active=1`,
      [token]
    );
    if (!qr) return res.status(404).json({ error: 'QR tidak valid atau sudah kadaluarsa', valid: false });

    // Check expiry (dynamic QR)
    if (qr.expires_at && new Date(qr.expires_at) < new Date()) {
      return res.status(410).json({ error: 'QR sudah kadaluarsa', valid: false });
    }

    // Check radius if enabled
    if (qr.radius_enabled && lat && lng && qr.table_lat && qr.table_lng) {
      const dist = getDistanceMeters(parseFloat(lat), parseFloat(lng), parseFloat(qr.table_lat), parseFloat(qr.table_lng));
      if (dist > qr.radius_meters) {
        return res.status(403).json({
          error: `Anda terlalu jauh dari meja (${Math.round(dist)}m). Maksimal ${qr.radius_meters}m`,
          valid: false, distance: Math.round(dist),
        });
      }
    }

    // Update scan stats
    await db.query('UPDATE table_qr_codes SET scan_count=scan_count+1, last_scanned_at=NOW() WHERE id=?', [qr.id]);

    res.json({
      valid: true,
      table: {
        id: qr.table_id, table_number: qr.table_number,
        name: qr.table_name, status: qr.table_status, capacity: qr.capacity,
      },
      branch_id: qr.branch_id,
      qr_type: qr.qr_type,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// (duplicate removed — moved to top before /:tableId)

// ─── Haversine distance ───────────────────────────────────────
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── Branch Point Rules ───────────────────────────────────────

// GET /api/branches/:id/point-rules
router.get('/:id/point-rules', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [rules] = await db.query(
      'SELECT * FROM branch_point_rules WHERE branch_id = ? ORDER BY is_active DESC, id',
      [req.params.id]
    );
    res.json({ rules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/branches/:id/point-rules
router.post('/:id/point-rules', authenticate, authorize('admin'), async (req, res) => {
  const { name, points_per_amount, min_transaction, multiplier, notes } = req.body;
  if (!points_per_amount) return res.status(400).json({ error: 'points_per_amount wajib' });
  try {
    const [[branch]] = await db.query('SELECT id FROM branches WHERE id = ?', [req.params.id]);
    if (!branch) return res.status(404).json({ error: 'Cabang tidak ditemukan' });
    const [r] = await db.query(
      `INSERT INTO branch_point_rules (branch_id, name, points_per_amount, min_transaction, multiplier, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, name || 'Default', parseFloat(points_per_amount), parseFloat(min_transaction || 0), parseFloat(multiplier || 1), notes || null]
    );
    const [[rule]] = await db.query('SELECT * FROM branch_point_rules WHERE id = ?', [r.insertId]);
    res.status(201).json({ rule });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/branches/:id/point-rules/:ruleId
router.put('/:id/point-rules/:ruleId', authenticate, authorize('admin'), async (req, res) => {
  const { name, points_per_amount, min_transaction, multiplier, is_active, notes } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name=?'); vals.push(name); }
  if (points_per_amount !== undefined) { fields.push('points_per_amount=?'); vals.push(parseFloat(points_per_amount)); }
  if (min_transaction !== undefined) { fields.push('min_transaction=?'); vals.push(parseFloat(min_transaction)); }
  if (multiplier !== undefined) { fields.push('multiplier=?'); vals.push(parseFloat(multiplier)); }
  if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes); }
  if (!fields.length) return res.status(400).json({ error: 'Tidak ada perubahan' });
  try {
    vals.push(req.params.ruleId, req.params.id);
    await db.query(`UPDATE branch_point_rules SET ${fields.join(',')}, updated_at=NOW() WHERE id=? AND branch_id=?`, vals);
    const [[rule]] = await db.query('SELECT * FROM branch_point_rules WHERE id = ?', [req.params.ruleId]);
    if (!rule) return res.status(404).json({ error: 'Rule tidak ditemukan' });
    res.json({ rule });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/branches/:id/point-rules/:ruleId
router.delete('/:id/point-rules/:ruleId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [[rule]] = await db.query('SELECT id FROM branch_point_rules WHERE id = ? AND branch_id = ?', [req.params.ruleId, req.params.id]);
    if (!rule) return res.status(404).json({ error: 'Rule tidak ditemukan' });
    await db.query('DELETE FROM branch_point_rules WHERE id = ?', [req.params.ruleId]);
    res.json({ message: 'Rule dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
