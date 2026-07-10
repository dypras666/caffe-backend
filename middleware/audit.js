const db = require('../config/database');

// Module map by table_name / action prefix
const MODULE_MAP = {
  orders: 'order', order_items: 'order',
  products: 'inventory', categories: 'inventory',
  stock_cards: 'stock', purchase_orders: 'stock', stock_opnames: 'stock', suppliers: 'stock',
  bookings: 'booking',
  users: 'user',
  system_settings: 'settings',
  media: 'media',
  payment_methods: 'payment', balance_transactions: 'payment',
  rooms: 'room', tables: 'room',
};

// Severity by action keyword
const SEVERITY_MAP = {
  delete: 'warning',
  cancel: 'warning',
  approve: 'info',
  login: 'info',
  logout: 'info',
  failed: 'critical',
  reject: 'warning',
  topup: 'info',
  change_password: 'warning',
  register: 'info',
  receive: 'info',
};

const detectSeverity = (action) => {
  for (const [key, sev] of Object.entries(SEVERITY_MAP)) {
    if (action.toLowerCase().includes(key)) return sev;
  }
  return 'info';
};

const detectModule = (tableName, action) => {
  if (tableName && MODULE_MAP[tableName]) return MODULE_MAP[tableName];
  // Fallback from action prefix
  if (action.includes('order')) return 'order';
  if (action.includes('stock') || action.includes('po') || action.includes('opname') || action.includes('supplier')) return 'stock';
  if (action.includes('product') || action.includes('categor')) return 'inventory';
  if (action.includes('booking')) return 'booking';
  if (action.includes('user') || action.includes('login') || action.includes('password') || action.includes('register')) return 'user';
  if (action.includes('setting')) return 'settings';
  if (action.includes('media')) return 'media';
  if (action.includes('payment') || action.includes('topup') || action.includes('balance')) return 'payment';
  if (action.includes('room') || action.includes('table')) return 'room';
  return 'system';
};

/**
 * Log an audit event.
 * @param {object} opts
 * @param {number|null}  opts.userId
 * @param {string}       opts.action      - e.g. 'create_product'
 * @param {string|null}  opts.tableName
 * @param {number|null}  opts.recordId
 * @param {object|null}  opts.oldValues
 * @param {object|null}  opts.newValues
 * @param {string|null}  opts.ipAddress
 * @param {string|null}  opts.userAgent
 * @param {string|null}  opts.description - human-readable summary
 * @param {'info'|'warning'|'critical'} [opts.severity]
 */
const audit = async ({
  userId = null, action, tableName = null, recordId = null,
  oldValues = null, newValues = null, ipAddress = null, userAgent = null,
  description = null, severity = null,
}) => {
  try {
    const module = detectModule(tableName, action);
    const sev = severity || detectSeverity(action);
    await db.query(
      `INSERT INTO activity_logs
         (user_id, action, table_name, record_id, old_values, new_values,
          ip_address, user_agent, severity, module, description)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId, action, tableName, recordId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        ipAddress, userAgent, sev, module, description,
      ]
    );
  } catch (e) {
    // Never crash the main request because of audit failure
    console.error('[audit]', e.message);
  }
};

/**
 * Express middleware that auto-logs every mutating request after it completes.
 * Attach req._auditMeta = { action, tableName, recordId, description } to override.
 */
const auditMiddleware = (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    // Only log on success mutations
    if (req.method !== 'GET' && res.statusCode < 400 && req._auditMeta) {
      const { action, tableName, recordId, description, oldValues, newValues } = req._auditMeta;
      audit({
        userId: req.user?.id || null,
        action,
        tableName,
        recordId,
        oldValues,
        newValues,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        description,
      });
    }
    return originalJson(body);
  };
  next();
};

module.exports = { audit, auditMiddleware, detectModule, detectSeverity };
