'use strict';

const express = require('express');
const router = express.Router();
const callLogger = require('../services/call-logger');

const UUID_RE = /^[0-9a-f-]{36}$/;

// GET /api/calls/stats — dashboard summary
router.get('/stats', async (_req, res) => {
  try {
    const stats = await callLogger.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls — list calls (newest first)
// Query params: agentConfigId, limit, offset
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const agentConfigId = req.query.agentConfigId || null;
  try {
    const data = await callLogger.listCalls({ agentConfigId, limit, offset });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/:id — single call with full transcript
router.get('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const data = await callLogger.getCall(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
