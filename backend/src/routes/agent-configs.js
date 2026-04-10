'use strict';

const express = require('express');
const router = express.Router();
const agentConfigs = require('../services/agent-configs');

const UUID_RE = /^[0-9a-f-]{36}$/;

// GET /api/agent-configs — list all configs with stats
router.get('/', async (_req, res) => {
  try {
    const data = await agentConfigs.list();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agent-configs/:id
router.get('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const data = await agentConfigs.getById(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// POST /api/agent-configs — create
router.post('/', async (req, res) => {
  const { name, twilio_number, quo_number, system_prompt, voice_id, greeting, is_active } = req.body;
  if (!name || !twilio_number || !system_prompt) {
    return res.status(400).json({ error: 'name, twilio_number, and system_prompt are required' });
  }
  try {
    const data = await agentConfigs.create({
      name,
      twilio_number,
      quo_number: quo_number || null,
      system_prompt,
      voice_id: voice_id || process.env.ELEVENLABS_VOICE_ID,
      greeting: greeting || 'Hello! Thanks for calling. How can I help you today?',
      is_active: is_active !== false,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// PATCH /api/agent-configs/:id — update
router.patch('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const allowed = ['name', 'twilio_number', 'quo_number', 'system_prompt', 'voice_id', 'greeting', 'is_active'];
  const fields = {};
  for (const key of allowed) {
    if (key in req.body) fields[key] = req.body[key];
  }
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  try {
    const data = await agentConfigs.update(req.params.id, fields);
    res.json(data);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// DELETE /api/agent-configs/:id
router.delete('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    await agentConfigs.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
