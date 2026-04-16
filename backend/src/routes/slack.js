'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { processSlackMessage } = require('../services/slack-bot');

// Deduplicate Slack retries — Slack resends if no 200 within 3s
const _processed = new Set();

// ── Signature verification ────────────────────────────────────────────────────

function verifySlackSignature(req) {
  const secret    = process.env.SLACK_SIGNING_SECRET || '';
  const timestamp = req.headers['x-slack-request-timestamp'] || '';
  const signature = req.headers['x-slack-signature'] || '';
  const rawBody   = req.rawBody || '';

  if (!secret) return true; // skip if not configured

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Slack Web API helper ──────────────────────────────────────────────────────

async function postMessage(channel, text, threadTs) {
  const body = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) console.error('[slack] postMessage error:', data.error);
}

// ── Route: POST /slack/events ─────────────────────────────────────────────────

// Body already parsed by global express.json(); rawBody captured via verify option
router.post('/events', async (req, res) => {
  const payload = req.body;

  if (!verifySlackSignature(req)) {
    console.warn('[slack] Invalid signature');
    return res.status(403).send('Forbidden');
  }

  // Slack URL verification challenge (one-time setup)
  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge });
  }

  // Acknowledge immediately — Slack requires 200 within 3 seconds
  res.sendStatus(200);

  const event = payload.event;
  if (!event) return;

  // Ignore bot messages (prevent infinite loops)
  if (event.bot_id || event.subtype === 'bot_message') return;

  // Respond to DMs (message.im) and @mentions (app_mention)
  if (event.type !== 'message' && event.type !== 'app_mention') return;

  // Deduplicate retries
  const eventId = payload.event_id;
  if (eventId) {
    if (_processed.has(eventId)) return;
    _processed.add(eventId);
    setTimeout(() => _processed.delete(eventId), 60_000);
  }

  // Strip bot mention from text (e.g. "<@U123> what's John's balance?" → "what's John's balance?")
  const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return;

  console.log(`[slack] "${text}" from ${event.user} in ${event.channel}`);

  try {
    const reply = await processSlackMessage(text);
    await postMessage(event.channel, reply, event.thread_ts || event.ts);
  } catch (err) {
    console.error('[slack] Error processing message:', err.message);
    await postMessage(
      event.channel,
      `Sorry, I ran into an error: ${err.message}`,
      event.thread_ts || event.ts
    );
  }
});

module.exports = router;
