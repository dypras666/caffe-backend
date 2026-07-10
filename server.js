const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const {
  securityHeaders,
  limiter,
  sanitizeInput,
  provideCsrfToken
} = require('./middleware/security');

const { initIntegrations } = require('./services/integrations');

const app = express();

// Security middleware
app.use(securityHeaders);
app.use(limiter);
app.use(cookieParser());
app.use(session({
  secret: process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// CORS
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5174,http://localhost:5175,http://localhost:5173,http://localhost:5176').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Input sanitization
app.use(sanitizeInput);

// CSRF token provider
app.use(provideCsrfToken);

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/media', require('./routes/media'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/tables', require('./routes/tables'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/printers', require('./routes/printers'));
app.use('/api/variants', require('./routes/variants'));
app.use('/api/ingredients', require('./routes/ingredients'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/branches', require('./routes/branches'));
app.use('/api/stations', require('./routes/stations'));
app.use('/api/units', require('./routes/units'));
app.use('/api/members', require('./routes/members'));
app.use('/api/integrations', require('./routes/integrations'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/hr', require('./routes/hr'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/vouchers', require('./routes/vouchers'));
app.use('/api/roles', require('./routes/roles'));
app.use('/api/setup', require('./routes/setup'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api', require('./routes/register'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Café Azzura API is running' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3002;

app.listen(PORT, async () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Admin Panel: http://localhost:${PORT}/api/health\n`);

  await initIntegrations();
});

module.exports = app;
