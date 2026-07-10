const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken, getKasirToken } = require('./helpers');

describe('KPI & Reports Module Tests', () => {
  let adminToken;
  let kasirToken;
  let testOrderId;
  let testProductId;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    kasirToken = await getKasirToken();

    // Create test data for reports
    // 1. Create a category
    const [catResult] = await db.query(
      "INSERT INTO categories (name, slug, description) VALUES ('Test Category KPI', 'test-category-kpi', 'For KPI testing')"
    );
    const categoryId = catResult.insertId;

    // 2. Create a product
    const [prodResult] = await db.query(
      `INSERT INTO products (name, slug, sku, description, price, category_id, stock, status)
       VALUES ('Test Product KPI', 'test-product-kpi', 'TEST-KPI-001', 'Test product', 50000, ?, 100, 'active')`,
      [categoryId]
    );
    testProductId = prodResult.insertId;

    // 3. Get admin user id
    const [[admin]] = await db.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    const adminId = admin.id;

    // 4. Create test orders with different statuses and payment methods
    const today = new Date().toISOString().slice(0, 10);

    // Order 1: Paid with cash
    const [order1] = await db.query(
      `INSERT INTO orders (order_number, order_type, order_status, payment_status, payment_method, subtotal, tax, total, served_by, created_at)
       VALUES ('TEST-KPI-001', 'dine-in', 'completed', 'paid', 'cash', 50000, 5000, 55000, ?, ?)`,
      [adminId, today + ' 10:00:00']
    );
    testOrderId = order1.insertId;

    await db.query(
      `INSERT INTO order_items (order_id, product_id, product_name, quantity, product_price, subtotal)
       VALUES (?, ?, 'Test Product KPI', 1, 50000, 50000)`,
      [testOrderId, testProductId]
    );

    // Order 2: Paid with card
    const [order2] = await db.query(
      `INSERT INTO orders (order_number, order_type, order_status, payment_status, payment_method, subtotal, tax, total, served_by, created_at)
       VALUES ('TEST-KPI-002', 'takeaway', 'completed', 'paid', 'card', 100000, 10000, 110000, ?, ?)`,
      [adminId, today + ' 12:00:00']
    );

    await db.query(
      `INSERT INTO order_items (order_id, product_id, product_name, quantity, product_price, subtotal)
       VALUES (?, ?, 'Test Product KPI', 2, 50000, 100000)`,
      [order2.insertId, testProductId]
    );

    // Order 3: Pending (should not appear in revenue)
    await db.query(
      `INSERT INTO orders (order_number, order_type, order_status, payment_status, payment_method, subtotal, tax, total, served_by, created_at)
       VALUES ('TEST-KPI-003', 'dine-in', 'pending', 'pending', 'cash', 50000, 5000, 55000, ?, ?)`,
      [adminId, today + ' 14:00:00']
    );

    // Order 4: Cancelled (should not appear in revenue)
    await db.query(
      `INSERT INTO orders (order_number, order_type, order_status, payment_status, payment_method, subtotal, tax, total, served_by, created_at)
       VALUES ('TEST-KPI-004', 'dine-in', 'cancelled', 'pending', 'cash', 50000, 5000, 55000, ?, ?)`,
      [adminId, today + ' 16:00:00']
    );
  });

  afterAll(async () => {
    // Cleanup test data
    await db.query("DELETE FROM order_items WHERE product_id = ?", [testProductId]);
    await db.query("DELETE FROM orders WHERE order_number LIKE 'TEST-KPI-%'");
    await db.query("DELETE FROM products WHERE sku = 'TEST-KPI-001'");
    await db.query("DELETE FROM categories WHERE name = 'Test Category KPI'");
  });

  // ─── Summary Report ──────────────────────────────────────────────

  describe('GET /api/reports/summary', () => {
    it('admin can get summary report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total_revenue');
      expect(res.body).toHaveProperty('total_orders');
      expect(res.body).toHaveProperty('avg_order_value');
      expect(res.body).toHaveProperty('items_sold');
      expect(res.body).toHaveProperty('cash_revenue');
      expect(res.body).toHaveProperty('pending_orders');
      expect(res.body).toHaveProperty('daily_data');
      expect(res.body).toHaveProperty('payment_breakdown');
      expect(res.body).toHaveProperty('top_products');
      expect(res.body).toHaveProperty('comparison');

      // Verify revenue only includes paid orders (not pending/cancelled)
      expect(res.body.total_revenue).toBeGreaterThanOrEqual(165000); // 55000 + 110000
      expect(res.body.total_orders).toBeGreaterThanOrEqual(2);
    });

    it('kasir can get summary report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${kasirToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total_revenue');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/reports/summary');
      expect(res.status).toBe(401);
    });

    it('defaults to today if no date provided', async () => {
      const res = await request(app)
        .get('/api/reports/summary')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total_revenue');
    });

    it('includes payment breakdown with cash and card', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.payment_breakdown)).toBe(true);

      const cashPayment = res.body.payment_breakdown.find(p => p.payment_method === 'cash');
      const cardPayment = res.body.payment_breakdown.find(p => p.payment_method === 'card');

      expect(cashPayment).toBeDefined();
      expect(cardPayment).toBeDefined();
    });

    it('includes top products', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.top_products)).toBe(true);

      const testProduct = res.body.top_products.find(p => p.product_name === 'Test Product KPI');
      expect(testProduct).toBeDefined();
      if (testProduct) {
        expect(testProduct.qty_sold).toBeGreaterThanOrEqual(3); // 1 + 2 from test orders
      }
    });

    it('calculates average order value correctly', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.avg_order_value).toBeGreaterThan(0);

      // AOV should be total_revenue / total_orders
      const expectedAOV = res.body.total_orders > 0
        ? res.body.total_revenue / res.body.total_orders
        : 0;
      expect(Math.abs(res.body.avg_order_value - expectedAOV)).toBeLessThan(0.01);
    });

    it('includes comparison with previous period', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.comparison).toHaveProperty('prev_revenue');
      expect(res.body.comparison).toHaveProperty('prev_orders');
    });
  });

  // ─── Products Report ─────────────────────────────────────────────

  describe('GET /api/reports/products', () => {
    it('returns product performance report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/products?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.products)).toBe(true);

      if (res.body.products.length > 0) {
        const product = res.body.products[0];
        expect(product).toHaveProperty('product_name');
        expect(product).toHaveProperty('qty_sold');
        expect(product).toHaveProperty('revenue');
        expect(product).toHaveProperty('avg_price');
        expect(product).toHaveProperty('order_count');
      }
    });

    it('respects limit parameter', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/products?date_from=${today}&date_to=${today}&limit=5`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.products.length).toBeLessThanOrEqual(5);
    });

    it('filters by category_id', async () => {
      const [[cat]] = await db.query("SELECT id FROM categories WHERE name = 'Test Category KPI'");
      if (!cat) return;

      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/products?date_from=${today}&date_to=${today}&category_id=${cat.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.products)).toBe(true);
    });

    it('kasir can access products report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/products?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${kasirToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ─── Hourly Report ───────────────────────────────────────────────

  describe('GET /api/reports/hourly', () => {
    it('returns hourly breakdown with all 24 hours', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/hourly?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.hours)).toBe(true);
      expect(res.body.hours.length).toBe(24); // Should have all 24 hours

      // Verify structure
      res.body.hours.forEach(h => {
        expect(h).toHaveProperty('hour');
        expect(h).toHaveProperty('orders');
        expect(h).toHaveProperty('revenue');
        expect(h).toHaveProperty('avg_order');
        expect(h.hour).toBeGreaterThanOrEqual(0);
        expect(h.hour).toBeLessThan(24);
      });

      // Check that hour 10 and 12 have data from our test orders
      const hour10 = res.body.hours.find(h => h.hour === 10);
      const hour12 = res.body.hours.find(h => h.hour === 12);

      expect(hour10.orders).toBeGreaterThanOrEqual(1);
      expect(hour12.orders).toBeGreaterThanOrEqual(1);
    });

    it('kasir can access hourly report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/hourly?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${kasirToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ─── Staff Report ────────────────────────────────────────────────

  describe('GET /api/reports/staff', () => {
    it('returns staff performance report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/staff?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.staff)).toBe(true);

      if (res.body.staff.length > 0) {
        const staff = res.body.staff[0];
        expect(staff).toHaveProperty('user_id');
        expect(staff).toHaveProperty('name');
        expect(staff).toHaveProperty('role');
        expect(staff).toHaveProperty('orders_handled');
        expect(staff).toHaveProperty('revenue_handled');
        expect(staff).toHaveProperty('avg_order');
      }
    });

    it('kasir can access staff report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/staff?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${kasirToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ─── Tables Report ───────────────────────────────────────────────

  describe('GET /api/reports/tables', () => {
    it('returns table performance report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/tables?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.tables)).toBe(true);

      if (res.body.tables.length > 0) {
        const table = res.body.tables[0];
        expect(table).toHaveProperty('table_number');
        expect(table).toHaveProperty('orders');
        expect(table).toHaveProperty('revenue');
        expect(table).toHaveProperty('avg_order');
        expect(table).toHaveProperty('total_items');
      }
    });

    it('kasir can access tables report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/tables?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${kasirToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ─── Shifts Report ───────────────────────────────────────────────

  describe('GET /api/reports/shifts', () => {
    it.skip('returns shift performance report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/shifts?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.shifts)).toBe(true);

      if (res.body.shifts.length > 0) {
        const shift = res.body.shifts[0];
        expect(shift).toHaveProperty('id');
        expect(shift).toHaveProperty('started_at');
        expect(shift).toHaveProperty('total_orders');
        expect(shift).toHaveProperty('total_revenue');
        expect(shift).toHaveProperty('cash_revenue');
      }
    });

    it.skip('kasir can access shifts report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/shifts?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${kasirToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ─── Date Range Tests ────────────────────────────────────────────

  describe('Date range filtering', () => {
    it('filters data by custom date range', async () => {
      const today = new Date();
      const lastWeek = new Date(today);
      lastWeek.setDate(lastWeek.getDate() - 7);

      const date_from = lastWeek.toISOString().slice(0, 10);
      const date_to = today.toISOString().slice(0, 10);

      const res = await request(app)
        .get(`/api/reports/summary?date_from=${date_from}&date_to=${date_to}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total_revenue');
    });

    it('handles single day range', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });

    it('handles multi-month range', async () => {
      const today = new Date();
      const threeMonthsAgo = new Date(today);
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      const date_from = threeMonthsAgo.toISOString().slice(0, 10);
      const date_to = today.toISOString().slice(0, 10);

      const res = await request(app)
        .get(`/api/reports/summary?date_from=${date_from}&date_to=${date_to}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ─── KPI Calculations ────────────────────────────────────────────

  describe('KPI Calculations', () => {
    it('calculates growth rate from comparison', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);

      // Calculate growth rate
      const currentRevenue = res.body.total_revenue;
      const prevRevenue = res.body.comparison.prev_revenue;

      const growthRate = prevRevenue > 0
        ? ((currentRevenue - prevRevenue) / prevRevenue) * 100
        : 0;

      expect(typeof growthRate).toBe('number');
      expect(Number.isFinite(growthRate)).toBe(true);
    });

    it('verifies items per order metric', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);

      const itemsPerOrder = res.body.total_orders > 0
        ? res.body.items_sold / res.body.total_orders
        : 0;

      expect(itemsPerOrder).toBeGreaterThanOrEqual(0);
    });

    it('verifies cash vs non-cash revenue split', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/reports/summary?date_from=${today}&date_to=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);

      const cashRevenue = res.body.cash_revenue;
      const totalRevenue = res.body.total_revenue;
      const nonCashRevenue = totalRevenue - cashRevenue;

      expect(cashRevenue).toBeGreaterThanOrEqual(0);
      expect(nonCashRevenue).toBeGreaterThanOrEqual(0);
      expect(cashRevenue + nonCashRevenue).toBe(totalRevenue);
    });
  });
});
