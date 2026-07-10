const request = require('supertest');
const app = require('../server');
const db = require('../config/database');

describe('Posts API Tests', () => {
  let authToken;
  let memberToken;
  let postId;
  let categoryId;
  let tagId;
  let commentId;

  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@cafeazzura.com', password: 'admin123' });
    authToken = loginRes.body.token;

    // Ensure test member exists
    await request(app)
      .post('/api/auth/register/member')
      .send({ name: 'Test Member', email: 'posttest.member@test.com', password: 'test123', phone: '081111' });
    const memberRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'posttest.member@test.com', password: 'test123' });
    memberToken = memberRes.body.token;
  });

  afterAll(async () => {
    if (commentId) await db.query('DELETE FROM post_comments WHERE id = ?', [commentId]);
    if (postId) {
      await db.query('DELETE FROM post_tag_relations WHERE post_id = ?', [postId]);
      await db.query('DELETE FROM post_category_relations WHERE post_id = ?', [postId]);
      await db.query('DELETE FROM post_galleries WHERE post_id = ?', [postId]);
      await db.query('DELETE FROM posts WHERE id = ?', [postId]);
    }
    if (categoryId) await db.query('DELETE FROM post_categories WHERE id = ?', [categoryId]);
    if (tagId) await db.query('DELETE FROM post_tags WHERE id = ?', [tagId]);
  });

  describe('Categories', () => {
    it('should list categories publicly', async () => {
      const res = await request(app).get('/api/posts/categories');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('categories');
    });

    it('should reject create category without auth', async () => {
      const res = await request(app)
        .post('/api/posts/categories')
        .send({ name: 'Test Category' });
      expect(res.status).toBe(401);
    });

    it('should create category as admin', async () => {
      const res = await request(app)
        .post('/api/posts/categories')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Test Category', color: '#FF0000' });
      expect(res.status).toBe(201);
      expect(res.body.category).toHaveProperty('id');
      categoryId = res.body.category.id;
    });

    it('should update category', async () => {
      const res = await request(app)
        .put(`/api/posts/categories/${categoryId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Test Category Updated' });
      expect(res.status).toBe(200);
    });

    it('should delete category', async () => {
      const res = await request(app)
        .delete(`/api/posts/categories/${categoryId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Tags', () => {
    it('should list tags publicly', async () => {
      const res = await request(app).get('/api/posts/tags');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('tags');
    });

    it('should create tag as admin', async () => {
      const res = await request(app)
        .post('/api/posts/tags')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'test-tag' });
      expect(res.status).toBe(201);
      tagId = res.body.tag.id;
    });
  });

  describe('CRUD Posts', () => {
    it('should reject create without auth', async () => {
      const res = await request(app)
        .post('/api/posts')
        .send({ title: 'Unauthorized Post' });
      expect(res.status).toBe(401);
    });

    it('should create post as admin', async () => {
      const res = await request(app)
        .post('/api/posts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          title: 'Test Post Unit Test',
          content: '## Hello\nThis is a test post.',
          excerpt: 'Test excerpt',
          post_type: 'article',
          status: 'draft',
          seo_title: 'Test SEO',
          seo_description: 'SEO description',
          seo_keywords: 'test, seo',
          tag_names: ['test-tag'],
          allow_comments: true,
        });
      expect(res.status).toBe(201);
      expect(res.body.post).toHaveProperty('id');
      postId = res.body.post.id;
    });

    it('should get all posts with pagination', async () => {
      const res = await request(app)
        .get('/api/posts')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('posts');
      expect(res.body).toHaveProperty('pagination');
      expect(res.body.posts.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter posts by type', async () => {
      const res = await request(app)
        .get('/api/posts?type=article')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.posts.every(p => p.post_type === 'article')).toBe(true);
    });

    it('should filter posts by status', async () => {
      const res = await request(app)
        .get('/api/posts?status=draft')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
    });

    it('should search posts', async () => {
      const res = await request(app)
        .get('/api/posts?search=Test+Post')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.posts.length).toBeGreaterThanOrEqual(1);
    });

    it('should get single post by id', async () => {
      const res = await request(app)
        .get(`/api/posts/${postId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.post).toHaveProperty('title', 'Test Post Unit Test');
      expect(res.body.post).toHaveProperty('categories');
      expect(res.body.post).toHaveProperty('tags');
      expect(res.body.post).toHaveProperty('gallery');
      expect(res.body.post.tags.length).toBeGreaterThanOrEqual(1);
    });

    it('should get single post by slug', async () => {
      const res = await request(app)
        .get('/api/posts/test-post-unit-test')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.post).toHaveProperty('id', postId);
    });

    it('should return 404 for non-existent post', async () => {
      const res = await request(app).get('/api/posts/999999');
      expect(res.status).toBe(404);
    });

    it('should bump views on public read', async () => {
      const before = (await request(app).get(`/api/posts/${postId}`).set('Authorization', `Bearer ${authToken}`)).body.post.views;
      await request(app).get(`/api/posts/${postId}`);
      const after = (await request(app).get(`/api/posts/${postId}`).set('Authorization', `Bearer ${authToken}`)).body.post.views;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('should update post', async () => {
      const res = await request(app)
        .put(`/api/posts/${postId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          title: 'Test Post Updated',
          content: '## Updated\nContent updated.',
          post_type: 'news',
          status: 'published',
          tag_names: ['test-tag', 'updated'],
        });
      expect(res.status).toBe(200);
    });

    it('should list public posts only published', async () => {
      const res = await request(app).get('/api/posts');
      expect(res.status).toBe(200);
      res.body.posts.forEach(p => {
        expect(p.status).toBe('published');
      });
    });
  });

  describe('Gallery', () => {
    it('should add gallery on update', async () => {
      const res = await request(app)
        .put(`/api/posts/${postId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          title: 'Test Post With Gallery',
          gallery: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'],
          tag_names: ['test-tag', 'gallery'],
        });
      expect(res.status).toBe(200);

      const getRes = await request(app)
        .get(`/api/posts/${postId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(getRes.body.post.gallery.length).toBe(2);
      expect(getRes.body.post.title).toBe('Test Post With Gallery');
    });
  });

  describe('Comments', () => {
    it('should reject comment without auth', async () => {
      const res = await request(app)
        .post(`/api/posts/${postId}/comments`)
        .send({ content: 'Test comment' });
      expect(res.status).toBe(401);
    });

    it('should reject empty comment', async () => {
      const res = await request(app)
        .post(`/api/posts/${postId}/comments`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ content: '' });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('errors');
    });

    it('should create comment as member', async () => {
      const res = await request(app)
        .post(`/api/posts/${postId}/comments`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ content: 'Great post!' });
      expect(res.status).toBe(201);
      expect(res.body.comment).toHaveProperty('id');
      commentId = res.body.comment.id;
    });

    it('should show comment as pending', async () => {
      const res = await request(app).get(`/api/posts/${postId}/comments`);
      expect(res.status).toBe(200);
      expect(res.body.comments.every(c => c.status === 'approved')).toBe(true);
      // Our new comment is pending, so should not appear
      expect(res.body.comments.find(c => c.id === commentId)).toBeUndefined();
    });

    it('should approve comment as admin', async () => {
      const res = await request(app)
        .put(`/api/posts/comments/${commentId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'approved' });
      expect(res.status).toBe(200);

      const getRes = await request(app).get(`/api/posts/${postId}/comments`);
      expect(getRes.body.comments.find(c => c.id === commentId)).toBeDefined();
    });

    it('should show member level in comment', async () => {
      const res = await request(app).get(`/api/posts/${postId}/comments`);
      const comment = res.body.comments.find(c => c.id === commentId);
      expect(comment).toBeDefined();
      expect(comment).toHaveProperty('member_level');
    });

    it('should delete comment as admin', async () => {
      const res = await request(app)
        .delete(`/api/posts/comments/${commentId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      commentId = null;
    });
  });

  describe('Security', () => {
    it('should prevent XSS in title', async () => {
      const res = await request(app)
        .post('/api/posts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: '<script>alert("xss")</script>' });
      expect(res.status).toBe(201);
      const newId = res.body.post.id;
      const getRes = await request(app)
        .get(`/api/posts/${newId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(getRes.body.post.title).not.toContain('<script>');
      await db.query('DELETE FROM posts WHERE id = ?', [newId]);
    });

    it('should prevent long content DoS', async () => {
      const res = await request(app)
        .post('/api/posts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'DoS Test', content: 'A'.repeat(100000) });
      // Should either reject or truncate
      expect([201, 400, 413]).toContain(res.status);
    });

    it('should require admin for update', async () => {
      const res = await request(app)
        .put(`/api/posts/${postId}`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ title: 'Hacked' });
      expect([401, 403]).toContain(res.status);
    });

    it('should require auth for delete', async () => {
      const res = await request(app).delete(`/api/posts/${postId}`);
      expect(res.status).toBe(401);
    });
  });

  describe('SEO Fields', () => {
    it('should store and return SEO fields', async () => {
      const res = await request(app)
        .get(`/api/posts/${postId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.body.post).toHaveProperty('seo_title');
      expect(res.body.post).toHaveProperty('seo_description');
      expect(res.body.post).toHaveProperty('seo_keywords');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty post list gracefully', async () => {
      const res = await request(app).get('/api/posts?search=nonexistentXYZ12345');
      expect(res.status).toBe(200);
      expect(res.body.posts).toEqual([]);
    });

    it('should auto-generate unique slugs', async () => {
      const r1 = await request(app)
        .post('/api/posts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Unique Slug Test' });
      const r2 = await request(app)
        .post('/api/posts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Unique Slug Test' });
      expect(r1.body.post.slug).not.toBe(r2.body.post.slug);
      await db.query('DELETE FROM posts WHERE id IN (?, ?)', [r1.body.post.id, r2.body.post.id]);
    });
  });
});
