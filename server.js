// Eagle I — server-side proxy for the Anthropic API.
// Keeps ANTHROPIC_API_KEY out of the browser. The frontend calls POST /api/claude
// with { messages, max_tokens } and this server attaches the key and forwards
// the request to Anthropic, returning the response as-is.

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS_CAP = 4096;

// Whole-site HTTP Basic Auth. If SITE_USER/SITE_PASSWORD aren't set, the site
// stays open (so local dev works with zero config) — set both in production
// to require a login before anything (including the app itself) loads.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
  const user = process.env.SITE_USER;
  const pass = process.env.SITE_PASSWORD;
  if (!user || !pass) return next(); // not configured — no gate

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const reqUser = sep === -1 ? decoded : decoded.slice(0, sep);
    const reqPass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (timingSafeEqual(reqUser, user) && timingSafeEqual(reqPass, pass)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Eagle I"');
  res.status(401).send('Authentication required.');
}

// Per-IP sliding-window rate limit on the (paid) Claude proxy, so a single
// visitor can't run up the API bill. No login required — just a sane cap.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateLimitHits = new Map(); // ip -> array of request timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

const app = express();
app.set('trust proxy', true); // Render/Railway/Fly sit behind a proxy; needed for real client IPs
app.use(basicAuth);
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname)));

app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set on the server.' } });
  }

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: { message: `Rate limit exceeded — max ${RATE_LIMIT_MAX} requests/hour per visitor. Try again later.` } });
  }

  const { messages, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'Request body must include a non-empty "messages" array.' } });
  }

  const cappedMaxTokens = Math.min(Number(max_tokens) || 1000, MAX_TOKENS_CAP);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: cappedMaxTokens, messages })
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to reach Anthropic API: ' + err.message } });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Eagle I server running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set — /api/claude will return 500 until it is.');
  }
  if (!process.env.SITE_USER || !process.env.SITE_PASSWORD) {
    console.warn('WARNING: SITE_USER / SITE_PASSWORD are not set — the site is publicly accessible with no login.');
  }
});
