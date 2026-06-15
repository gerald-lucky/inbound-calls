# Lucky Communities — AI Inbound/Outbound Call Agent

## What this project is

A full-stack AI voice call agent for Lucky Communities (Manufactured Housing Community operator). It handles inbound calls from residents and places outbound calls, connecting them to an AI bot powered by ElevenLabs TTS + Deepgram STT + Claude (Anthropic). All call data is stored in Supabase.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js / Express |
| Realtime audio | Twilio Media Streams (WebSocket) |
| STT | ElevenLabs Scribe (streaming) |
| TTS | ElevenLabs (streaming) |
| LLM | Anthropic Claude (claude-sonnet-4-6 or similar) |
| Database | Supabase (PostgreSQL + pgvector) |
| File storage | Supabase Storage |
| Embeddings | OpenAI (text-embedding-3-small) |
| Frontend | Vanilla JS / HTML / CSS (served as static files from Express) |
| Local tunnel | ngrok static domain: `primp-hacking-boaster.ngrok-free.dev` |

## Repository layout

```
inbound-calls/
├── backend/
│   ├── src/
│   │   ├── server.js              # Express + WebSocket server entry point
│   │   ├── call-session.js        # Manages one call's full lifecycle
│   │   ├── routes/
│   │   │   ├── incoming-call.js   # Twilio webhook → TwiML (inbound + outbound)
│   │   │   ├── calls.js           # REST: list, get, outbound, recording, status callbacks
│   │   │   ├── agent-configs.js   # REST: CRUD for agent configurations
│   │   │   ├── knowledge-base.js  # REST: upload / list / delete KB documents
│   │   │   ├── leads.js           # REST: lead capture list/delete
│   │   │   ├── tenants.js         # REST: tenant CRUD
│   │   │   ├── payments.js        # REST: payment log
│   │   │   └── slack.js           # Slack integration
│   │   └── services/
│   │       ├── call-logger.js     # All Supabase writes for calls (start/end/transcript/summary)
│   │       ├── agent-configs.js   # Supabase reads/writes for agent_configs
│   │       ├── llm.js             # Claude streaming + lead extraction + summary generation
│   │       ├── tts.js             # ElevenLabs TTS WebSocket
│   │       ├── transcription.js   # ElevenLabs Scribe STT
│   │       ├── rag.js             # Vector search against knowledge_base_chunks
│   │       ├── knowledge-base.js  # Document ingestion pipeline (chunk + embed + store)
│   │       ├── embedding.js       # OpenAI embedding wrapper
│   │       └── park-data.js       # Builds caller context (tenant lookup, balance, etc.)
│   ├── .env                       # Secret keys (not committed)
│   └── .env.example               # Template
├── frontend/
│   ├── index.html                 # Single-page admin UI
│   ├── app.js                     # All frontend JS (vanilla, no framework)
│   └── styles.css
└── supabase/
    └── migrations/
        ├── 001_initial.sql        # calls, leads, agent_configs base tables
        ├── 002_routing_and_analytics.sql  # agent_config_stats view, call_stats view
        ├── 003_park_schema.sql    # tenants, payments tables
        ├── 004_knowledge_base.sql # knowledge_base_documents, knowledge_base_chunks, pgvector
        ├── 005_outbound_recording.sql  # direction + recording_url columns on calls
        ├── 006_summary.sql        # summary column on calls
        └── 007_speaks_first.sql   # speaks_first column on agent_configs
```

## Environment variables (backend/.env)

```
PORT=3000
SERVER_URL=https://primp-hacking-boaster.ngrok-free.dev

TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...

ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...

ANTHROPIC_API_KEY=...

SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

OPENAI_API_KEY=...          # used for embeddings only

SUMMARY_MIN_DURATION_SECONDS=120    # calls shorter than this skip AI summary generation
```

## How to run locally

```bash
# Terminal 1 — backend
cd backend
npm install
node src/server.js

# Terminal 2 — ngrok tunnel (required for Twilio webhooks)
ngrok http --domain=primp-hacking-boaster.ngrok-free.dev 3000
```

