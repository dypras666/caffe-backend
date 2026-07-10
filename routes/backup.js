const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// ─── GET /api/backup/tables — list all tables with row counts ─
router.get('/tables', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [tables] = await db.query(`
      SELECT
        TABLE_NAME AS table_name,
        TABLE_ROWS AS row_count,
        ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024, 1) AS size_kb
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [process.env.DB_NAME]);
    res.json({ tables });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/backup/export — stream SQL dump ────────────────
router.post('/export', authenticate, authorize('admin'), async (req, res) => {
  const { tables = [] } = req.body; // empty = all tables
  const dbName = process.env.DB_NAME;
  const dbUser = process.env.DB_USER;
  const dbPass = process.env.DB_PASSWORD;
  const dbHost = process.env.DB_HOST || '127.0.0.1';
  const dbPort = process.env.DB_PORT || 3306;

  const tableArgs = tables.length > 0 ? tables.join(' ') : '';
  const cmd = `mysqldump -h${dbHost} -P${dbPort} -u${dbUser} -p${dbPass} --single-transaction --routines --triggers ${dbName} ${tableArgs}`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup_${dbName}_${timestamp}.sql`;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  try {
    const output = execSync(cmd, { maxBuffer: 100 * 1024 * 1024 }); // 100MB
    res.send(output);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: `Backup gagal: ${e.message}` });
    }
  }
});

// ─── GET /api/backup/history — list backup files saved on disk ─
router.get('/history', authenticate, authorize('admin'), async (req, res) => {
  const backupDir = path.join(__dirname, '../backups');
  try {
    if (!fs.existsSync(backupDir)) return res.json({ files: [] });
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.sql') || f.endsWith('.sql.gz'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return { name: f, size_kb: Math.round(stat.size / 1024), created_at: stat.mtime };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/backup/save — mysqldump + save to disk ─────────
router.post('/save', authenticate, authorize('admin'), async (req, res) => {
  const dbName = process.env.DB_NAME;
  const dbUser = process.env.DB_USER;
  const dbPass = process.env.DB_PASSWORD;
  const dbHost = process.env.DB_HOST || '127.0.0.1';
  const dbPort = process.env.DB_PORT || 3306;

  const backupDir = path.join(__dirname, '../backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup_${dbName}_${timestamp}.sql`;
  const filepath = path.join(backupDir, filename);

  const cmd = `mysqldump -h${dbHost} -P${dbPort} -u${dbUser} -p${dbPass} --single-transaction --routines --triggers ${dbName}`;

  try {
    const output = execSync(cmd, { maxBuffer: 100 * 1024 * 1024 });
    fs.writeFileSync(filepath, output);
    const size_kb = Math.round(output.length / 1024);
    res.json({ message: 'Backup disimpan', filename, size_kb });
  } catch (e) {
    res.status(500).json({ error: `Backup gagal: ${e.message}` });
  }
});

// ─── DELETE /api/backup/history/:name — delete backup file ────
router.delete('/history/:name', authenticate, authorize('admin'), async (req, res) => {
  const backupDir = path.join(__dirname, '../backups');
  const name = path.basename(req.params.name); // prevent path traversal
  const filepath = path.join(backupDir, name);
  try {
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File tidak ditemukan' });
    fs.unlinkSync(filepath);
    res.json({ message: 'File dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
