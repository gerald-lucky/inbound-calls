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

// ── Slack Web API helpers ─────────────────────────────────────────────────────

function slackToken() { return (process.env.SLACK_BOT_TOKEN || '').trim(); }

async function postMessage(channel, text, threadTs) {
  const body = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: { Authorization: `Bearer ${slackToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) console.error('[slack] postMessage error:', data.error);
}

// Upload a file buffer to a Slack channel/thread (files v2 API)
async function uploadFileToSlack(channel, threadTs, buffer, filename, title) {
  const token = slackToken();

  // Step 1: request an upload URL
  const urlRes  = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ filename, length: String(buffer.length) }),
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`Slack getUploadURLExternal: ${urlData.error}`);

  // Step 2: PUT the raw bytes to the upload URL
  const putRes = await fetch(urlData.upload_url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body:    buffer,
  });
  if (!putRes.ok) throw new Error(`Slack upload PUT failed: ${putRes.status}`);

  // Step 3: complete upload, share to channel/thread
  const doneRes  = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      files:      [{ id: urlData.file_id, title }],
      channel_id: channel,
      thread_ts:  threadTs,
    }),
  });
  const doneData = await doneRes.json();
  if (!doneData.ok) throw new Error(`Slack completeUploadExternal: ${doneData.error}`);
  console.log(`[slack] File "${filename}" uploaded to ${channel}`);
  return doneData;
}

// Fetch prior thread messages and rebuild as Claude-compatible history
async function fetchThreadHistory(channel, threadTs, currentMsgTs) {
  try {
    const res  = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=50`,
      { headers: { Authorization: `Bearer ${slackToken()}` } }
    );
    const data = await res.json();
    if (!data.ok) { console.warn('[slack] fetchThreadHistory failed:', data.error); return []; }
    if (!data.messages?.length) return [];

    const history = [];
    for (const msg of data.messages) {
      if (msg.ts === currentMsgTs) continue; // skip the message we're currently processing
      const text = (msg.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!text) continue;
      if (msg.bot_id || msg.subtype === 'bot_message') {
        history.push({ role: 'assistant', content: text });
      } else if (msg.user) {
        history.push({ role: 'user', content: text });
      }
    }
    console.log(`[slack] Rebuilt ${history.length} messages from thread ${threadTs}`);
    return history;
  } catch (err) {
    console.error('[slack] fetchThreadHistory error:', err.message);
    return [];
  }
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

  const threadTs  = event.thread_ts || event.ts;
  const isReply   = !!event.thread_ts && event.thread_ts !== event.ts;

  // If this is a reply in an existing thread, check if we need to reload history from Slack
  let prefetchedHistory = null;
  if (isReply) {
    const { hasFreshHistory } = require('../services/slack-bot');
    if (!hasFreshHistory(threadTs)) {
      prefetchedHistory = await fetchThreadHistory(event.channel, threadTs, event.ts);
    }
  }

  const slackContext = {
    channel:  event.channel,
    threadTs,
    uploadFile: (buffer, filename, title) =>
      uploadFileToSlack(event.channel, threadTs, buffer, filename, title),
  };

  try {
    const reply = await processSlackMessage(text, threadTs, prefetchedHistory, slackContext);
    if (reply) await postMessage(event.channel, reply, threadTs);
  } catch (err) {
    console.error('[slack] Error processing message:', err.message);
    await postMessage(
      event.channel,
      `Sorry, I ran into an error: ${err.message}`,
      threadTs
    );
  }
});

module.exports = router;
