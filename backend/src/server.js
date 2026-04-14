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
const wss = new WebSocketServer({ server, path: '/media-stream' });

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

wss.on('connection', async (ws, req) => {
  const parsed = url.parse(req.url, true);
  const { callSid, callerNumber, twilioNumber, configId } = parsed.query;

  console.log(`[server] New call — ${callerNumber || '?'} → ${twilioNumber || '?'}`);

  let agentConfig = null;
  if (configId) {
    try {
      agentConfig = await agentConfigs.getById(configId);
    } catch (err) {
      console.error('[server] Failed to fetch agent config:', err.message);
    }
  }

  const session = new CallSession(ws, { callSid, callerNumber, twilioNumber, agentConfig });
  session.start();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Webhook: POST ${process.env.SERVER_URL || `http://localhost:${PORT}`}/incoming-call`);
  console.log(`[server] Admin UI: ${process.env.SERVER_URL || `http://localhost:${PORT}`}/`);
});
