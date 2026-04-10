'use strict';

const express = require('express');
const router = express.Router();

// POST /incoming-call — Twilio calls this webhook when an inbound call arrives.
// We respond with TwiML that tells Twilio to open a bidirectional Media Stream
// to our WebSocket endpoint (/media-stream).
router.post('/', (req, res) => {
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl) {
    console.error('[incoming-call] SERVER_URL env var is not set');
    return res.status(500).send('Server misconfigured: SERVER_URL not set');
  }

  // Strip any trailing slash for safety
  const base = serverUrl.replace(/\/$/, '');
  const wsUrl = base.replace(/^http/, 'wss') + '/media-stream';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
  console.log(`[incoming-call] Answered call → streaming to ${wsUrl}`);
});

module.exports = router;
