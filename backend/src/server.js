'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');

const incomingCallRoute = require('./routes/incoming-call');
const agentConfigsRoute = require('./routes/agent-configs');
const callsRoute        = require('./routes/calls');
const leadsRoute        = require('./routes/leads');
const tenantsRoute      = require('./routes/tenants');
const paymentsRoute     = require('./routes/payments');
const slackRoute        = require('./routes/slack');
const CallSession       = require('./call-session');

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

app.get('/api/health', async (_req, res) => {
  const { createClient } = require('@supabase/supabase-js');
  const checks = {
    supabase_url:  !!process.env.SUPABASE_URL,
    supabase_key:  !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    server_url:    !!process.env.SERVER_URL,
  };
  let supabase_reachable = false;
  let supabase_error = null;
  if (checks.supabase_url && checks.supabase_key) {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await sb.from('calls').select('id').limit(1);
      supabase_reachable = !error;
      if (error) supabase_error = error.message;
    } catch (err) {
      supabase_error = err.message;
    }
  } else {
    supabase_error = 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var is missing';
  }
  const ok = checks.supabase_url && checks.supabase_key && supabase_reachable;
  res.status(ok ? 200 : 503).json({ ok, checks, supabase_reachable, supabase_error });
});

app.use('/incoming-call',     incomingCallRoute);
app.use('/api/agent-configs', agentConfigsRoute);
app.use('/api/calls',         callsRoute);
app.use('/api/leads',         leadsRoute);
app.use('/api/tenants',       tenantsRoute);
app.use('/api/payments',      paymentsRoute);
app.use('/slack',             slackRoute);

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
});
