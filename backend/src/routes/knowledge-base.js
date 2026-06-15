'use strict';

const { Router } = require('express');
const multer     = require('multer');
const kb         = require('../services/knowledge-base');

const router  = Router();
const upload  = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter(_req, file, cb) {
    const allowed = ['application/pdf', 'text/plain', 'text/markdown'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PDF and plain text files are supported'));
  },
});

// GET /api/knowledge-base?agentConfigId=
router.get('/', async (req, res) => {
  try {
    const docs = await kb.listDocuments(req.query.agentConfigId || null);
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge-base/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await kb.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-base/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { agentConfigId } = req.body;
    if (!agentConfigId) return res.status(400).json({ error: 'agentConfigId is required' });

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // Upload file to Supabase Storage
    const filePath = await kb.uploadToStorage(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );

    // Insert document record
    const { data: doc, error: insertErr } = await supabase
      .from('documents')
      .insert({
        filename:        req.file.originalname,
        agent_config_id: agentConfigId,
        file_path:       filePath,
        file_type:       req.file.mimetype,
        file_size:       req.file.size,
        status:          'processing',
      })
      .select()
      .single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    // Kick off async ingestion pipeline (extract → chunk → embed)
    kb.processDocument(doc.id).catch((err) => {
      console.error('[knowledge-base route] processDocument error:', err.message);
    });

    res.status(201).json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/knowledge-base/:id
router.delete('/:id', async (req, res) => {
  try {
    await kb.deleteDocument(req.params.id);
    res.status(204).end();
  } catch (err) {
    const status = err.message === 'Document not found' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Multer error handler (file type / size rejections)
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (20 MB max)' });
  }
  res.status(400).json({ error: err.message });
});

module.exports = router;
