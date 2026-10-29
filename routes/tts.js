// Eagle I's natural voice (lib/tts.js) for every page that talks: the CRM, Eagle I
// Marketing, and the homeowner's and sub's pages. Only signed-in people, or a real
// homeowner or sub page, can use it; a few requests a minute per person at most.
// When it answers 204, the page uses the browser's own voice instead.
const express = require('express');
const { query } = require('../db');
const tts = require('../lib/tts');

const router = express.Router();
const hits = new Map();
function limited(key, max = 40, ms = 60 * 1000) {
  const now = Date.now(); const h = (hits.get(key) || []).filter(t => now - t < ms); h.push(now); hits.set(key, h);
  if (hits.size > 5000) hits.clear();
  return h.length > max;
}
async function allowed(req) {
  if (req.session && (req.session.userId || req.session.accountId)) return true;
  const m = /^\/(p|s)\/([0-9a-f]{20,80})(?:[/?#]|$)/i.exec(String((req.body || {}).page || ''));
  if (!m) return false;
  const sql = m[1] === 'p' ? 'SELECT 1 FROM crm_deals WHERE portal_token = $1' : 'SELECT 1 FROM crm_vendors WHERE portal_token = $1';
  return !!(await query(sql, [m[2]]).catch(() => ({ rows: [] }))).rows.length;
}

router.post('/api/tts', async (req, res) => {
  try {
    const b = req.body || {};
    if (!(await allowed(req))) return res.status(204).end();
    if (limited((req.session && (req.session.userId || req.session.accountId)) || req.ip)) return res.status(204).end();
    const r = await tts.speak({ text: b.text, lang: b.lang, rate: b.rate });
    if (!r.audio) { res.set('X-Voice-Fallback', r.fallback || 'error'); return res.status(204).end(); }
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', 'Content-Length': r.audio.length });
    res.end(r.audio);
  } catch (err) { console.error('[tts] route failed:', err.message); res.status(204).end(); }
});

module.exports = router;
