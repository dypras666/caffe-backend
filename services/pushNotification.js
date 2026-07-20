const db = require('../config/database');

// expo-server-sdk v6+ is ESM-only — use dynamic wrapper
let Expo = null;
let expo = null;

function getExpo() {
  if (expo) return expo;
  try {
    const sdk = require('expo-server-sdk');
    // v5 CommonJS
    Expo = sdk.Expo || sdk.default?.Expo;
    if (Expo) expo = new Expo();
  } catch (_) {
    // ESM not supported in CommonJS context — push notifications disabled
  }
  return expo;
}

// Send push to all kasir/admin tokens registered for this tenant
async function sendOrderNotification(order) {
  try {
    const [rows] = await db.query(
      `SELECT DISTINCT pt.token FROM device_push_tokens pt
       JOIN users u ON u.id = pt.user_id
       WHERE u.role IN ('admin','kasir') AND u.status = 'active'`
    );

    const expoClient = getExpo();
    if (!expoClient) return; // expo-server-sdk not available
    const tokens = rows.map(r => r.token).filter(t => { try { return expoClient.constructor.isExpoPushToken?.(t) ?? true; } catch { return true; } });
    if (!tokens.length) return;

    const messages = tokens.map(token => ({
      to: token,
      sound: 'default',
      title: 'Order Masuk',
      body: `${order.order_number} · Meja ${order.table_number || 'Takeaway'} · ${formatRp(order.total)}`,
      data: {
        type: 'new_order',
        order_id: order.id,
        order_number: order.order_number,
        order_type: order.order_type,
        table_number: order.table_number,
      },
      badge: 1,
    }));

    const chunks = expoClient.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      const receipts = await expoClient.sendPushNotificationsAsync(chunk);
      // Log invalid tokens for cleanup
      for (let i = 0; i < receipts.length; i++) {
        if (receipts[i].status === 'error' && receipts[i].details?.error === 'DeviceNotRegistered') {
          await db.query('DELETE FROM device_push_tokens WHERE token = ?', [tokens[i]]).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error('[Push] sendOrderNotification error:', e.message);
  }
}

// Clear badge for a user's device when they process an order
async function clearBadgeForUser(userId) {
  try {
    const [rows] = await db.query('SELECT token FROM device_push_tokens WHERE user_id = ?', [userId]);
    const expoClient = getExpo();
    if (!expoClient) return; // expo-server-sdk not available
    const tokens = rows.map(r => r.token).filter(t => { try { return expoClient.constructor.isExpoPushToken?.(t) ?? true; } catch { return true; } });
    if (!tokens.length) return;

    const messages = tokens.map(token => ({ to: token, badge: 0 }));
    const chunks = expoClient.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expoClient.sendPushNotificationsAsync(chunk).catch(() => {});
    }
  } catch (e) {
    console.error('[Push] clearBadge error:', e.message);
  }
}

function formatRp(n) {
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

module.exports = { sendOrderNotification, clearBadgeForUser };
