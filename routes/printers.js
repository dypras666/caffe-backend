const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

// GET /api/printers
router.get('/', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM printers ORDER BY sort_order, id');
    res.json({ printers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/printers
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { name, type, connection, ip, port, paper_width, char_per_line, is_default, is_active, auto_cut, header_text, footer_text, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama printer wajib' });
  try {
    if (is_default) await db.query('UPDATE printers SET is_default = 0 WHERE type = ?', [type || 'receipt']);
    const [r] = await db.query(
      `INSERT INTO printers (name, type, connection, ip, port, paper_width, char_per_line, is_default, is_active, auto_cut, header_text, footer_text, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, type || 'receipt', connection || 'browser', ip || null, port || 9100, paper_width || '80mm',
       char_per_line || 42, is_default ? 1 : 0, is_active !== false ? 1 : 0, auto_cut !== false ? 1 : 0,
       header_text || null, footer_text || null, sort_order || 0]
    );
    const [[printer]] = await db.query('SELECT * FROM printers WHERE id = ?', [r.insertId]);
    await audit({ userId: req.user.id, action: 'create_printer', tableName: 'printers', recordId: r.insertId, newValues: { name, type }, description: `Tambah printer: ${name}` });
    res.status(201).json({ printer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/printers/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, type, connection, ip, port, paper_width, char_per_line, is_default, is_active, auto_cut, header_text, footer_text, sort_order } = req.body;
  try {
    const [[existing]] = await db.query('SELECT * FROM printers WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Printer tidak ditemukan' });
    if (is_default) await db.query('UPDATE printers SET is_default = 0 WHERE type = ? AND id != ?', [existing.type, req.params.id]);
    const fields = [], vals = [];
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (connection !== undefined) { fields.push('connection=?'); vals.push(connection); }
    if (ip !== undefined) { fields.push('ip=?'); vals.push(ip); }
    if (port !== undefined) { fields.push('port=?'); vals.push(port); }
    if (paper_width !== undefined) { fields.push('paper_width=?'); vals.push(paper_width); }
    if (char_per_line !== undefined) { fields.push('char_per_line=?'); vals.push(char_per_line); }
    if (is_default !== undefined) { fields.push('is_default=?'); vals.push(is_default ? 1 : 0); }
    if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
    if (auto_cut !== undefined) { fields.push('auto_cut=?'); vals.push(auto_cut ? 1 : 0); }
    if (header_text !== undefined) { fields.push('header_text=?'); vals.push(header_text); }
    if (footer_text !== undefined) { fields.push('footer_text=?'); vals.push(footer_text); }
    if (sort_order !== undefined) { fields.push('sort_order=?'); vals.push(sort_order); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE printers SET ${fields.join(',')} WHERE id=?`, vals);
    const [[printer]] = await db.query('SELECT * FROM printers WHERE id=?', [req.params.id]);
    res.json({ printer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/printers/:id
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM printers WHERE id=?', [req.params.id]);
    res.json({ message: 'Printer dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/printers/:id/test — generate test print data
router.post('/:id/test', authenticate, async (req, res) => {
  try {
    const [[printer]] = await db.query('SELECT * FROM printers WHERE id=?', [req.params.id]);
    if (!printer) return res.status(404).json({ error: 'Printer tidak ditemukan' });
    res.json({
      printer,
      test_data: {
        type: 'test',
        lines: [
          { type: 'center', bold: true, text: printer.header_text || 'TEST PRINT' },
          { type: 'divider' },
          { type: 'text', text: `Printer: ${printer.name}` },
          { type: 'text', text: `Tipe: ${printer.type}` },
          { type: 'text', text: `Kertas: ${printer.paper_width}` },
          { type: 'divider' },
          { type: 'center', text: 'Print test berhasil!' },
        ]
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/printers/receipt/:orderId — build receipt data for given order
router.get('/receipt/:orderId', authenticate, async (req, res) => {
  try {
    const [[order]] = await db.query(
      `SELECT o.*, t.name AS table_name, u.name AS served_by_name
       FROM orders o
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN users u ON u.id = o.served_by
       WHERE o.id = ?`, [req.params.orderId]
    );
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [req.params.orderId]);

    const [[siteName]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key="site_name"');
    const [[siteAddress]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key="contact_address"');
    const [[sitePhone]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key="contact_phone"');
    const [[currency]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key="currency_symbol"');

    const [[defaultPrinter]] = await db.query('SELECT * FROM printers WHERE type="receipt" AND is_default=1 AND is_active=1 LIMIT 1').catch(() => [[null]]);

    res.json({
      printer: defaultPrinter,
      receipt: {
        shop_name: siteName?.setting_value || 'Café Azzura',
        address: siteAddress?.setting_value || '',
        phone: sitePhone?.setting_value || '',
        currency: currency?.setting_value || 'Rp',
        order,
        items,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/printers/kitchen/:orderId — kitchen ticket data, grouped by station
router.get('/kitchen/:orderId', authenticate, async (req, res) => {
  try {
    const [[order]] = await db.query(
      `SELECT o.order_number, o.table_number, o.order_type, o.notes, o.created_at,
              t.name AS table_name
       FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = ?`,
      [req.params.orderId]
    );
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

    const [items] = await db.query(
      `SELECT oi.product_name, oi.quantity, oi.notes, oi.station_id,
              s.name AS station_name, s.printer_id
       FROM order_items oi
       LEFT JOIN stations s ON s.id = oi.station_id
       WHERE oi.order_id = ? ORDER BY oi.id`,
      [req.params.orderId]
    );

    // Group items by station
    const stationMap = {};
    for (const item of items) {
      const sid = item.station_id || 0;
      if (!stationMap[sid]) stationMap[sid] = { station_id: sid, station_name: item.station_name || 'Kitchen', printer_id: item.printer_id, items: [] };
      stationMap[sid].items.push({ product_name: item.product_name, quantity: item.quantity, notes: item.notes });
    }

    // Resolve printer for each station
    const tickets = [];
    let primaryPrinter = null;
    for (const [sid, group] of Object.entries(stationMap)) {
      let printer = null;
      if (group.printer_id) {
        [[printer]] = await db.query('SELECT * FROM printers WHERE id = ? AND is_active=1', [group.printer_id]);
      }
      if (!printer) {
        [[printer]] = await db.query(
          'SELECT * FROM printers WHERE type="kitchen" AND is_active=1 ORDER BY is_default DESC, sort_order LIMIT 1'
        ).catch(() => [[null]]);
      }
      if (!primaryPrinter) primaryPrinter = printer;
      tickets.push({ station: group.station_name, printer, items: group.items });
    }

    // Backward compat: flatten to old response shape
    const primaryTicket = tickets.length > 0
      ? { order, items: tickets[0].items }
      : { order, items: [] };
    res.json({ ticket: primaryTicket, printer: primaryPrinter, tickets, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
