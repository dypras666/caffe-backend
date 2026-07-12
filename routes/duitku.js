const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const duitku = require('../services/DuitkuService');

// Compatible dengan token dari server.js (field: id) dan middleware/auth.js (field: userId)
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId || decoded.id;
    const [users] = await db.query(
      'SELECT id, name, email, role, status FROM users WHERE id = ? AND status = "active"',
      [userId]
    );
    if (!users.length) return res.status(401).json({ error: 'Invalid token or user inactive' });
    req.user = users[0];
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// POST /api/duitku/create — buat payment request
router.post('/create', authenticate, async (req, res) => {
  try {
    const { order_id, amount, product_details, email, phone, customer_name, payment_method } = req.body;

    if (!amount || parseInt(amount) < 10000) {
      return res.status(400).json({ error: 'Amount minimal Rp 10.000' });
    }

    const merchantOrderId = `CAFE-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    const response = await duitku.createTransaction({
      merchantOrderId,
      amount: parseInt(amount),
      productDetails: product_details || 'Pembayaran Café Azzura',
      email: email || '',
      phoneNumber: phone || '',
      customerVaName: customer_name || 'Customer',
      paymentMethod: payment_method || 'VC',
      itemDetails: order_id ? [{ name: product_details || 'Order', quantity: 1, price: parseInt(amount) }] : [],
    });

    await duitku.saveTransaction({
      merchant_order_id: merchantOrderId,
      order_id: order_id || null,
      payment_method: payment_method || 'VC',
      amount: parseInt(amount),
      product_details: product_details || 'Pembayaran Café Azzura',
      email: email || '',
      status: 'PENDING',
      payment_url: response.paymentUrl,
      va_number: response.vaNumber || null,
      qr_string: response.qrString || null,
      raw_response: response,
    });

    res.json({
      success: true,
      merchant_order_id: merchantOrderId,
      payment_url: response.paymentUrl,
      va_number: response.vaNumber,
      qr_string: response.qrString,
      reference: response.reference,
      amount: parseInt(amount),
    });
  } catch (err) {
    console.error('[Duitku] Create error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// GET /api/duitku/check/:merchantOrderId — cek status transaksi
router.get('/check/:merchantOrderId', authenticate, async (req, res) => {
  try {
    const result = await duitku.checkTransaction(req.params.merchantOrderId);
    res.json(result);
  } catch (err) {
    console.error('[Duitku] Check error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// GET /api/duitku/transactions — list semua transaksi
router.get('/transactions', authenticate, async (req, res) => {
  try {
    const db = require('../config/database');
    const { status, limit = 50, offset = 0 } = req.query;
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status, parseInt(limit), parseInt(offset)] : [parseInt(limit), parseInt(offset)];
    const [rows] = await db.query(
      `SELECT * FROM duitku_transactions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      params
    );
    res.json({ transactions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/duitku/payment-methods — list metode pembayaran tersedia
router.get('/payment-methods', async (req, res) => {
  try {
    const amount = parseInt(req.query.amount) || 10000;
    const result = await duitku.getPaymentMethods(amount);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// POST /payment/callback/duitku — callback dari Duitku (no auth, public)
router.post('/callback', async (req, res) => {
  try {
    console.log('[Duitku] Callback received:', JSON.stringify(req.body));
    const result = await duitku.handleCallback(req.body);
    console.log('[Duitku] Callback processed:', result);
    res.status(200).send('SUCCESS');
  } catch (err) {
    console.error('[Duitku] Callback error:', err.message);
    // Duitku expects 200 even on error to stop retry; but log it
    res.status(400).send(err.message);
  }
});

module.exports = router;
