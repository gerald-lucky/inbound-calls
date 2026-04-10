# Deployment

## Architecture

| Layer | Host | Why |
|---|---|---|
| **Frontend** (static HTML/JS/CSS) | **Vercel** | Zero config, free, instant CDN |
| **Backend** (Node.js + WebSockets) | **Railway** | Persistent process needed for long-lived Twilio Media Stream connections |

Vercel serverless functions have a hard execution timeout and cannot hold an open WebSocket connection for the duration of a phone call. The backend must run as a persistent Node.js process.

---

## 1. Backend — Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Railway auto-detects the `Dockerfile` at the repo root
4. In the Railway dashboard, add all environment variables from `backend/.env.example`
5. Railway gives you a public URL (e.g. `https://inbound-calls.up.railway.app`)
   - Set `SERVER_URL` to that URL in Railway's env vars
6. Set your Twilio phone number's webhook to:
   `https://inbound-calls.up.railway.app/incoming-call`

---

## 2. Frontend — Vercel

The frontend talks to the backend via `/api/*` paths. `frontend/vercel.json` rewrites those to your Railway backend so relative paths in `app.js` keep working.

**One-time setup:**

1. Edit `frontend/vercel.json` — replace `REPLACE_WITH_YOUR_RAILWAY_URL` with your actual Railway URL:
   ```json
   {
     "rewrites": [
       {
         "source": "/api/:path*",
         "destination": "https://inbound-calls.up.railway.app/api/:path*"
       }
     ]
   }
   ```

2. Deploy the `frontend/` directory to Vercel:
   ```bash
   npm i -g vercel
   cd frontend
   vercel --prod
   ```
   Or connect the repo in the Vercel dashboard and set **Root Directory** to `frontend`.

3. Vercel gives you a URL (e.g. `https://call-agent.vercel.app`) — that's your admin UI.

---

## 3. Fly.io (alternative backend — lower latency in US-East)

```bash
fly launch --dockerfile Dockerfile --region iad
fly secrets set PORT=3000 TWILIO_AUTH_TOKEN=xxx ELEVENLABS_API_KEY=xxx \
  ANTHROPIC_API_KEY=xxx OPENAI_API_KEY=xxx \
  ELEVENLABS_API_KEY=xxx ELEVENLABS_VOICE_ID=xxx \
  SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx \
  SERVER_URL=https://your-app.fly.dev \
  AGENT_SYSTEM_PROMPT="You are..."
fly deploy
```

---

## Local development

```bash
cd backend
cp .env.example .env    # fill in your keys
npm install
npm start               # runs on http://localhost:3000
                        # admin UI is at http://localhost:3000

# Expose to Twilio:
npx ngrok http 3000
# Copy the https:// ngrok URL
# Set SERVER_URL=https://xxx.ngrok.io in .env and restart
# Set Twilio webhook to https://xxx.ngrok.io/incoming-call
```
