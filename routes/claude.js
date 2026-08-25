// Tenant-aware Claude proxy. Two layers of protection:
//  1. Per-IP sliding-window limit (abuse guard, cheap, no DB round-trip)
//  2. Per-tenant persisted monthly cap tied to their plan_tier (the real
//     cost-control mechanism now that this is billed, multi-tenant usage)
const express = require('express');
const { requireAuth } = require('../auth');
const { checkAndIncrementUsage } = require('../lib/usage');

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS_CAP = 4096;

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateLimitHits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

const router = express.Router();

router.post('/api/claude', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set on the server.' } });
  }

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: { message: `Rate limit exceeded — max ${RATE_LIMIT_MAX} requests/hour. Try again later.` } });
  }

  const { messages, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'Request body must include a non-empty "messages" array.' } });
  }

  let usage;
  try {
    usage = await checkAndIncrementUsage(req.tenantId);
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to check usage: ' + err.message } });
  }
  if (!usage.allowed) {
    return res.status(429).json({
      error: { message: `Monthly generation limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` }
    });
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
      // Thinking explicitly disabled: every caller of this proxy wants a
      // structured JSON answer, not visible reasoning — Sonnet 5 defaults
      // to spending part of max_tokens on thinking, which was eating the
      // whole budget on tighter limits and leaving nothing for the actual
      // text/JSON output.
      body: JSON.stringify({ model: MODEL, max_tokens: cappedMaxTokens, thinking: { type: 'disabled' }, messages })
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to reach Anthropic API: ' + err.message } });
  }
});

module.exports = router;
