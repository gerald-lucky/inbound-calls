'use strict';

const express   = require('express');
const multer    = require('multer');
const mammoth   = require('mammoth');
const Anthropic = require('@anthropic-ai/sdk');
const router    = express.Router();
const knowledge = require('../services/knowledge');
const { PSA_SYSTEM_PROMPT } = require('../services/psa-persona');

const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Documents ─────────────────────────────────────────────────────────────────

router.get('/documents', async (req, res) => {
  try {
    res.json(await knowledge.listDocuments());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/documents/:id', async (req, res) => {
  try {
    await knowledge.deleteDocument(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ingestion (JSON — plain text/markdown paste) ──────────────────────────────

router.post('/ingest', async (req, res) => {
  try {
    const { filename, content } = req.body;
    if (!filename || !content) {
      return res.status(400).json({ error: 'filename and content are required' });
    }
    res.json(await knowledge.ingestDocument(filename.trim(), content));
  } catch (err) {
    console.error('[knowledge/ingest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Ingestion (file upload — .txt, .md, .docx) ───────────────────────────────

router.post('/ingest-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const { originalname, buffer, mimetype } = req.file;

    const isDocx = mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                || originalname.toLowerCase().endsWith('.docx');

    let text = '';
    if (isDocx) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      text = buffer.toString('utf-8');
    }

    if (!text.trim()) return res.status(400).json({ error: 'No readable text found in file.' });

    res.json(await knowledge.ingestDocument(originalname, text));
  } catch (err) {
    console.error('[knowledge/ingest-file]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────
// Body: { messages: [{role: 'user'|'assistant', content: string}] }
// Returns: { response: string, sources: [{content, similarity}] }

router.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return res.status(400).json({ error: 'No user message found.' });

    // Search knowledge base for relevant context
    let knowledgeBlock = '';
    let sources        = [];
    try {
      const chunks = await knowledge.searchKnowledge(lastUser.content, 5);
      if (chunks.length) {
        knowledgeBlock =
          '\n\n## Relevant policy / SOP context (use this to answer the question)\n' +
          chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n---\n\n');
        sources = chunks.map(c => ({ content: c.content.slice(0, 120) + '…', similarity: Number(c.similarity).toFixed(2) }));
      }
    } catch (kErr) {
      // Knowledge search may fail if OPENAI_API_KEY is not yet set — degrade gracefully
      console.warn('[knowledge/chat] search unavailable:', kErr.message);
    }

    const systemPrompt =
      PSA_SYSTEM_PROMPT +
      '\n\nYou are currently in the Lucky Communities Knowledge Base chat interface. ' +
      'The team is testing your knowledge and reviewing how you answer policy questions. ' +
      'Respond as Britney, the Property Support Agent. ' +
      'You may give slightly more detailed answers here than on a phone call since the reader is a staff member reviewing accuracy.' +
      knowledgeBlock;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   messages.map(m => ({ role: m.role, content: m.content })),
    });

    res.json({ response: response.content[0]?.text || '', sources });
  } catch (err) {
    console.error('[knowledge/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
