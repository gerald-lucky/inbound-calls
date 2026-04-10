'use strict';

const express = require('express');
const router = express.Router();
const callLogger = require('../services/call-logger');

const UUID_RE = /^[0-9a-f-]{36}$/;

// GET /api/leads — list leads
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const agentConfigId = req.query.agentConfigId || null;
  try {
    const data = await callLogger.listLeads({ agentConfigId, limit, offset });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id
router.delete('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    await callLogger.deleteLead(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
