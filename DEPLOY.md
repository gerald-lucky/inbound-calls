# Deployment

## Why not Vercel?

This backend holds **long-lived WebSocket connections** for the duration of each phone call (potentially minutes). Vercel's serverless functions have a hard timeout and cannot maintain persistent connections. Use a container-based host instead.

## Railway (recommended — similar DX to Vercel)

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Railway auto-detects the `Dockerfile`
4. Add environment variables in the Railway dashboard (copy from `backend/.env.example`)
5. Railway gives you a public URL → set `SERVER_URL` to that URL
6. Set your Twilio phone number's webhook to `https://your-app.railway.app/incoming-call`

## Fly.io (alternative, US-East recommended for Twilio latency)

```bash
fly launch --dockerfile Dockerfile --region iad
fly secrets set PORT=3000 TWILIO_AUTH_TOKEN=xxx ELEVENLABS_API_KEY=xxx ...
fly deploy
```

## Local development with ngrok

```bash
cd backend
cp .env.example .env   # fill in your keys
npm install
npm start

# In another terminal:
npx ngrok http 3000
# Copy the https URL → set SERVER_URL in .env, restart server
# Set Twilio webhook to https://xxx.ngrok.io/incoming-call
```
