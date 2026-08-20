// Eagle I — server-side proxy for the Anthropic API.
// Keeps ANTHROPIC_API_KEY out of the browser. The frontend calls POST /api/claude
// with { messages, max_tokens } and this server attaches the key and forwards
// the request to Anthropic, returning the response as-is.

const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS_CAP = 4096;

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
});
