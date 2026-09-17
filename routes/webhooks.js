const express = require('express');
const router = express.Router();

router.post('/qris', async (req, res) => {
  try {
    // PROTECT WITH API KEY
    const providedKey = req.headers['x-api-key'] || req.query.api_key;
    
    // Check key in settings (qris_webhook_key)
    const [[setting]] = await req.db.query("SELECT setting_value FROM settings WHERE setting_key = 'qris_webhook_key'");
    
    // If setting doesn't exist, allow a fallback ENV key, or reject
    const expectedKey = setting?.setting_value || process.env.WEBHOOK_SECRET;

    if (!expectedKey) {
      return res.status(500).json({ error: 'Webhook key is not configured in settings' });
    }
    
    if (providedKey !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized. Invalid API Key' });
    }

    const { order_id, transaction_id, status, amount } = req.body;
    
    // Fallback: Some gateways send 'transaction_id' or 'orderId' instead of 'order_id'
    const targetOrderId = order_id || req.body.orderId || req.body.reference_id || transaction_id;
    const targetStatus = status || req.body.transaction_status || 'paid';
    
    if (!targetOrderId) {
      return res.status(400).json({ error: 'Order ID is required in webhook payload' });
    }

    if (targetStatus === 'paid' || targetStatus === 'settlement' || targetStatus === 'success') {
      // Find the order
      const [[order]] = await req.db.query('SELECT * FROM orders WHERE id = ? OR receipt_number = ?', [targetOrderId, targetOrderId]);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.payment_status === 'paid') return res.json({ success: true, message: 'Already paid' });

      // Update payment status
      await req.db.query(
        'UPDATE orders SET payment_status = ?, payment_method = ? WHERE id = ?',
        ['paid', 'qris', order.id]
      );
      
      // Emit socket event for real-time kasir update
      if (req.app.get('io') || global.io) {
        const io = req.app.get('io') || global.io;
        io.emit('order_updated', { id: order.id, payment_status: 'paid' });
        io.emit('new_notification', { message: `Pesanan #${order.receipt_number} telah Lunas via QRIS` });
      }

      console.log(`[Webhook QRIS] Order ${order.receipt_number} marked as paid`);
      res.json({ success: true, message: 'Payment status updated' });
    } else {
      res.json({ success: true, message: 'Ignored non-paid status' });
    }
  } catch (error) {
    console.error('[Webhook QRIS Error]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
