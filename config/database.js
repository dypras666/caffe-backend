const mysql = require('mysql2');
require('dotenv').config();

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'cafe_azzura',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Get promise pool
const db = pool.promise();

// Also export raw pool for transactions
db.getPool = () => pool;

// Test connection (skip during provisioning/migrations via SKIP_DB_TEST=true)
if (!process.env.SKIP_DB_TEST) {
  pool.getConnection((err, connection) => {
    if (err) {
      console.error('❌ Database connection failed:', err.message);
      process.exit(1);
    }
    console.log('✅ Database connected successfully');
    connection.release();
  });
}

module.exports = db;
