const db = require('../config/database');

async function isDemoTenant() {
  if (process.env.IS_DEMO === 'true' || process.env.VITE_DEMO_MODE === 'true') {
    return true;
  }
  try {
    const [rows] = await db.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'is_demo_tenant' LIMIT 1"
    );
    if (rows.length && String(rows[0].setting_value) === 'true') {
      return true;
    }
  } catch (_) {}
  return false;
}

module.exports = { isDemoTenant };
