const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const IntegrationManager = require('../services/integrations/IntegrationManager');

const manager = IntegrationManager.getInstance();

router.use(authenticate);
router.use(authorize('admin'));

router.get('/', async (req, res) => {
  try {
    const integrations = await manager.getIntegrations();
    const providers = manager.getAvailableProviders();
    res.json({ integrations, providers });
  } catch (error) {
    console.error('Get integrations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/providers', async (req, res) => {
  try {
    const providers = manager.getAvailableProviders();
    res.json({ providers });
  } catch (error) {
    console.error('Get providers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/logs',
  [
    query('integration_id').optional().isInt({ min: 1 }),
    query('status').optional().isIn(['success', 'failed']),
    query('reference_type').optional().isIn(['booking', 'order', 'test']),
    query('reference_id').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const logs = await manager.getLogs(req.query);
      res.json({ logs });
    } catch (error) {
      console.error('Get logs error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.get('/wifi',
  [
    query('booking_id').optional().isInt({ min: 1 }),
    query('order_id').optional().isInt({ min: 1 }),
    query('status').optional().isIn(['active', 'expired', 'revoked']),
  ],
  async (req, res) => {
    try {
      const credentials = await manager.getWiFiCredentials(req.query);
      res.json({ credentials });
    } catch (error) {
      console.error('Get wifi credentials error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.get('/:id',
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const integration = await manager.getIntegrationById(req.params.id);
      if (!integration) return res.status(404).json({ error: 'Integrasi tidak ditemukan' });

      const providers = manager.getAvailableProviders();
      res.json({ integration, providers });
    } catch (error) {
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.post('/',
  [
    body('name').trim().notEmpty().withMessage('Nama integrasi wajib diisi'),
    body('provider').trim().notEmpty().withMessage('Provider wajib dipilih'),
    body('slug').optional().trim(),
    body('description').optional().trim(),
    body('config').optional().isObject(),
    body('status').optional().isIn(['active', 'inactive']),
    body('trigger_events').optional().isArray(),
    body('run_order').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const id = await manager.createIntegration(req.body);
      res.status(201).json({ message: 'Integrasi berhasil dibuat', id });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

router.put('/:id',
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      await manager.updateIntegration(req.params.id, req.body);
      res.json({ message: 'Integrasi berhasil diupdate' });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

router.delete('/:id',
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      await manager.deleteIntegration(req.params.id);
      res.json({ message: 'Integrasi berhasil dihapus' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.post('/:id/test',
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const result = await manager.testIntegration(req.params.id);
      res.json({ message: 'Test integrasi selesai', result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

// --- MikroTik RouterOS Management ---

const mk = require('../services/integrations/mikrotikProxy');

router.get('/mikrotik/system/resource', async (req, res) => {
  try {
    const data = await mk.proxyGet('/system/resource');
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/mikrotik/system/identity', async (req, res) => {
  try {
    const data = await mk.proxyGet('/system/identity');
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/mikrotik/interface', async (req, res) => {
  try {
    const data = await mk.proxyGet('/interface');
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.post('/mikrotik/interface/monitor-traffic/:interface', async (req, res) => {
  try {
    const data = await mk.proxyPost(
      `/interface/monitor-traffic`,
      { interface: req.params.interface, once: '' }
    );
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/mikrotik/queue/simple', async (req, res) => {
  try {
    const data = await mk.proxyGet('/queue/simple');
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.post('/mikrotik/queue/simple', async (req, res) => {
  try {
    const data = await mk.proxyPut('/queue/simple', req.body);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.patch('/mikrotik/queue/simple/:id', async (req, res) => {
  try {
    const data = await mk.proxyPatch(`/queue/simple/${req.params.id}`, req.body);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.delete('/mikrotik/queue/simple/:id', async (req, res) => {
  try {
    const data = await mk.proxyDelete(`/queue/simple/${req.params.id}`);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/mikrotik/hotspot/active', async (req, res) => {
  try {
    const data = await mk.proxyGet('/ip/hotspot/active');
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/mikrotik/hotspot/user', async (req, res) => {
  try {
    const data = await mk.proxyGet('/ip/hotspot/user');
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.post('/mikrotik/hotspot/active/:id/kill', async (req, res) => {
  try {
    const data = await mk.proxyPost(`/ip/hotspot/active/${req.params.id}/remove`, {});
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.patch('/mikrotik/hotspot/user/:id', async (req, res) => {
  try {
    const data = await mk.proxyPatch(`/ip/hotspot/user/${req.params.id}`, req.body);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.delete('/mikrotik/hotspot/user/:id', async (req, res) => {
  try {
    const data = await mk.proxyDelete(`/ip/hotspot/user/${req.params.id}`);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// ─── MikroTik Usage by Table & Order Details ───────────────

router.get('/mikrotik/hotspot/active-with-details', async (req, res) => {
  try {
    const db = require('../config/database');
    const activeUsers = await mk.proxyGet('/ip/hotspot/active');
    const activeList = Array.isArray(activeUsers) ? activeUsers : [];
    const activeUsernames = new Set(activeList.map(u => u.user));

    // Get our local WiFi credentials + associated orders/bookings
    const [creds] = await db.query(`
      SELECT w.*, o.order_number, o.table_number AS order_table, o.customer_name, o.total, o.order_status,
             b.name AS booking_name, b.table_number AS booking_table, b.guests, b.booking_date
      FROM wifi_credentials w
      LEFT JOIN orders o ON o.id = w.order_id
      LEFT JOIN bookings b ON b.id = w.booking_id
      WHERE w.status = 'active'
      ORDER BY w.created_at DESC
      LIMIT 50
    `);

    const enrichedMap = new Map();

    // First: active hotspot users from RouterOS
    for (const u of activeList) {
      const username = u.user || '';
      const cred = creds.find(c => c.username === username) || null;

      let order = null;
      let booking = null;

      if (cred) {
        if (cred.order_id) {
          order = {
            id: cred.order_id,
            order_number: cred.order_number,
            table_number: cred.order_table,
            customer_name: cred.customer_name,
            total: cred.total,
            order_status: cred.order_status,
          };
        }
        if (cred.booking_id) {
          booking = {
            id: cred.booking_id,
            name: cred.booking_name,
            table_number: cred.booking_table,
            guests: cred.guests,
            booking_date: cred.booking_date,
          };
        }
      }

      enrichedMap.set(username, {
        online: true,
        hotspot: u,
        credential: cred,
        order,
        booking,
        items: [],
      });
    }

    // Second: local credentials NOT currently online → still show with order data
    for (const cred of creds) {
      if (activeUsernames.has(cred.username)) continue; // already added above

      let order = null;
      let booking = null;

      if (cred.order_id) {
        // Fetch order items for offline entries too
        order = {
          id: cred.order_id,
          order_number: cred.order_number,
          table_number: cred.order_table,
          customer_name: cred.customer_name,
          total: cred.total,
          order_status: cred.order_status,
        };
      }
      if (cred.booking_id) {
        booking = {
          id: cred.booking_id,
          name: cred.booking_name,
          table_number: cred.booking_table,
          guests: cred.guests,
          booking_date: cred.booking_date,
        };
      }

      enrichedMap.set(cred.username, {
        online: false,
        hotspot: null,
        credential: cred,
        order,
        booking,
        items: [],
      });
    }

    // Batch-fetch order items for all unique order IDs
    const orderIds = [...new Set(
      [...enrichedMap.values()]
        .filter(e => e.order?.id)
        .map(e => e.order.id)
    )];

    const itemsByOrder = {};
    if (orderIds.length > 0) {
      const [allItems] = await db.query(
        `SELECT oi.order_id, oi.product_name AS oi_name, oi.quantity, oi.unit_price, oi.product_price, oi.notes,
                p.name AS product_name
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id IN (?)`,
        [orderIds]
      );
      for (const item of allItems) {
        const oid = item.order_id;
        if (!itemsByOrder[oid]) itemsByOrder[oid] = [];
        itemsByOrder[oid].push({
          product_name: item.product_name || item.oi_name,
          quantity: item.quantity,
          price: item.unit_price || item.product_price,
          notes: item.notes,
        });
      }
    }

    // Attach items
    for (const entry of enrichedMap.values()) {
      if (entry.order?.id && itemsByOrder[entry.order.id]) {
        entry.items = itemsByOrder[entry.order.id];
      }
    }

    const enriched = [...enrichedMap.values()];

    res.json(enriched);
  } catch (error) {
    console.error('active-with-details error:', error);
    res.status(502).json({ error: error.message });
  }
});

router.get('/mikrotik/connection/tracking', async (req, res) => {
  try {
    const data = await mk.proxyGet('/ip/firewall/connection');
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/mikrotik/dns/cache', async (req, res) => {
  try {
    const data = await mk.proxyGet('/ip/dns/cache');
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
