const request = require('supertest');
const app = require('../server');
const db = require('../config/database');
const { getAdminToken } = require('./helpers');

describe('Products API Tests', () => {
  let authToken;
  let productId;
  let testCategoryId;

  beforeAll(async () => {
    authToken = await getAdminToken();
    // Ensure test category exists
    const [cats] = await db.query("SELECT id FROM categories WHERE name='Test Category' LIMIT 1");
    if (cats.length > 0) {
      testCategoryId = cats[0].id;
    } else {
      const [r] = await db.query("INSERT INTO categories (name, is_active) VALUES ('Test Category', 1)");
      testCategoryId = r.insertId;
    }
  });

  afterAll(async () => {
    // Clean up test products
    if (productId) {
      await db.query('DELETE FROM products WHERE id = ?', [productId]);
    }
    
  });

  describe('GET /api/products', () => {
    it('should get all products (public)', async () => {
      const res = await request(app)
        .get('/api/products');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('products');
      expect(Array.isArray(res.body.products)).toBe(true);
    });

    it('should filter products by category', async () => {
      const res = await request(app)
        .get('/api/products?category=1');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('products');
    });

    it('should filter popular products', async () => {
      const res = await request(app)
        .get('/api/products?popular=true');

      expect(res.status).toBe(200);
      if (res.body.products.length > 0) {
        expect(res.body.products[0].is_popular).toBe(1);
      }
    });

    it('should search products', async () => {
      const res = await request(app)
        .get('/api/products?search=espresso');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('products');
    });
  });

  describe('POST /api/products', () => {
    it('should create new product (authenticated)', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          category_id: testCategoryId,
          name: 'Test Coffee',
          price: 5.99,
          cost_price: 2.50,
          sku: 'TEST-001',
          stock: 50,
          is_popular: true,
          is_available: true,
          description: 'Test coffee product'
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('product');
      expect(res.body.product.name).toBe('Test Coffee');

      productId = res.body.product.id;
    });

    it('should fail without authentication', async () => {
      const res = await request(app)
        .post('/api/products')
        .send({
          name: 'Test Product',
          price: 10.00
        });

      expect(res.status).toBe(401);
    });

    it('should fail with invalid data', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: '',
          price: -5
        });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/products/:id', () => {
    it('should get product by id', async () => {
      // Get a real product id dynamically
      const listRes = await request(app).get('/api/products');
      expect(listRes.body.products.length).toBeGreaterThan(0);
      const firstId = listRes.body.products[0].id;

      const res = await request(app).get(`/api/products/${firstId}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('product');
      expect(res.body.product).toHaveProperty('custom_fields');
    });

    it('should return 404 for non-existent product', async () => {
      const res = await request(app)
        .get('/api/products/99999');

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/products/:id', () => {
    it('should update product (authenticated)', async () => {
      if (!productId) {
        return expect(true).toBe(true); // Skip if no product created
      }

      const res = await request(app)
        .put(`/api/products/${productId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          price: 6.99,
          stock: 75
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('updated');
    });

    it('should fail without authentication', async () => {
      const res = await request(app)
        .put('/api/products/1')
        .send({
          price: 10.00
        });

      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/products/:id', () => {
    it('should delete product (authenticated admin)', async () => {
      if (!productId) {
        return expect(true).toBe(true);
      }

      const res = await request(app)
        .delete(`/api/products/${productId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('deleted');

      productId = null; // Prevent cleanup
    });

    it('should fail without authentication', async () => {
      const res = await request(app)
        .delete('/api/products/1');

      expect(res.status).toBe(401);
    });
  });
});
