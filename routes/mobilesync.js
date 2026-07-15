/**
 * Mobile Sync API — background sync queue for cafe-kasir
 *
 * POST /api/mobile/sync      — batch submit offline orders
 * GET  /api/mobile/sync/status — queue status for this device
 * POST /api/mobile/sync/:id/retry — retry a failed item
 * GET  /api/mobile/sync/items — list queue items for this device
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');
const db = require('../config/database');

// ─── Ensure tables exist ──────────────────────────────────────────────────────
async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mobile_sync_queue (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      device_id     VARCHAR(100) NOT NULL,
      user_id       INT NOT NULL,
      local_id      VARCHAR(100) NOT NULL,
      entity_type   ENUM('order') DEFAULT 'order',
      payload       JSON NOT NULL,
      checksum      VARCHAR(64) NOT NULL,
      status        ENUM('pending','processing','done','failed','conflict') DEFAULT 'pending',
      attempts      INT DEFAULT 0,
      server_id     INT DEFAULT NULL,
      server_ref    VARCHAR(100) DEFAULT NULL,
      conflict_data JSON DEFAULT NULL,
      error_msg     TEXT DEFAULT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at  TIMESTAMP NULL,
      INDEX idx_device   (device_id),
      INDEX idx_status   (status),
      INDEX idx_user     (user_id),
      UNIQUE KEY uk_device_local (device_id, local_id)
    ) ENGINE=InnoDB
  `).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS mobile_sync_log (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      device_id   VARCHAR(100) NOT NULL,
      user_id     INT NOT NULL,
      batch_id    VARCHAR(64) NOT NULL,
      total       INT DEFAULT 0,
      done        INT DEFAULT 0,
      failed      INT DEFAULT 0,
      conflict    INT DEFAULT 0,
      duration_ms INT DEFAULT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_device (device_id)
    ) ENGINE=InnoDB
  `).catch(() => {});
}
ensureTables();

// ─── Rate limiter per device (10 batch requests / minute) ────────────────────
const deviceWindow = new Map(); // deviceId -> { count, resetAt }
function checkRateLimit(deviceId) {
  const now = Date.now();
  const window = deviceWindow.get(deviceId);
  if (!window || now > window.resetAt) {
    deviceWindow.set(deviceId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (window.count >= 10) return false;
  window.count++;
  return true;
}

// ─── Checksum ─────────────────────────────────────────────────────────────────
function makeChecksum(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ─── POST /api/mobile/sync ────────────────────────────────────────────────────
// Body: { device_id, items: [{ local_id, entity_type, payload, checksum }] }
// Returns: { batch_id, results: [{ local_id, status, server_id?, error? }] }
router.post('/', authenticate, async (req, res) => {
  const { device_id, items } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id wajib' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items tidak boleh kosong' });
  }
  if (items.length > 50) {
    return res.status(400).json({ error: 'Maksimal 50 item per batch' });
  }

  // Rate limit
  if (!checkRateLimit(device_id)) {
    return res.status(429).json({ error: 'Terlalu banyak request. Coba lagi dalam 1 menit.' });
  }

  const batchId = crypto.randomUUID();
  const startAt = Date.now();
  const results = [];
  let done = 0, failed = 0, conflict = 0;

  for (const item of items) {
    const { local_id, entity_type = 'order', payload, checksum } = item;
    if (!local_id || !payload) {
      results.push({ local_id, status: 'failed', error: 'local_id dan payload wajib' });
      failed++;
      continue;
    }

    // Verify checksum — conflict guard
    const serverChecksum = makeChecksum(payload);
    if (checksum && checksum !== serverChecksum) {
      // Enqueue as conflict for manual review
      await db.query(
        `INSERT INTO mobile_sync_queue
           (device_id,user_id,local_id,entity_type,payload,checksum,status,conflict_data)
         VALUES (?,?,?,?,?,?,'conflict',?)
         ON DUPLICATE KEY UPDATE status='conflict', conflict_data=VALUES(conflict_data)`,
        [device_id, req.user.id, local_id, entity_type,
         JSON.stringify(payload), serverChecksum, JSON.stringify({ client: checksum, server: serverChecksum })]
      ).catch(() => {});
      results.push({ local_id, status: 'conflict', error: 'Checksum tidak cocok — data mungkin berubah' });
      conflict++;
      continue;
    }

    // Check duplicate (already processed)
    const [[existing]] = await db.query(
      'SELECT id, status, server_id, server_ref FROM mobile_sync_queue WHERE device_id=? AND local_id=?',
      [device_id, local_id]
    );
    if (existing?.status === 'done') {
      results.push({ local_id, status: 'done', server_id: existing.server_id, server_ref: existing.server_ref });
      done++;
      continue;
    }

    // Enqueue or update existing pending/failed
    await db.query(
      `INSERT INTO mobile_sync_queue (device_id,user_id,local_id,entity_type,payload,checksum,status,attempts)
       VALUES (?,?,?,?,?,?,'pending',0)
       ON DUPLICATE KEY UPDATE payload=VALUES(payload), checksum=VALUES(checksum),
         status=IF(status='done','done','pending'), attempts=0, error_msg=NULL`,
      [device_id, req.user.id, local_id, entity_type, JSON.stringify(payload), serverChecksum]
    );

    // Process immediately (inline worker)
    const result = await processItem(device_id, local_id, entity_type, payload, req.user.id);
    results.push(result);
    if (result.status === 'done') done++;
    else failed++;
  }

  // Log batch
  await db.query(
    `INSERT INTO mobile_sync_log (device_id,user_id,batch_id,total,done,failed,conflict,duration_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
    [device_id, req.user.id, batchId, items.length, done, failed, conflict, Date.now() - startAt]
  ).catch(() => {});

  res.json({ batch_id: batchId, total: items.length, done, failed, conflict, results });
});

// ─── Inline worker — process one item ────────────────────────────────────────
async function processItem(deviceId, localId, entityType, payload, userId) {
  if (entityType !== 'order') {
    await updateQueueItem(deviceId, localId, 'failed', null, null, 'entity_type tidak didukung');
    return { local_id: localId, status: 'failed', error: 'entity_type tidak didukung' };
  }

  try {
    await db.query(
      `UPDATE mobile_sync_queue SET status='processing', attempts=attempts+1 WHERE device_id=? AND local_id=?`,
      [deviceId, localId]
    );

    // Build order via the orders route logic inline
    const ordersRouter = require('./orders');
    // Use direct DB insert instead of HTTP to avoid auth loop
    const order = await createOrderFromPayload(payload, userId);

    await updateQueueItem(deviceId, localId, 'done', order.id, order.order_number, null);
    return { local_id: localId, status: 'done', server_id: order.id, server_ref: order.order_number };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateQueueItem(deviceId, localId, 'failed', null, null, msg);
    return { local_id: localId, status: 'failed', error: msg };
  }
}

async function updateQueueItem(deviceId, localId, status, serverId, serverRef, errorMsg) {
  await db.query(
    `UPDATE mobile_sync_queue
     SET status=?, server_id=?, server_ref=?, error_msg=?, processed_at=NOW()
     WHERE device_id=? AND local_id=?`,
    [status, serverId ?? null, serverRef ?? null, errorMsg ?? null, deviceId, localId]
  );
}

// ─── Direct order create (bypasses HTTP, uses DB directly) ───────────────────
async function createOrderFromPayload(payload, userId) {
  const {
    customer_name, customer_email, customer_phone,
    order_type, table_number, table_id,
    payment_method, notes, discount = 0, items = [],
  } = payload;

  if (!items.length) throw new Error('Order harus memiliki setidaknya 1 item');

  // Generate order number
  const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM orders');
  const orderNumber = `ORD-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Number(cnt)+1).padStart(5,'0')}`;

  // Get tax rate
  const [[taxSetting]] = await db.query(
    "SELECT setting_value FROM system_settings WHERE setting_key='tax_rate' LIMIT 1"
  ).catch(() => [[{ setting_value: '10' }]]);
  const taxRate = parseFloat(taxSetting?.setting_value || '10') / 100;

  // Resolve items and calculate totals
  let subtotal = 0;
  const resolvedItems = [];
  for (const item of items) {
    const [[product]] = await db.query('SELECT id, name, price FROM products WHERE id=?', [item.product_id]);
    if (!product) throw new Error(`Produk #${item.product_id} tidak ditemukan`);
    const unitPrice = Number(product.price);
    const variantExtra = (item.variants || []).reduce((s, v) => {
      // variant price modifier fetched inline if needed — simplified here
      return s;
    }, 0);
    const addonExtra = (item.addons || []).reduce((s, a) => s, 0);
    const lineTotal = (unitPrice + variantExtra + addonExtra) * item.quantity;
    subtotal += lineTotal;
    resolvedItems.push({ ...item, product_name: product.name, unit_price: unitPrice, line_total: lineTotal });
  }

  const taxAmount = Math.round(subtotal * taxRate);
  const total = Math.max(0, subtotal + taxAmount - Number(discount));

  // Insert order
  const [result] = await db.query(
    `INSERT INTO orders
       (order_number, customer_name, customer_email, customer_phone,
        table_number, table_id, order_type, subtotal, tax, discount,
        total, payment_method, payment_status, order_status, notes, served_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending','pending',?,?)`,
    [orderNumber, customer_name || null, customer_email || null, customer_phone || null,
     table_number || null, table_id || null, order_type || 'dine-in',
     subtotal, taxAmount, discount, total, payment_method || 'cash',
     notes || null, userId]
  );
  const orderId = result.insertId;

  // Insert items
  for (const item of resolvedItems) {
    await db.query(
      `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, notes)
       VALUES (?,?,?,?,?,?,?)`,
      [orderId, item.product_id, item.product_name, item.unit_price,
       item.quantity, item.line_total, item.notes || null]
    );
  }

  // Mark table occupied
  if (table_id) {
    await db.query("UPDATE tables SET status='occupied' WHERE id=?", [table_id]).catch(() => {});
  }

  return { id: orderId, order_number: orderNumber };
}

// ─── GET /api/mobile/sync/status ─────────────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id wajib' });

  const [[stats]] = await db.query(
    `SELECT
       SUM(status='pending')    AS pending,
       SUM(status='processing') AS processing,
       SUM(status='done')       AS done,
       SUM(status='failed')     AS failed,
       SUM(status='conflict')   AS conflict
     FROM mobile_sync_queue
     WHERE device_id = ?`,
    [device_id]
  );

  const [recent] = await db.query(
    `SELECT batch_id, total, done, failed, conflict, duration_ms, created_at
     FROM mobile_sync_log WHERE device_id=? ORDER BY created_at DESC LIMIT 5`,
    [device_id]
  );

  res.json({
    device_id,
    queue: {
      pending: Number(stats?.pending || 0),
      processing: Number(stats?.processing || 0),
      done: Number(stats?.done || 0),
      failed: Number(stats?.failed || 0),
      conflict: Number(stats?.conflict || 0),
    },
    recent_batches: recent,
  });
});

// ─── GET /api/mobile/sync/items ──────────────────────────────────────────────
router.get('/items', authenticate, async (req, res) => {
  const { device_id, status } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id wajib' });

  let q = 'SELECT id, local_id, entity_type, status, attempts, server_id, server_ref, error_msg, created_at, processed_at FROM mobile_sync_queue WHERE device_id=?';
  const params = [device_id];
  if (status) { q += ' AND status=?'; params.push(status); }
  q += ' ORDER BY created_at DESC LIMIT 100';

  const [items] = await db.query(q, params);
  res.json({ items });
});

// ─── POST /api/mobile/sync/:id/retry ─────────────────────────────────────────
router.post('/:id/retry', authenticate, async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id wajib' });

  const [[item]] = await db.query(
    'SELECT * FROM mobile_sync_queue WHERE id=? AND device_id=? AND user_id=?',
    [req.params.id, device_id, req.user.id]
  );
  if (!item) return res.status(404).json({ error: 'Item tidak ditemukan' });
  if (item.status === 'done') return res.json({ message: 'Sudah selesai', status: 'done' });
  if (item.attempts >= 5) return res.status(400).json({ error: 'Sudah melebihi batas retry (5x)' });

  const result = await processItem(device_id, item.local_id, item.entity_type, item.payload, req.user.id);
  res.json(result);
});

module.exports = router;
