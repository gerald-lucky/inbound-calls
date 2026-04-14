'use strict';

const express = require('express');
const router = express.Router();
const agentConfigs = require('../services/agent-configs');

// POST /incoming-call — Twilio webhook for every inbound call.
// Returns TwiML that opens a Media Stream WebSocket, passing call
// metadata as <Parameter> elements (no query string needed).
router.post('/', async (req, res) => {
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl) {
    console.error('[incoming-call] SERVER_URL is not set');
    return res.status(500).send('Server misconfigured');
  }

  const callSid   = req.body.CallSid || '';
  const callerNum = req.body.From    || 'unknown';
  const twilioNum = req.body.To      || '';

  console.log(`[incoming-call] ${callerNum} → ${twilioNum} (${callSid})`);

  const config = await agentConfigs.findByTwilioNumber(twilioNum);
  if (config) {
    console.log(`[incoming-call] Using agent config: "${config.name}" (${config.id})`);
  } else {
    console.log('[incoming-call] No agent config found — will use env-var defaults');
  }

  const base  = serverUrl.replace(/\/$/, '');
  const wsUrl = base.replace(/^https?/, 'wss') + '/media-stream';
  console.log(`[incoming-call] WS stream URL: ${wsUrl}`);

  // Pass metadata via <Parameter> — avoids query-string / XML-escaping issues
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid"      value="${callSid}" />
      <Parameter name="callerNumber" value="${callerNum}" />
      <Parameter name="twilioNumber" value="${twilioNum}" />
      <Parameter name="configId"     value="${config?.id || ''}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

module.exports = router;
