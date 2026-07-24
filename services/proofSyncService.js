/**
 * Sync payment proof photos from local disk → S3.
 * Runs automatically on startup and every 10 minutes.
 * Only activates when STORAGE_DRIVER=s3 is configured.
 */
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const storageService = require('./StorageService');

async function syncProofsToS3() {
  if (storageService.driver !== 's3') return; // nothing to do on pure-local installs

  const [rows] = await db.query(
    `SELECT id, payment_proof_url FROM orders
     WHERE payment_proof_storage = 'local' AND payment_proof_url IS NOT NULL
     LIMIT 50`
  );
  if (!rows.length) return;

  let synced = 0;
  for (const row of rows) {
    try {
      const localPath = path.join(__dirname, '..', row.payment_proof_url);
      if (!fs.existsSync(localPath)) {
        // File gone — clear the stale reference
        await db.query('UPDATE orders SET payment_proof_url = NULL, payment_proof_storage = NULL WHERE id = ?', [row.id]);
        continue;
      }

      const buffer = fs.readFileSync(localPath);
      const filename = path.basename(localPath);
      const mime = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const saved = await storageService.saveS3(filename, buffer, mime);

      await db.query(
        'UPDATE orders SET payment_proof_url = ?, payment_proof_storage = ? WHERE id = ?',
        [saved.url, 's3', row.id]
      );

      // Remove local copy after successful S3 upload
      try { fs.unlinkSync(localPath); } catch {}
      synced++;
    } catch (e) {
      // S3 still unreachable — will retry next cycle
    }
  }

  if (synced > 0) console.log(`[ProofSync] ${synced} proof(s) uploaded to S3`);
}

function startProofSync() {
  // Run once at startup after a short delay
  setTimeout(() => syncProofsToS3().catch(() => {}), 15_000);
  // Then every 10 minutes
  setInterval(() => syncProofsToS3().catch(() => {}), 10 * 60 * 1000);
}

module.exports = { startProofSync, syncProofsToS3 };
