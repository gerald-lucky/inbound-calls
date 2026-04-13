'use strict';

require('dotenv').config();

const http = require('http');
const url = require('url');
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
const CallSession        = require('./call-session');
const agentConfigs       = require('./services/agent-configs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve the frontend admin UI as static files
app.use(express.static(path.join(__dirname, '../../frontend')));

// HTTP API routes
app.use('/incoming-call',       incomingCallRoute);
app.use('/api/agent-configs',   agentConfigsRoute);
app.use('/api/calls',           callsRoute);
app.use('/api/leads',           leadsRoute);
app.use('/api/tenants',         tenantsRoute);
app.use('/api/payments',        paymentsRoute);

// Upgrade HTTP → WebSocket only for /media-stream
server.on('upgrade', async (req, socket, head) => {
  const parsed = url.parse(req.url, true);

  if (!parsed.pathname.startsWith('/media-stream')) {
    socket.destroy();
    return;
  }

  // Extract call metadata embedded by incoming-call.js
  const { callSid, callerNumber, twilioNumber, configId } = parsed.query;

  // Resolve the agent config (may already be known via configId, fetch full object)
  let agentConfig = null;
  if (configId) {
    try {
      agentConfig = await agentConfigs.getById(configId);
    } catch {
      // config might have been deleted between webhook and WS connect; fall back
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, { callSid, callerNumber, twilioNumber, agentConfig });
  });
});

wss.on('connection', (ws, _req, meta = {}) => {
  console.log(`[server] New call — ${meta.callerNumber || '?'} → ${meta.twilioNumber || '?'}`);
  const session = new CallSession(ws, meta);
  session.start();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Webhook: POST ${process.env.SERVER_URL || `http://localhost:${PORT}`}/incoming-call`);
  console.log(`[server] Admin UI: ${process.env.SERVER_URL || `http://localhost:${PORT}`}/`);
});