Frontend is served as static files from Express — open http://localhost:3000

## Database migrations

All migrations are in `supabase/migrations/`. Apply in order via the Supabase SQL editor or:
```bash
supabase db push
```
If the schema is ever reset: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then re-apply all migrations and re-grant permissions.

## Key architecture decisions

### Call flow (inbound)
1. Caller dials Twilio number → Twilio fires `POST /incoming-call`
2. Route returns TwiML with `<Connect><Stream>` pointing to `wss://…/media-stream`
3. `CallSession` starts, opens Scribe STT WebSocket
4. Audio: Twilio WS → Scribe → utterance event → LLM → sentence events → TTS → Twilio WS
5. On teardown: `endCall()` logs duration, `_generateSummaryInBackground()` runs if call ≥ threshold

### Call flow (outbound)
1. `POST /api/calls/outbound` with `{ to, agentConfigId }` body
2. DB record created immediately (so non-answered calls still appear in the log)
3. Twilio REST `calls.create()` with `url: webhookUrl` (no Twilio dashboard config needed)
4. `statusCallback: /api/calls/status` handles busy/no-answer/failed → marks call ended
5. If answered: same media stream flow as inbound

### Webhook URL architecture
The webhook URL is passed directly in `calls.create({ url })` for outbound. Only `SERVER_URL` env var is required — no Twilio dashboard configuration.

### RAG pipeline
- Documents uploaded via admin UI → chunked → OpenAI embeddings → stored in `knowledge_base_chunks` with pgvector
- Per-utterance RAG: LLM service searches top-K chunks matching the caller's query
- Static context (park rules/FAQs) pre-loaded at call start to reduce latency

### Transcript diarization
Stored as JSONB array `[{ role: "caller"|"agent", text, ts }]` on the calls row. Appended after each utterance/response pair.

### Summary generation
- Runs async post-call teardown via `_generateSummaryInBackground()`
- Gated by `SUMMARY_MIN_DURATION_SECONDS` (default 120)
- Uses Claude with a 250-token summarization prompt
- Stored in `calls.summary`

### speaks_first config
Per-agent setting. When `false`, the bot does not speak the greeting on connect — the caller/recipient speaks first. Critical for outbound calls to avoid dead silence: always set `true` for outbound agents.

## Admin UI tabs

| Tab | Purpose |
|---|---|
| Dashboard | Stats + recent calls |
| Agents | Agent CRUD (was "Routing") — three-dots action menu, KB doc count badge, speaks_first badge |
| Call Log | Full call table with detail dialog (transcript, recording, summary) |
| Leads | Auto-detected lead captures |
| Tenants | Resident records |
| Payments | Payment log |
| Knowledge Base | Upload/manage RAG documents per agent |

## Call detail dialog
Opens on the eye icon in the call log. Shows:
- Overview grid (call ID, direction, status, agent, from, to, duration, started, ended, recording)
- Transcript tab — diarized bubbles (Agent / User)
- Recording tab — proxied audio player (`GET /api/calls/:id/recording`)
- Summary tab — AI summary with threshold note (e.g., "Summary ≥ 2m") on the tab label

## Current git branch
`implement-knowledge-base-system`

Main/base branch: `claude/ai-call-agent-XUq6a`

## What was recently completed (June 2026)
- Outbound call support with webhook URL passed in Twilio API request
- Recording save + audio proxy endpoint
- Call detail dialog with transcript, recording, summary tabs
- AI summary generation post-call (gated by min duration)
- All initiated calls logged (busy/no-answer/failed via Twilio status callback)
- Agents view: renamed from "Routing", three-dots action menu, KB count, speaks_first badge/config
- Transcript labels "User" for caller side (not "Caller")
- Summary tab label shows threshold inline (e.g., "≥ 2m")

## Pending / potential next steps
- Show individual KB documents attached to each agent inline in the Agents view (currently shows count only)
- Add call_status column to distinguish busy / no-answer / failed / completed in the UI
- Outbound call scheduling / campaigns
- Slack notification on new lead capture
