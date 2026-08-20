# Eagle I — AI Marketing Command Center

Levi Homes' marketing dashboard. Static frontend (`index.html`) served by a small
Express proxy (`server.js`) that keeps the Anthropic API key server-side.

## Run locally

```bash
npm install
cp .env.example .env   # then edit .env and add your real ANTHROPIC_API_KEY
npm start
```

Open http://localhost:3000

## Deploy (Render)

1. Push this repo to GitHub.
2. On [render.com](https://render.com), New → Blueprint → pick this repo (uses `render.yaml`).
   Or: New → Web Service → pick this repo, Build Command `npm install`, Start Command `npm start`.
3. In the service's Environment tab, add `ANTHROPIC_API_KEY` with your real key.
4. Deploy. Render gives you a `https://<name>.onrender.com` URL — that's your live site.
5. (Optional) Settings → Custom Domain to point your own domain at it.

## Notes

- `ANTHROPIC_API_KEY` must never be committed. `.env` is gitignored; only `.env.example` (no real key) is tracked.
- The Anthropic API key is billed per request. `/api/claude` has no login in front of it, so it's protected by a per-IP rate limit instead (30 requests/hour/visitor, see `RATE_LIMIT_MAX` in `server.js`). That caps worst-case cost from a single visitor but doesn't stop many different visitors from each using their own 30/hour. Add real auth (e.g. a shared password) if this needs to be locked down further.
