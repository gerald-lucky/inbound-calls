'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');

const incomingCallRoute = require('./routes/incoming-call');
const documentsRoute = require('./routes/documents');
const CallSession = require('./call-session');

const app = express();
const server = http.createServer(app);

// WebSocket server — handles Twilio Media Stream connections on /media-stream
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve the frontend admin UI
app.use(express.static(path.join(__dirname, '../../frontend')));

// HTTP routes
app.use('/incoming-call', incomingCallRoute);
app.use('/api/documents', documentsRoute);

// Upgrade HTTP → WebSocket only for /media-stream path
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Each WebSocket connection = one active phone call
wss.on('connection', (ws) => {
  console.log('[server] New Twilio Media Stream connection');
  const session = new CallSession(ws);
  session.start();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Twilio webhook: POST ${process.env.SERVER_URL || `http://localhost:${PORT}`}/incoming-call`);
});
