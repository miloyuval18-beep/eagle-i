// "Ask Eagle I" (lib/crmAssistant.js), bid requests (lib/crmBids.js) and the
// end-of-day check-in switch (lib/crmCheckins.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). /bid/<token> is the sub's page.
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const assistant = require('../lib/crmAssistant');
const bids = require('../lib/crmBids');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
const ctxOf = (req) => ({ tenantId: req.tenantId, userId: req.userId, name: (req.crmUser && (req.crmUser.name || req.crmUser.email)) || 'someone', role: (req.crmUser && req.crmUser.role) || 'member', manager: team.isManager(req.crmUser && req.crmUser.role), baseUrl: baseUrlOf(req) });

router.get('/api/crm/assistant/home', requireAuth, wrap('Failed to load', async (req, res) => res.json(await assistant.home(ctxOf(req)))));
router.get('/api/crm/assistant/threads', requireAuth, wrap('Failed to load', async (req, res) => res.json({ threads: await assistant.listThreads(ctxOf(req)) })));
router.post('/api/crm/assistant/threads', requireAuth, wrap('Failed to start', async (req, res) => res.json({ thread: await assistant.createThread(ctxOf(req)) })));
router.get('/api/crm/assistant/threads/:tid', requireAuth, wrap('Failed to load', async (req, res) => res.json(await assistant.threadView(ctxOf(req), req.params.tid))));
router.delete('/api/crm/assistant/threads/:tid', requireAuth, wrap('Failed to delete', async (req, res) => res.json(await assistant.deleteThread(ctxOf(req), req.params.tid))));
router.post('/api/crm/assistant/files', requireAuth, wrap('Failed to attach the file', async (req, res) => res.json({ file: await assistant.saveChatUpload(ctxOf(req), req.body || {}) })));
router.post('/api/crm/assistant/actions/:aid', requireAuth, wrap('Failed', async (req, res) => res.json(await assistant.decideAction(ctxOf(req), req.params.aid, !!(req.body || {}).approve))));

// A message: progress lines stream back as it works (newline-separated JSON).
router.post('/api/crm/assistant/threads/:tid/messages', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!process.env.ANTHROPIC_API_KEY && !require('../lib/anthropic').hasClientOverride?.()) {
    return res.status(503).json({ error: { message: 'The assistant isn’t switched on yet: the server needs its AI key (ANTHROPIC_API_KEY).' } });
  }
  res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const line = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch (e) { /* closed */ } };
  try {
    const r = await assistant.runTurn(ctxOf(req), { threadId: req.params.tid, text: b.text, chatFileIds: Array.isArray(b.fileIds) ? b.fileIds.slice(0, 10) : [], onEvent: line });
    line({ type: 'done', ...r });
  } catch (err) {
    line({ type: 'error', message: err.status && err.status < 500 ? err.message : `Something went wrong: ${err.message}` });
  }
  res.end();
});

router.get('/api/crm/me/checkin', requireAuth, wrap('Failed to load', async (req, res) => {
  const u = (await query('SELECT crm_checkin_off FROM users WHERE id = $1', [req.userId])).rows[0];
  res.json({ on: !(u && u.crm_checkin_off), byEmail: !!process.env.RESEND_INBOUND_DOMAIN });
}));
router.patch('/api/crm/me/checkin', requireAuth, wrap('Failed to save', async (req, res) => res.json(await require('../lib/crmCheckins').setCheckin(req.userId, !!(req.body || {}).on))));

// ---------- bids ----------
router.get('/api/crm/deals/:id/bids', requireAuth, wrap('Failed to load bids', async (req, res) => {
  if (!(await query('SELECT 1 FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId])).rows.length) return res.status(404).json({ error: { message: 'Deal not found.' } });
  res.json({ bids: await bids.listBids(req.tenantId, req.params.id) });
}));
router.post('/api/crm/bids/:bid/award', requireAuth, wrap('Failed', async (req, res) => res.json(await bids.award({ tenantId: req.tenantId, id: req.params.bid, userId: req.userId }))));

router.get('/bid/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'public', 'bid.html'));
});
const hits = new Map();
function limited(ip) { const now = Date.now(); const l = (hits.get(ip) || []).filter(t => now - t < 3600000); l.push(now); hits.set(ip, l); return l.length > 40; }
router.get('/api/crm-public/bid/:token', wrap('Failed to load', async (req, res) => {
  const info = await bids.bidInfo(req.params.token);
  if (!info) return res.status(404).json({ error: { message: 'This link is no longer active.' } });
  res.json(info);
}));
router.get('/api/crm-public/bid/:token/files/:fid', wrap('Failed to load the file', async (req, res) => {
  const f = await bids.bidFile(req.params.token, req.params.fid);
  if (!f) return res.status(404).type('text/plain').send('Not found.');
  res.set({ 'Content-Type': f.content_type, 'Content-Disposition': `inline; filename="${String(f.filename).replace(/[^\w.\- ]/g, '_')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(f.data));
}));
router.post('/api/crm-public/bid/:token', wrap('Failed to send your price', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  const b = req.body || {};
  res.json({ ok: true, ...(await bids.submitBid({ token: req.params.token, amount: b.amount, note: b.note, decline: !!b.decline })) });
}));

module.exports = router;
