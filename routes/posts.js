const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize, can, optionalAuth } = require('../middleware/auth');
const { sanitizeInput } = require('../middleware/security');

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'post';
}

async function generateUniqueSlug(title, excludeId) {
  let slug = slugify(title);
  let counter = 0;
  let exists = true;
  while (exists) {
    const testSlug = counter === 0 ? slug : `${slug}-${counter}`;
    const [rows] = excludeId
      ? await db.query('SELECT id FROM posts WHERE slug = ? AND id != ?', [testSlug, excludeId])
      : await db.query('SELECT id FROM posts WHERE slug = ?', [testSlug]);
    if (rows.length === 0) return testSlug;
    counter++;
  }
}

// GET / — List posts with filters
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { type, status, category, tag, search, sort, page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit) || 10, 50);
    const offset = (pageNum - 1) * limitNum;

    let joins = '';
    let where = ['1=1'];
    const params = [];

    // Public: only published
    if (!req.user || req.user.role === 'member') {
      where.push('p.status = ?');
      params.push('published');
    } else if (status && status !== 'all') {
      where.push('p.status = ?');
      params.push(status);
    }

    if (type && type !== 'all') { where.push('p.post_type = ?'); params.push(type); }
    if (category) { joins += ' JOIN post_category_relations pcr ON p.id = pcr.post_id'; where.push('pcr.category_id = ?'); params.push(category); }
    if (tag) { joins += ' JOIN post_tag_relations ptr ON p.id = ptr.post_id'; where.push('ptr.tag_id = ?'); params.push(tag); }
    if (search) { where.push('(p.title LIKE ? OR p.excerpt LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

    const orderClause = sort === 'oldest' ? 'p.created_at ASC' :
      sort === 'popular' ? 'p.views DESC' :
      'p.created_at DESC';

    const [[{ total }]] = await db.query(
      `SELECT COUNT(DISTINCT p.id) AS total FROM posts p${joins} WHERE ${where.join(' AND ')}`, params
    );

    const [posts] = await db.query(
      `SELECT p.*, u1.name AS created_by_name, u2.name AS updated_by_name
       FROM posts p
       LEFT JOIN users u1 ON p.created_by = u1.id
       LEFT JOIN users u2 ON p.updated_by = u2.id${joins}
       WHERE ${where.join(' AND ')}
       GROUP BY p.id ORDER BY ${orderClause} LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    // Attach categories, tags, gallery for each post
    for (const post of posts) {
      const [cats] = await db.query(
        'SELECT pc.* FROM post_categories pc JOIN post_category_relations pcr ON pc.id = pcr.category_id WHERE pcr.post_id = ?',
        [post.id]
      );
      post.categories = cats;

      const [tags] = await db.query(
        'SELECT pt.* FROM post_tags pt JOIN post_tag_relations ptr ON pt.id = ptr.tag_id WHERE ptr.post_id = ?',
        [post.id]
      );
      post.tags = tags;

      const [gallery] = await db.query(
        'SELECT * FROM post_galleries WHERE post_id = ? ORDER BY sort_order',
        [post.id]
      );
      post.gallery = gallery;
    }

    res.json({ posts, pagination: { total, page: pageNum, limit: limitNum, total_pages: Math.ceil(total / limitNum) } });
  } catch (error) {
    console.error('Get posts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /categories — list post categories
router.get('/categories', async (req, res) => {
  try {
    const [categories] = await db.query(
      'SELECT pc.*, (SELECT COUNT(*) FROM post_category_relations WHERE category_id = pc.id) AS post_count FROM post_categories pc ORDER BY pc.display_order, pc.name'
    );
    res.json({ categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /categories
router.post('/categories',
  authenticate, authorize('admin'),
  body('name').trim().notEmpty(),
  async (req, res) => {
    try {
      const { name, description, color, parent_id, display_order } = req.body;
      const slug = slugify(name);
      const [{ insertId }] = await db.query(
        'INSERT INTO post_categories (name, slug, description, color, parent_id, display_order) VALUES (?, ?, ?, ?, ?, ?)',
        [name, slug, description || null, color || '#6F4E37', parent_id || null, display_order || 0]
      );
      res.status(201).json({ message: 'Category created', category: { id: insertId, name, slug } });
    } catch (error) {
      console.error('Create category error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /categories/:id
router.put('/categories/:id',
  authenticate, authorize('admin'),
  param('id').isInt(),
  body('name').trim().notEmpty(),
  async (req, res) => {
    try {
      const { name, description, color, parent_id, display_order } = req.body;
      const slug = slugify(name);
      await db.query(
        'UPDATE post_categories SET name=?, slug=?, description=?, color=?, parent_id=?, display_order=? WHERE id=?',
        [name, slug, description || null, color || '#6F4E37', parent_id || null, display_order || 0, req.params.id]
      );
      res.json({ message: 'Category updated' });
    } catch (error) {
      console.error('Update category error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /categories/:id
router.delete('/categories/:id',
  authenticate, authorize('admin'),
  param('id').isInt(),
  async (req, res) => {
    try {
      await db.query('DELETE FROM post_categories WHERE id = ?', [req.params.id]);
      res.json({ message: 'Category deleted' });
    } catch (error) {
      console.error('Delete category error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /tags — list tags
router.get('/tags', async (req, res) => {
  try {
    const [tags] = await db.query(
      'SELECT pt.*, (SELECT COUNT(*) FROM post_tag_relations WHERE tag_id = pt.id) AS post_count FROM post_tags pt ORDER BY pt.name'
    );
    res.json({ tags });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /tags
router.post('/tags',
  authenticate, authorize('admin'),
  body('name').trim().notEmpty(),
  async (req, res) => {
    try {
      const name = req.body.name.trim();
      const slug = slugify(name);
      const [{ insertId }] = await db.query(
        'INSERT INTO post_tags (name, slug) VALUES (?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name)',
        [name, slug]
      );
      res.status(201).json({ message: 'Tag created', tag: { id: insertId, name, slug } });
    } catch (error) {
      console.error('Create tag error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /tags/:id
router.delete('/tags/:id',
  authenticate, authorize('admin'),
  param('id').isInt(),
  async (req, res) => {
    try {
      await db.query('DELETE FROM post_tags WHERE id = ?', [req.params.id]);
      res.json({ message: 'Tag deleted' });
    } catch (error) {
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /:id — single post
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const isSlug = isNaN(id) || req.params.id.includes('-');

    let post;
    if (isSlug) {
      [[post]] = await db.query(
        `SELECT p.*, u1.name AS created_by_name, u2.name AS updated_by_name
         FROM posts p LEFT JOIN users u1 ON p.created_by = u1.id LEFT JOIN users u2 ON p.updated_by = u2.id
         WHERE p.slug = ?`, [req.params.id]
      );
    } else {
      [[post]] = await db.query(
        `SELECT p.*, u1.name AS created_by_name, u2.name AS updated_by_name
         FROM posts p LEFT JOIN users u1 ON p.created_by = u1.id LEFT JOIN users u2 ON p.updated_by = u2.id
         WHERE p.id = ?`, [id]
      );
    }

    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Bump views (once per session)
    if (!req.user || req.user.role === 'member') {
      await db.query('UPDATE posts SET views = views + 1 WHERE id = ?', [post.id]);
      post.views = (post.views || 0) + 1;
    }

    const [cats] = await db.query(
      'SELECT pc.* FROM post_categories pc JOIN post_category_relations pcr ON pc.id = pcr.category_id WHERE pcr.post_id = ?',
      [post.id]
    );
    post.categories = cats;

    const [tags] = await db.query(
      'SELECT pt.* FROM post_tags pt JOIN post_tag_relations ptr ON pt.id = ptr.tag_id WHERE ptr.post_id = ?',
      [post.id]
    );
    post.tags = tags;

    const [gallery] = await db.query(
      'SELECT * FROM post_galleries WHERE post_id = ? ORDER BY sort_order', [post.id]
    );
    post.gallery = gallery;

    res.json({ post });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / — create post
router.post('/',
  authenticate, authorize('admin'),
  sanitizeInput,
  body('title').trim().notEmpty(),
  async (req, res) => {
    try {
      const {
        title, content, excerpt, post_type, cover_image,
        status, seo_title, seo_description, seo_keywords,
        allow_comments, category_ids, tag_names, gallery
      } = req.body;

      const slug = await generateUniqueSlug(title);

      const [{ insertId }] = await db.query(
        `INSERT INTO posts (title, slug, content, excerpt, post_type, cover_image, status, seo_title, seo_description, seo_keywords, allow_comments, created_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, slug, content || null, excerpt || null, post_type || 'article',
         cover_image || null, status || 'draft',
         seo_title || null, seo_description || null, seo_keywords || null,
         allow_comments !== undefined ? (allow_comments ? 1 : 0) : 1,
         req.user.id,
         status === 'published' ? new Date() : null]
      );

      // Categories
      if (Array.isArray(category_ids) && category_ids.length > 0) {
        const vals = category_ids.map(cid => [insertId, cid]);
        await db.query('INSERT INTO post_category_relations (post_id, category_id) VALUES ?', [vals]);
      }

      // Tags
      if (Array.isArray(tag_names) && tag_names.length > 0) {
        for (const name of tag_names) {
          const tSlug = slugify(name);
          await db.query('INSERT INTO post_tags (name, slug) VALUES (?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [name, tSlug]);
          await db.query(
            'INSERT INTO post_tag_relations (post_id, tag_id) SELECT ?, id FROM post_tags WHERE slug = ?',
            [insertId, tSlug]
          );
        }
      }

      // Gallery
      if (Array.isArray(gallery) && gallery.length > 0) {
        const gVals = gallery.map((url, i) => [insertId, url, i]);
        await db.query('INSERT INTO post_galleries (post_id, image_url, sort_order) VALUES ?', [gVals]);
      }

      res.status(201).json({ message: 'Post created', post: { id: insertId, slug } });
    } catch (error) {
      console.error('Create post error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /:id — update post
router.put('/:id',
  authenticate, authorize('admin'),
  param('id').isInt(),
  body('title').trim().notEmpty(),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        title, content, excerpt, post_type, cover_image,
        status, seo_title, seo_description, seo_keywords,
        allow_comments, category_ids, tag_names, gallery
      } = req.body;

      const slug = await generateUniqueSlug(title, id);

      await db.query(
        `UPDATE posts SET title=?, slug=?, content=?, excerpt=?, post_type=?, cover_image=?,
         status=?, seo_title=?, seo_description=?, seo_keywords=?, allow_comments=?, updated_by=?,
         published_at = IF(? = 'published' AND published_at IS NULL, NOW(), published_at)
         WHERE id=?`,
        [title, slug, content, excerpt, post_type || 'article',
         cover_image, status || 'draft',
         seo_title, seo_description, seo_keywords,
         allow_comments !== undefined ? (allow_comments ? 1 : 0) : 1,
         req.user.id, status, id]
      );

      // Update categories
      await db.query('DELETE FROM post_category_relations WHERE post_id = ?', [id]);
      if (Array.isArray(category_ids) && category_ids.length > 0) {
        const vals = category_ids.map(cid => [id, cid]);
        await db.query('INSERT INTO post_category_relations (post_id, category_id) VALUES ?', [vals]);
      }

      // Update tags
      await db.query('DELETE FROM post_tag_relations WHERE post_id = ?', [id]);
      if (Array.isArray(tag_names) && tag_names.length > 0) {
        for (const name of tag_names) {
          const tSlug = slugify(name);
          await db.query('INSERT INTO post_tags (name, slug) VALUES (?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [name, tSlug]);
          await db.query(
            'INSERT INTO post_tag_relations (post_id, tag_id) SELECT ?, id FROM post_tags WHERE slug = ?',
            [id, tSlug]
          );
        }
      }

      // Update gallery
      await db.query('DELETE FROM post_galleries WHERE post_id = ?', [id]);
      if (Array.isArray(gallery) && gallery.length > 0) {
        const gVals = gallery.map((url, i) => [id, url, i]);
        await db.query('INSERT INTO post_galleries (post_id, image_url, sort_order) VALUES ?', [gVals]);
      }

      res.json({ message: 'Post updated', post: { id, slug } });
    } catch (error) {
      console.error('Update post error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /:id
router.delete('/:id',
  authenticate, authorize('admin'),
  param('id').isInt(),
  async (req, res) => {
    try {
      await db.query('DELETE FROM posts WHERE id = ?', [req.params.id]);
      res.json({ message: 'Post deleted' });
    } catch (error) {
      console.error('Delete post error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── Comments ──────────────────────────────────────────────

// GET /:id/comments
router.get('/:id/comments', async (req, res) => {
  try {
    const [comments] = await db.query(
      `SELECT c.*, u.name AS user_name, u.avatar, u.member_level, u.role
       FROM post_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.post_id = ? AND c.status = 'approved'
       ORDER BY c.created_at DESC`,
      [req.params.id]
    );
    res.json({ comments });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/comments — member only
router.post('/:id/comments',
  authenticate,
  body('content').trim().notEmpty().isLength({ min: 1, max: 2000 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const user = req.user;
      if (user.role !== 'member') {
        return res.status(403).json({ error: 'Only members can comment' });
      }

      const { content, parent_id } = req.body;
      const [{ insertId }] = await db.query(
        'INSERT INTO post_comments (post_id, user_id, parent_id, content, status) VALUES (?, ?, ?, ?, ?)',
        [req.params.id, user.id, parent_id || null, content.trim(), 'pending']
      );

      res.status(201).json({ message: 'Comment submitted for approval', comment: { id: insertId } });
    } catch (error) {
      console.error('Create comment error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /comments/:id — approve/reject (admin)
router.put('/comments/:id',
  authenticate, authorize('admin'),
  body('status').isIn(['approved', 'rejected']),
  async (req, res) => {
    try {
      await db.query('UPDATE post_comments SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
      res.json({ message: `Comment ${req.body.status}` });
    } catch (error) {
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /comments/:id
router.delete('/comments/:id',
  authenticate, authorize('admin'),
  async (req, res) => {
    try {
      await db.query('DELETE FROM post_comments WHERE id = ?', [req.params.id]);
      res.json({ message: 'Comment deleted' });
    } catch (error) {
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
