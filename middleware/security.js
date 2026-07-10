const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Helmet for security headers
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
});

const isLocalhost = (req) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  skip: isLocalhost,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skip: isLocalhost,
  skipSuccessfulRequests: true,
  message: 'Too many login attempts, please try again later.',
});

// CSRF Protection (modern approach)
const csrfTokens = new Map();

const generateCsrfToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const csrfProtection = (req, res, next) => {
  // Skip CSRF for GET, HEAD, OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const token = req.headers['x-csrf-token'] || req.body._csrf;
  const sessionId = req.session?.id || req.headers['x-session-id'];

  if (!sessionId || !token) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  const validToken = csrfTokens.get(sessionId);

  if (!validToken || validToken !== token) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  next();
};

const provideCsrfToken = (req, res, next) => {
  const sessionId = req.session?.id || req.headers['x-session-id'] || crypto.randomUUID();
  const token = generateCsrfToken();

  csrfTokens.set(sessionId, token);

  // Clean old tokens (older than 1 hour)
  setTimeout(() => {
    csrfTokens.delete(sessionId);
  }, 60 * 60 * 1000);

  res.locals.csrfToken = token;
  res.setHeader('X-CSRF-Token', token);
  next();
};

// Input sanitization
const sanitizeInput = (req, res, next) => {
  const sanitize = (obj) => {
    for (let key in obj) {
      if (typeof obj[key] === 'string') {
        // Remove potentially dangerous characters
        obj[key] = obj[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .trim();
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        sanitize(obj[key]);
      }
    }
  };

  if (req.body) sanitize(req.body);
  if (req.query) sanitize(req.query);
  if (req.params) sanitize(req.params);

  next();
};

// SQL Injection Prevention (additional layer)
const preventSqlInjection = (req, res, next) => {
  const sqlPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/gi,
    /('|(--)|;|\/\*|\*\/)/g
  ];

  const checkValue = (value) => {
    if (typeof value === 'string') {
      for (let pattern of sqlPatterns) {
        if (pattern.test(value)) {
          return true;
        }
      }
    }
    return false;
  };

  const checkObject = (obj) => {
    for (let key in obj) {
      if (checkValue(obj[key]) || (typeof obj[key] === 'object' && checkObject(obj[key]))) {
        return true;
      }
    }
    return false;
  };

  if (checkObject(req.body) || checkObject(req.query) || checkObject(req.params)) {
    return res.status(400).json({ error: 'Invalid input detected' });
  }

  next();
};

module.exports = {
  securityHeaders,
  limiter,
  authLimiter,
  csrfProtection,
  provideCsrfToken,
  sanitizeInput,
  preventSqlInjection
};
