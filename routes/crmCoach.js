// The AI helping day to day (lib/crmCoach.js): lead summaries, the next move,
// reply drafts, overdue-invoice reminders and the voice job log. Sits behind
// routes/crm.js's sign-in and "company has the CRM" check (mounted after it).
const express = require('express');
const { requireAuth } = require('../auth');
const coach = require('../lib/crmCoach');
const { query } = require('../db');

const router = express.Router();
const wrap = (what, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    const st = err.status || 500;
    if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
    if (/RESEND_API_KEY/.test(err.message || '')) return res.status(503).json({ error: { message: 'Email sending is not set up on the server yet.' } });
    res.status(st).json({ error: { message: st === 500 ? `${what}: ${err.message}` : err.message } });
  }
};
async function ownDeal(req, res) {
  const d = (await query('SELECT id, lead_summary, next_move, next_move_at FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }))).rows[0];
  if (!d) res.status(404).json({ error: { message: 'Deal not found.' } });
  return d;
}

router.get('/api/crm/deals/:id/coach', requireAuth, wrap('Failed to load', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const last = (await query(`SELECT id, subject, sent_at, draft_reply FROM crm_emails WHERE deal_id = $1 AND direction = 'in' ORDER BY sent_at DESC LIMIT 1`, [d.id])).rows[0];
  const lastOut = last ? (await query(`SELECT 1 FROM crm_activities WHERE deal_id = $1 AND kind = 'email' AND actor = 'owner' AND created_at > $2 LIMIT 1`, [d.id, last.sent_at])).rows[0] : null;
  res.json({ leadSummary: d.lead_summary, nextMove: d.next_move, nextMoveAt: d.next_move_at, ai: !!process.env.ANTHROPIC_API_KEY,
    latestEmail: last ? { email_id: String(last.id), subject: last.subject, at: last.sent_at, answered: !!lastOut, draft: last.draft_reply } : null });
}));
router.post('/api/crm/deals/:id/next-move', requireAuth, wrap('Failed to think it through', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  res.json(await coach.nextMove(req.tenantId, d.id));
}));
router.post('/api/crm/deals/:id/draft-reply', requireAuth, wrap('Failed to draft a reply', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  res.json(await coach.draftReply(req.tenantId, d.id));
}));
router.post('/api/crm/deals/:id/email', requireAuth, wrap('Failed to send the email', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const b = req.body || {};
  res.json(await coach.emailHomeowner({ tenantId: req.tenantId, dealId: d.id, subject: b.subject, message: b.message, userId: req.userId }));
}));
router.post('/api/crm/deals/:id/voice-log', requireAuth, wrap('Failed to file the log', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const b = req.body || {};
  res.json(await coach.fileVoiceLog({ tenantId: req.tenantId, dealId: d.id, text: b.text, share: !!b.share, userId: req.userId }));
}));

router.get('/api/crm/nudges/:nid', requireAuth, wrap('Failed to load', async (req, res) => {
  const n = (await query(`SELECT n.id, n.subject, n.message, n.days_overdue, n.status, i.number, i.amount, c.name, c.email FROM crm_invoice_nudges n JOIN crm_invoices i ON i.id = n.invoice_id
    JOIN crm_deals d ON d.id = i.deal_id JOIN crm_contacts c ON c.id = d.contact_id WHERE n.id = $1 AND n.tenant_id = $2`, [req.params.nid, req.tenantId]).catch(() => ({ rows: [] }))).rows[0];
  if (!n) return res.status(404).json({ error: { message: 'Not found.' } });
  res.json(n);
}));
router.post('/api/crm/nudges/:nid/send', requireAuth, wrap('Failed to send the reminder', async (req, res) => {
  const b = req.body || {};
  res.json(await coach.sendNudge({ tenantId: req.tenantId, nudgeId: req.params.nid, subject: b.subject, message: b.message, userId: req.userId }));
}));
router.post('/api/crm/nudges/:nid/skip', requireAuth, wrap('Failed', async (req, res) => res.json(await coach.skipNudge({ tenantId: req.tenantId, nudgeId: req.params.nid }))));

module.exports = router;
