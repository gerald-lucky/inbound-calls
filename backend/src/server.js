'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');

const incomingCallRoute  = require('./routes/incoming-call');
const agentConfigsRoute  = require('./routes/agent-configs');
const callsRoute         = require('./routes/calls');
const leadsRoute         = require('./routes/leads');
const tenantsRoute       = require('./routes/tenants');
const paymentsRoute      = require('./routes/payments');
const slackRoute         = require('./routes/slack');
const knowledgeBaseRoute = require('./routes/knowledge-base');
const CallSession       = require('./call-session');
const { warmup: warmupEmbedding } = require('./services/embedding');

const app    = express();
const server = http.createServer(app);
// No path filter — accept all WebSocket upgrades (only /media-stream is used)
const wss    = new WebSocketServer({ server });

app.use(cors());
// Capture raw body for Slack signature verification before JSON parsing
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));
app.use(express.urlencoded({ extended: false }));

app.use(express.static(path.join(__dirname, '../../frontend')));

app.use('/incoming-call',       incomingCallRoute);
// Lightweight config endpoint — exposes non-secret env settings to the frontend
app.get('/api/config', (_req, res) => {
  res.json({
    summaryMinDurationSeconds: parseInt(process.env.SUMMARY_MIN_DURATION_SECONDS ?? '120', 10),
  });
});

app.use('/api/agent-configs',   agentConfigsRoute);
app.use('/api/calls',           callsRoute);
app.use('/api/leads',           leadsRoute);
app.use('/api/tenants',         tenantsRoute);
app.use('/api/payments',        paymentsRoute);
app.use('/api/knowledge-base',  knowledgeBaseRoute);
app.use('/slack',               slackRoute);

wss.on('connection', (ws, req) => {
  console.log(`[server] WebSocket connected — ${req.url}`);
  const session = new CallSession(ws);
  session.start();
});

wss.on('error', (err) => {
  console.error('[server] WebSocket server error:', err.message);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] v2 — Listening on port ${PORT}`);
  console.log(`[server] Webhook: POST ${process.env.SERVER_URL || `http://localhost:${PORT}`}/incoming-call`);
  console.log(`[server] Admin UI: ${process.env.SERVER_URL || `http://localhost:${PORT}`}/`);

  // Pre-load the embedding model so it's ready before the first upload.
  // Runs in the background — server accepts traffic immediately.
  warmupEmbedding()
    .then(() => console.log('[server] Embedding model pre-loaded'))
    .catch((err) => console.error('[server] Embedding warmup failed (will retry on first upload):', err.message));
});
