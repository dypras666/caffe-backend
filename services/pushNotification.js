const { Expo } = require('expo-server-sdk');
const db = require('../config/database');

const expo = new Expo();

// Send push to all kasir/admin tokens registered for this tenant
async function sendOrderNotification(order) {
  try {
    const [rows] = await db.query(
      `SELECT DISTINCT pt.token FROM device_push_tokens pt
       JOIN users u ON u.id = pt.user_id
       WHERE u.role IN ('admin','kasir') AND u.status = 'active'`
    );

    const tokens = rows.map(r => r.token).filter(t => Expo.isExpoPushToken(t));
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

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
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
    const tokens = rows.map(r => r.token).filter(t => Expo.isExpoPushToken(t));
    if (!tokens.length) return;

    const messages = tokens.map(token => ({ to: token, badge: 0 }));
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk).catch(() => {});
    }
  } catch (e) {
    console.error('[Push] clearBadge error:', e.message);
  }
}

function formatRp(n) {
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

module.exports = { sendOrderNotification, clearBadgeForUser };
