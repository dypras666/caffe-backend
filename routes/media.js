const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
let sharp; try { sharp = require('sharp'); } catch { sharp = null; }
const { param, query, body, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize, can } = require('../middleware/auth');
const storageService = require('../services/StorageService');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_MIME_TYPES.includes(file.mimetype) && ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: jpg, png, gif, webp, pdf'), false);
  }
};

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE }, fileFilter });

const logActivity = async (userId, action, recordId, oldValues, newValues) => {
  await db.query(
    'INSERT INTO activity_logs (user_id, action, table_name, record_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, action, 'media', recordId || null, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null]
  );
};

async function compressToWebp(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (sharp && ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    const webpFilename = `${path.basename(imagePath, ext)}.webp`;
    const webpPath = path.join(path.dirname(imagePath), webpFilename);
    await sharp(imagePath)
      .webp({ quality: 80 })
      .toFile(webpPath);
    fs.unlinkSync(imagePath);
    return { webpPath, webpFilename };
  }
  return { webpPath: imagePath, webpFilename: path.basename(imagePath) };
}

async function processAndSave(filename, tempPath, mimetype) {
  const isImage = mimetype.startsWith('image/') && mimetype !== 'image/gif';
  let finalBuffer;
  let finalFilename;
  let finalMime = mimetype;

  if (isImage) {
    try {
      if (sharp) {
        const webpFilename = `${path.basename(filename, path.extname(filename))}.webp`;
        finalBuffer = await sharp(tempPath).webp({ quality: 80 }).toBuffer();
        finalFilename = webpFilename;
        finalMime = 'image/webp';
      } else { throw new Error('sharp unavailable'); }
    } catch {
      finalBuffer = fs.readFileSync(tempPath);
      finalFilename = filename;
    }
    fs.unlinkSync(tempPath);
  } else {
    finalBuffer = fs.readFileSync(tempPath);
    finalFilename = filename;
    fs.unlinkSync(tempPath);
  }

  const saved = await storageService.save(finalFilename, finalBuffer, finalMime);
  return { ...saved, mime_type: finalMime };
}

