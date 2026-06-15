'use strict';

const { Readable } = require('stream');
const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const callLogger = require('../services/call-logger');
const agentConfigs = require('../services/agent-configs');

const UUID_RE = /^[0-9a-f-]{36}$/;

function twilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// GET /api/calls/stats — dashboard summary
router.get('/stats', async (_req, res) => {
  try {
    const stats = await callLogger.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/outbound — initiate an outbound call via Twilio
router.post('/outbound', async (req, res) => {
  const { to, agentConfigId } = req.body;
  if (!to)            return res.status(400).json({ error: 'to is required' });
  if (!agentConfigId) return res.status(400).json({ error: 'agentConfigId is required' });

  const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
  if (!serverUrl) return res.status(500).json({ error: 'SERVER_URL not configured' });

  try {
    const config = await agentConfigs.getById(agentConfigId);
    if (!config) return res.status(404).json({ error: 'Agent config not found' });

    const webhookUrl           = `${serverUrl}/incoming-call?configId=${agentConfigId}`;
    const recordingCallbackUrl = `${serverUrl}/api/calls/recording-status`;
    const statusCallbackUrl    = `${serverUrl}/api/calls/status`;

    const call = await twilioClient().calls.create({
      to,
      from:                         config.twilio_number,
      url:                          webhookUrl,
      record:                       true,
      recordingStatusCallback:      recordingCallbackUrl,
      recordingStatusCallbackEvent: ['completed'],
      statusCallback:               statusCallbackUrl,
      statusCallbackEvent:          ['completed', 'busy', 'no-answer', 'failed', 'canceled'],
      statusCallbackMethod:         'POST',
    });

    // Create DB record immediately — non-answered calls will be finalized via statusCallback
    callLogger.startCall({
      callSid:       call.sid,
      agentConfigId,
      twilioNumber:  config.twilio_number,
      callerNumber:  to,
      direction:     'outbound',
    }).catch((err) => console.error('[outbound] DB record error:', err.message));

    console.log(`[outbound] Initiated ${config.twilio_number} → ${to} (${call.sid})`);
    res.json({ callSid: call.sid, status: call.status });
  } catch (err) {
    console.error('[outbound] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/status — Twilio call status callback (fired for all terminal states)
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
  if (CallSid && TERMINAL.has(CallStatus)) {
    const durationSeconds = CallDuration ? parseInt(CallDuration, 10) : 0;
    await callLogger.finalizeCall(CallSid, { durationSeconds });
    console.log(`[status] ${CallSid} → ${CallStatus} (${durationSeconds}s)`);
  }
  res.sendStatus(204);
});

// POST /api/calls/recording-status — Twilio recording-ready callback
router.post('/recording-status', async (req, res) => {
  const { CallSid, RecordingUrl, RecordingStatus } = req.body;
  if (RecordingStatus === 'completed' && CallSid && RecordingUrl) {
    const url = `${RecordingUrl}.mp3`;
    await callLogger.saveRecordingUrl(CallSid, url);
    console.log(`[recording] Saved for ${CallSid}: ${url}`);
  }
  res.sendStatus(204);
});

// GET /api/calls — list calls (newest first)
router.get('/', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50,  200);
  const offset = parseInt(req.query.offset) || 0;
  const agentConfigId = req.query.agentConfigId || null;
  try {
    const data = await callLogger.listCalls({ agentConfigId, limit, offset });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/:id/recording — proxy Twilio audio with auth so the browser can play it
router.get('/:id/recording', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const call = await callLogger.getCall(req.params.id);
    if (!call?.recording_url) return res.status(404).json({ error: 'No recording available' });

    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const upstream = await fetch(call.recording_url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Recording not available from Twilio' });

    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'audio/mpeg');
    const len = upstream.headers.get('Content-Length');
    if (len) res.setHeader('Content-Length', len);
    res.setHeader('Accept-Ranges', 'bytes');

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
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
