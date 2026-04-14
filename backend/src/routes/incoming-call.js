'use strict';

const express = require('express');
const router = express.Router();
const agentConfigs = require('../services/agent-configs');

// POST /incoming-call — Twilio webhook for every inbound call.
// 1. Look up the agent config for the dialled Twilio number.
// 2. Return TwiML that opens a bidirectional Media Stream to /media-stream,
//    passing call metadata as query params so the WS handler can use it.
router.post('/', async (req, res) => {
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl) {
    console.error('[incoming-call] SERVER_URL is not set');
    return res.status(500).send('Server misconfigured');
  }

  // Twilio provides these in the POST body
  const callSid     = req.body.CallSid  || '';
  const callerNum   = req.body.From     || 'unknown';
  const twilioNum   = req.body.To       || '';

  console.log(`[incoming-call] ${callerNum} → ${twilioNum} (${callSid})`);

  // Look up which agent config is assigned to this Twilio number
  const config = await agentConfigs.findByTwilioNumber(twilioNum);
  if (config) {
    console.log(`[incoming-call] Using agent config: "${config.name}" (${config.id})`);
  } else {
    console.log('[incoming-call] No agent config found — will use env-var defaults');
  }

  const base  = serverUrl.replace(/\/$/, '');
  const wsBase = base.replace(/^http/, 'wss');

  // Embed metadata as query params — the WS upgrade handler reads these
  const params = new URLSearchParams({
    callSid,
    callerNumber: callerNum,
    twilioNumber: twilioNum,
    configId: config?.id || '',
  });

  const wsUrl = `${wsBase}/media-stream?${params.toString()}`;
  // & must be escaped as &amp; inside XML attribute values
  const xmlSafeWsUrl = wsUrl.replace(/&/g, '&amp;');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlSafeWsUrl}" />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

module.exports = router;