// GET / — list files
router.get('/',
  authenticate,
  authorize('admin'),
  [query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 }), query('file_type').optional().trim(), query('search').optional().trim()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;
      const { file_type, search } = req.query;

      let baseQuery = 'FROM media m LEFT JOIN users u ON m.uploaded_by = u.id WHERE 1=1';
      const params = [];
      // Support both schema variants: file_name/file_path/file_type OR filename/url/mime_type
      if (file_type) { baseQuery += ' AND (m.file_type = ? OR m.mime_type LIKE ?)'; params.push(file_type, `${file_type}%`); }
      if (search) { baseQuery += ' AND (COALESCE(m.file_name, m.filename, m.original_name) LIKE ?)'; params.push(`%${search}%`); }

      const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
      const [files] = await db.query(
        `SELECT m.id,
                COALESCE(m.file_name, m.filename, m.original_name) AS file_name,
                COALESCE(m.file_path, m.url) AS file_path,
                COALESCE(m.file_type, SUBSTRING_INDEX(m.mime_type,'/',1)) AS file_type,
                COALESCE(m.file_size, m.size) AS file_size,
                m.mime_type,
                COALESCE(m.storage_type, 'local') AS storage_type,
                COALESCE(m.alt_text, '') AS alt_text,
                m.created_at,
                u.name AS uploaded_by_name,
                COALESCE(m.url, m.file_path) AS url
         ${baseQuery} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const filesWithUrl = await Promise.all(files.map(async f => {
        let finalUrl = f.url;
        if (!finalUrl || !finalUrl.startsWith('http')) {
          finalUrl = await storageService.getFileUrl(f.file_path, f.storage_type).catch(() => f.file_path);
        }
        return { ...f, url: finalUrl };
      }));

      res.json({ files: filesWithUrl, pagination: { total, page, limit, total_pages: Math.ceil(total / limit) } });
    } catch (error) {
      console.error('Get media error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Proxy stream to hide S3 URL
router.get('/f/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const [rows] = await db.query('SELECT * FROM media WHERE file_path = ? OR file_name = ? LIMIT 1', [filename, filename]);
    
    if (!rows.length) {
      return res.status(404).send('File not found');
    }
    
    const f = rows[0];
    const url = f.url || await storageService.getFileUrl(f.file_path, f.storage_type).catch(() => null);
    
    if (!url) return res.status(404).send('File not found');

    if (url.startsWith('http')) {
      const response = await fetch(url);
      if (!response.ok) return res.status(404).send('File not found on storage');
      
      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
      const { Readable } = require('stream');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      // Local file
      const path = require('path');
      res.sendFile(path.join(__dirname, '..', url));
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// POST /upload — single file (backward compat)
router.post('/upload',
  authenticate,
  can('upload', 'media'),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum size is 20MB.' });
        return res.status(400).json({ error: err.message });
      } else if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use the "file" field.' });

      const result = await processAndSave(req.file.filename, req.file.path, req.file.mimetype);
      let fileType = result.storage_type === 's3' || result.mime_type === 'image/webp' ? 'image' : 'image';
      if (req.file.mimetype === 'application/pdf') fileType = 'document';

      const finalMime = result.mime_type || req.file.mimetype;
      const [dbResult] = await db.query(
        'INSERT INTO media (file_name, file_path, file_type, file_size, mime_type, storage_type, uploaded_by, alt_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [req.file.originalname, result.path, fileType, req.file.size, finalMime, result.storage_type, req.user.id, req.body.alt_text || null]
      );

      await logActivity(req.user.id, 'upload_media', dbResult.insertId, null, { file_name: req.file.originalname });

      res.status(201).json({
        message: 'File uploaded successfully',
        file: {
          id: dbResult.insertId,
          file_name: req.file.originalname,
          file_path: result.path,
          file_type: fileType,
          file_size: req.file.size,
          mime_type: finalMime,
          url: result.url,
          storage_type: result.storage_type,
        },
      });
    } catch (error) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error('Upload error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /upload-multiple — multiple files, field: files[]
router.post('/upload-multiple',
  authenticate,
  can('upload', 'media'),
  (req, res, next) => {
    upload.array('files', 20)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum size is 20MB.' });
        if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Too many files. Maximum is 20.' });
        return res.status(400).json({ error: err.message });
      } else if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });

      const results = [];
      for (const file of req.files) {
        try {
          const result = await processAndSave(file.filename, file.path, file.mimetype);
          let fileType = 'image';
          if (file.mimetype === 'application/pdf') fileType = 'document';

          const finalMime = result.mime_type || file.mimetype;
          const [dbResult] = await db.query(
            'INSERT INTO media (file_name, file_path, file_type, file_size, mime_type, storage_type, uploaded_by, alt_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [file.originalname, result.path, fileType, file.size, finalMime, result.storage_type, req.user.id, req.body.alt_text || null]
          );

          results.push({
            id: dbResult.insertId,
            file_name: file.originalname,
            file_path: result.path,
            file_type: fileType,
            file_size: file.size,
            mime_type: finalMime,
            url: result.url,
            storage_type: result.storage_type,
          });
        } catch (err) {
          fs.unlink(file.path, () => {});
          console.error('File processing error:', err.message);
        }
      }

      res.status(201).json({ message: `${results.length} file(s) uploaded`, files: results });
    } catch (error) {
      console.error('Multiple upload error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /:id
router.delete('/:id',
  authenticate,
  authorize('admin'),
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const [rows] = await db.query('SELECT id, file_name, file_path, storage_type FROM media WHERE id = ?', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Media file not found' });

      await db.query('DELETE FROM media WHERE id = ?', [req.params.id]);
      await storageService.delete(rows[0].file_path, rows[0].storage_type);
      await logActivity(req.user.id, 'delete_media', req.params.id, rows[0], null);

      res.json({ message: 'Media file deleted successfully' });
    } catch (error) {
      console.error('Delete media error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
module.exports.upload = upload;
