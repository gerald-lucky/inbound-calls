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
const CallSession       = require('./call-session');

const app    = express();
const server = http.createServer(app);
// No path filter — accept all WebSocket upgrades (only /media-stream is used)
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(express.static(path.join(__dirname, '../../frontend')));

app.use('/incoming-call',     incomingCallRoute);
app.use('/api/agent-configs', agentConfigsRoute);
app.use('/api/calls',         callsRoute);
app.use('/api/leads',         leadsRoute);
app.use('/api/tenants',       tenantsRoute);
app.use('/api/payments',      paymentsRoute);

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
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Webhook: POST ${process.env.SERVER_URL || `http://localhost:${PORT}`}/incoming-call`);
  console.log(`[server] Admin UI: ${process.env.SERVER_URL || `http://localhost:${PORT}`}/`);
});
