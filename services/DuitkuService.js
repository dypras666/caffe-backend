const crypto = require('crypto');
const axios = require('axios');
const db = require('../config/database');

// API v2: api-sandbox / api prod, auth via headers
const DUITKU_SANDBOX_URL = 'https://api-sandbox.duitku.com/api/merchant';
const DUITKU_PROD_URL = 'https://api-prod.duitku.com/api/merchant';
const DUITKU_SANDBOX_LEGACY = 'https://sandbox.duitku.com/webapi/api/merchant';
const DUITKU_PROD_LEGACY = 'https://passport.duitku.com/webapi/api/merchant';

class DuitkuService {
  constructor() {
    this.merchantCode = process.env.DUITKU_MERCHANT_CODE;
    this.apiKey = process.env.DUITKU_API_KEY;
    this.callbackUrl = process.env.DUITKU_CALLBACK_URL;
    this.returnUrl = process.env.DUITKU_RETURN_URL;
    const isProd = process.env.NODE_ENV === 'production';
    this.baseUrl = isProd ? DUITKU_PROD_URL : DUITKU_SANDBOX_URL;
    this.legacyUrl = isProd ? DUITKU_PROD_LEGACY : DUITKU_SANDBOX_LEGACY;
  }

  _headers() {
    const timestamp = Date.now();
    const signature = crypto
      .createHash('sha256')
      .update(`${this.merchantCode}${timestamp}${this.apiKey}`)
      .digest('hex');
    return {
      'Content-Type': 'application/json',
      'x-duitku-signature': signature,
      'x-duitku-timestamp': timestamp.toString(),
      'x-duitku-merchantcode': this.merchantCode,
    };
  }

  // Signature untuk verifikasi callback (md5)
  _callbackSignature(amount, merchantOrderId) {
    return crypto
      .createHash('md5')
      .update(`${this.merchantCode}${amount}${merchantOrderId}${this.apiKey}`)
      .digest('hex');
  }

  async createTransaction({ merchantOrderId, amount, productDetails, email, phoneNumber, itemDetails, customerVaName, paymentMethod }) {
    const payload = {
      merchantOrderId,
      paymentAmount: amount,
      paymentMethod: paymentMethod || 'VA',
      productDetails,
      merchantUserInfo: email || '',
      customerVaName: customerVaName || 'Customer',
      email: email || '',
      phoneNumber: phoneNumber || '',
      itemDetails: itemDetails || [],
      callbackUrl: this.callbackUrl,
      returnUrl: this.returnUrl,
      expiryPeriod: 60,
    };

    const res = await axios.post(`${this.baseUrl}/createInvoice`, payload, {
      headers: this._headers(),
    });

    return res.data;
  }

  async checkTransaction(merchantOrderId) {
    // Cek dari DB lokal (reliable) + hit Duitku jika ada
    const [rows] = await db.query(
      'SELECT * FROM duitku_transactions WHERE merchant_order_id = ?',
      [merchantOrderId]
    );
    if (!rows.length) throw new Error('Transaction not found');

    const local = rows[0];
    // Jika sudah SUCCESS/FAILED, kembalikan dari DB saja
    if (['SUCCESS', 'FAILED'].includes(local.status)) {
      return { merchantOrderId, status: local.status, reference: local.reference, source: 'db' };
    }

    // Coba hit Duitku untuk status terbaru
    try {
      const res = await axios.post(
        `${this.baseUrl}/getStatus`,
        { merchantOrderId },
        { headers: this._headers() }
      );
      return { ...res.data, source: 'duitku' };
    } catch {
      return { merchantOrderId, status: local.status, reference: local.reference, source: 'db' };
    }
  }

  async getPaymentMethods(amount) {
    const datetime = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const signature = crypto
      .createHash('sha256')
      .update(`${this.merchantCode}${amount}${datetime}${this.apiKey}`)
      .digest('hex');
    const res = await axios.post(
      `${this.legacyUrl}/paymentmethod/getpaymentmethod`,
      { merchantcode: this.merchantCode, amount, datetime, signature },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return res.data;
  }

  verifyCallback({ merchantOrderId, amount, resultCode, signature }) {
    const expected = this._callbackSignature(amount, merchantOrderId);
    return expected === signature;
  }

  async saveTransaction(data) {
    const {
      merchant_order_id, order_id, payment_method, amount,
      product_details, email, status, reference, payment_url,
      va_number, qr_string, raw_response,
    } = data;

    const [existing] = await db.query(
      'SELECT id FROM duitku_transactions WHERE merchant_order_id = ?',
      [merchant_order_id]
    );

    if (existing.length) {
      await db.query(
        'UPDATE duitku_transactions SET status=?, reference=?, updated_at=NOW() WHERE merchant_order_id=?',
        [status, reference || null, merchant_order_id]
      );
      return existing[0].id;
    }

    const [r] = await db.query(
      `INSERT INTO duitku_transactions
        (merchant_order_id, order_id, payment_method, amount, product_details,
         email, status, reference, payment_url, va_number, qr_string, raw_response)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        merchant_order_id, order_id || null, payment_method || null,
        amount, product_details || null, email || null,
        status || 'PENDING', reference || null, payment_url || null,
        va_number || null, qr_string || null,
        raw_response ? JSON.stringify(raw_response) : null,
      ]
    );
    return r.insertId;
  }

  async handleCallback(body) {
    const { merchantCode, amount, merchantOrderId, resultCode, reference, signature } = body;

    if (!this.verifyCallback({ merchantOrderId, amount, resultCode, signature })) {
      throw new Error('Invalid callback signature');
    }

    const statusMap = { '00': 'SUCCESS', '01': 'PENDING', '02': 'FAILED' };
    const status = statusMap[resultCode] || 'UNKNOWN';

    await this.saveTransaction({
      merchant_order_id: merchantOrderId,
      amount: parseInt(amount),
      status,
      reference,
    });

    if (status === 'SUCCESS') {
      await this._fulfillOrder(merchantOrderId);
    }

    return { status, merchantOrderId, reference };
  }

  async _fulfillOrder(merchantOrderId) {
    const [rows] = await db.query(
      'SELECT order_id FROM duitku_transactions WHERE merchant_order_id = ?',
      [merchantOrderId]
    );
    if (!rows.length || !rows[0].order_id) return;

    await db.query(
      "UPDATE orders SET status='paid', payment_method='duitku', payment_at=NOW() WHERE id=?",
      [rows[0].order_id]
    );
  }
}

module.exports = new DuitkuService();
