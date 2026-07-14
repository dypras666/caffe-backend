const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const db = require('../config/database');
const { Expo } = require('expo-server-sdk');

// Ensure table exists (called on first request if not migrated)
async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS device_push_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token VARCHAR(200) NOT NULL,
      device_name VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_token (user_id, token),
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB
  `).catch(() => {});
}
ensureTable();

// POST /api/push-tokens — register device token
router.post('/', authenticate, async (req, res) => {
  const { token, device_name } = req.body;
  if (!token) return res.status(400).json({ error: 'token wajib diisi' });
  if (!Expo.isExpoPushToken(token)) return res.status(400).json({ error: 'Token tidak valid' });

  await db.query(
    `INSERT INTO device_push_tokens (user_id, token, device_name) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE device_name = VALUES(device_name), updated_at = NOW()`,
    [req.user.id, token, device_name || null]
  );
  res.json({ success: true });
});

// DELETE /api/push-tokens — unregister on logout
router.delete('/', authenticate, async (req, res) => {
  const { token } = req.body;
  if (token) {
    await db.query('DELETE FROM device_push_tokens WHERE user_id = ? AND token = ?', [req.user.id, token]);
  } else {
    // Remove all tokens for this user
    await db.query('DELETE FROM device_push_tokens WHERE user_id = ?', [req.user.id]);
  }
  res.json({ success: true });
});

module.exports = router;
