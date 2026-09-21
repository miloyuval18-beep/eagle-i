// Public opt-out page linked from every outreach email (and offered to mail
// clients via the List-Unsubscribe header). The link carries an HMAC of the
// tenant + address (lib/vendorOutreach.js), so no login is needed and nobody
// can opt out an address they weren't sent a link for.
//
// GET only shows a confirmation button — mail scanners prefetch links, and a
// prefetch must not opt anyone out. POST does the opt-out (it's also what
// mail clients' one-click unsubscribe sends).
const express = require('express');
const { query } = require('../db');
const { verifyUnsubscribeSig, normEmail } = require('../lib/vendorOutreach');
const { cancelFollowUps } = require('../lib/followUps');

const router = express.Router();

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f9;color:#12203a;margin:0;padding:48px 20px}main{max-width:440px;margin:0 auto;background:#fff;border:1px solid #e3e9f0;border-radius:10px;padding:28px}h1{font-size:19px;margin:0 0 10px}p{font-size:14px;line-height:1.55;color:#3d5169}button{font:inherit;font-weight:600;background:#12203a;color:#fff;border:0;border-radius:7px;padding:10px 18px;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;

function parseParams(req) {
  const { t, e, s } = req.query;
  if (!t || !e || !s || !verifyUnsubscribeSig(t, e, s)) return null;
  return { tenantId: String(t), email: normEmail(e), sig: String(s) };
}

router.get('/unsubscribe', (req, res) => {
  const p = parseParams(req);
  if (!p) return res.status(400).send(page('Link not valid', '<h1>This link isn\'t valid</h1><p>It may have been copied incorrectly. Reply to the original email and ask to be removed instead.</p>'));
  res.send(page('Unsubscribe', `<h1>Stop emails to ${esc(p.email)}?</h1><p>You'll no longer receive outreach emails from this sender.</p>
<form method="POST" action="/unsubscribe?${new URLSearchParams({ t: p.tenantId, e: p.email, s: p.sig }).toString()}"><button type="submit">Unsubscribe</button></form>`));
});

router.post('/unsubscribe', async (req, res) => {
  const p = parseParams(req);
  if (!p) return res.status(400).send(page('Link not valid', '<h1>This link isn\'t valid</h1>'));
  try {
    await query(
      `INSERT INTO outreach_suppressions (tenant_id, email) VALUES ($1, $2)
       ON CONFLICT (tenant_id, lower(email)) DO NOTHING`,
      [p.tenantId, p.email]
    );
    await cancelFollowUps(p.tenantId, p.email, 'opted_out');
    res.send(page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${esc(p.email)} won't receive further outreach emails from this sender.</p>`));
  } catch (err) {
    console.error('Unsubscribe failed:', err.message);
    res.status(500).send(page('Something went wrong', '<h1>Something went wrong</h1><p>Please reply to the original email and ask to be removed.</p>'));
  }
});

module.exports = router;
