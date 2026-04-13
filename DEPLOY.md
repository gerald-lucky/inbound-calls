# Deployment

## Everything runs on Railway

One host, one URL. Railway runs your Node.js server which handles:
- The AI call agent (Twilio WebSocket + STT → LLM → TTS pipeline)
- The REST API (`/api/*`)
- The admin UI (served as static files from `/`)
- The Twilio webhook (`/incoming-call`)

---

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Railway auto-detects the `Dockerfile` at the repo root
4. Add environment variables in the Railway dashboard (copy from `backend/.env.example`):
   ```
   PORT=3000
   SERVER_URL=https://your-app.up.railway.app
   TWILIO_ACCOUNT_SID=
   TWILIO_AUTH_TOKEN=
   ELEVENLABS_API_KEY=
   ELEVENLABS_VOICE_ID=
   ANTHROPIC_API_KEY=
   SUPABASE_URL=
   SUPABASE_SERVICE_ROLE_KEY=
   AGENT_SYSTEM_PROMPT=
   ```
5. Set `SERVER_URL` to the Railway public URL Railway assigns you
6. Set your Twilio phone number's webhook to:
   `https://your-app.up.railway.app/incoming-call`
7. Open `https://your-app.up.railway.app` — your admin dashboard is live

---

## Local development

```bash
cd backend
cp .env.example .env    # fill in your keys
npm install
npm start               # server + admin UI at http://localhost:3000

# Expose to Twilio:
npx ngrok http 3000
# Copy the https:// ngrok URL
# Set SERVER_URL=https://xxx.ngrok.io in .env and restart
# Set Twilio webhook to https://xxx.ngrok.io/incoming-call
```

---

## Supabase migrations

Run all three files in order in your Supabase project's SQL editor (Dashboard → SQL Editor):

1. `supabase/migrations/001_initial.sql`
2. `supabase/migrations/002_routing_and_analytics.sql`
3. `supabase/migrations/003_park_schema.sql`
