'use strict';

const express = require('express');
const multer = require('multer');
const { processDocument } = require('../document-processor');
const knowledgeBase = require('../services/knowledge-base');

const router = express.Router();

// Memory storage — file content available as req.file.buffer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
    ];
    const ext = file.originalname.split('.').pop().toLowerCase();
    const allowedExts = ['pdf', 'docx', 'txt', 'md'];

    if (allowed.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Upload PDF, DOCX, TXT, or MD files.'));
    }
  },
});

// GET /api/documents — list all documents with chunk counts
router.get('/', async (_req, res) => {
  try {
    const docs = await knowledgeBase.listDocuments();
    res.json(docs);
  } catch (err) {
    console.error('[documents] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents — upload and process a document
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    const result = await processDocument(req.file);
    res.status(201).json({
      documentId: result.documentId,
      chunkCount: result.chunkCount,
      filename: req.file.originalname,
    });
  } catch (err) {
    console.error('[documents] Upload error:', err.message);
    res.status(422).json({ error: err.message });
  }
});

// DELETE /api/documents/:id — delete a document and its chunks
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  // Basic UUID validation
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid document ID' });
  }
  try {
    await knowledgeBase.deleteDocument(id);
    res.status(204).send();
  } catch (err) {
    console.error('[documents] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Multer error handler
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 10 MB)' });
  }
  res.status(400).json({ error: err.message });
});

module.exports = router;
