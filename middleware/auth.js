const jwt = require('jsonwebtoken');
const db = require('../config/database');

// Verify JWT Token
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get user from database
    const [users] = await db.query(
      'SELECT id, name, email, role, status, balance, is_priority, branch_id FROM users WHERE id = ? AND status = "active"',
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid token or user inactive' });
    }

    req.user = users[0];
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Role-Based Access Control (RBAC)
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Access denied',
        message: `This action requires one of these roles: ${roles.join(', ')}`
      });
    }

    next();
  };
};

// ─── Dynamic permission cache ────────────────────────────────
// Loaded from roles.permissions JSON in DB, refreshed every 60s
let _permCache = null;
let _permCacheAt = 0;
const PERM_TTL = 60 * 1000;

const loadPermissions = async () => {
  if (_permCache && Date.now() - _permCacheAt < PERM_TTL) return _permCache;
  try {
    const [rows] = await db.query('SELECT name, permissions FROM roles WHERE permissions IS NOT NULL');
    const map = {};
    for (const r of rows) {
      try { map[r.name] = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions; }
      catch (_) {}
    }
    _permCache = map;
    _permCacheAt = Date.now();
    return map;
  } catch (_) {
    return _permCache || {};
  }
};

// Invalidate cache (call after roles are updated)
const invalidatePermCache = () => { _permCache = null; _permCacheAt = 0; };

// Permission checker — reads from DB roles.permissions, falls back to admin=allow
const can = (action, resource) => {
  return async (req, res, next) => {
    const userRole = req.user?.role || 'member';

    // Admin always allowed (unless their permissions explicitly deny)
    if (userRole === 'admin') return next();

    try {
      const perms = await loadPermissions();
      const rolePerms = perms[userRole];

      if (!rolePerms || !rolePerms[resource]) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const resourcePerms = rolePerms[resource];
      // Support both { action: true/false } and ['action1','action2'] formats
      const allowed = Array.isArray(resourcePerms)
        ? resourcePerms.includes(action)
        : resourcePerms[action] === true;

      if (!allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: `You don't have permission to ${action} ${resource}`,
        });
      }
      next();
    } catch (e) {
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
};

// Optional authentication (for public + private endpoints)
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const [users] = await db.query(
        'SELECT id, name, email, role, status, balance, is_priority, branch_id FROM users WHERE id = ? AND status = "active"',
        [decoded.userId]
      );

      if (users.length > 0) {
        req.user = users[0];
      }
    }
    next();
  } catch (error) {
    // Continue without user if token is invalid
    next();
  }
};

module.exports = {
  authenticate,
  authorize,
  can,
  optionalAuth,
  invalidatePermCache,
  loadPermissions,
};
