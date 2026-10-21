// Invoices and online payment for Eagle I CRM (lib/crmPayments.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). The homeowner's pay page (/i/<token>) and
// /api/crm-public/invoices/* need no login: the long random token is the key.
// Stripe's webhook for connected accounts is handled by handleConnectWebhook,
// mounted in server.js before the JSON body parser (it needs the raw body).
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const pay = require('../lib/crmPayments');
const team = require('../lib/crmTeam');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;

function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  if (err.type && /^Stripe/.test(err.type)) return res.status(502).json({ error: { message: `Stripe: ${err.message}` } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
function managersOnly(req, res, next) {
  if (team.isManager(req.crmUser && req.crmUser.role)) return next();
  res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
}

// ---------- the company's Stripe account ----------

router.get('/api/crm/payments', requireAuth, async (req, res) => {
  try {
    let st = await pay.connectStatus(req.tenantId);
    if (st.accountId && !st.ready && req.query.refresh === '1') st = await pay.refreshConnect(req.tenantId);
    res.json(st);
  } catch (err) { fail(res, err, 'Failed to load payments'); }
});

router.post('/api/crm/payments/connect', requireAuth, managersOnly, async (req, res) => {
  try {
    const link = await pay.connectLink({ tenantId: req.tenantId, email: req.crmUser.email, baseUrl: baseUrlOf(req) });
    await require('../lib/crmAlerts').ownerAlert({ tenantId: req.tenantId, actorId: req.userId, title: 'Online payments are being set up', detail: 'Someone started connecting a bank account for card and bank payments on invoices.', key: `payments:${Math.floor(Date.now() / 86400000)}` }).catch(() => {});
    res.json(link);
  } catch (err) { fail(res, err, 'Failed to connect Stripe'); }
});

// ---------- invoices ----------

router.get('/api/crm/invoices', requireAuth, async (req, res) => {
  try { res.json({ invoices: await pay.listInvoices(req.tenantId, { dealId: req.query.dealId || null }), kinds: pay.KINDS }); } catch (err) { fail(res, err, 'Failed to load invoices'); }
});

router.post('/api/crm/deals/:id/invoices', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const inv = await pay.createInvoice({ tenantId: req.tenantId, dealId: req.params.id, kind: b.kind, title: b.title, amount: b.amount, dueDate: b.dueDate, note: b.note, userId: req.userId });
    res.json({ ok: true, invoice: inv });
  } catch (err) { fail(res, err, 'Failed to create the invoice'); }
});

router.post('/api/crm/invoices/:id/send', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await pay.sendInvoice({ tenantId: req.tenantId, id: req.params.id, userId: req.userId, baseUrl: baseUrlOf(req) })) }); }
  catch (err) {
    if (/RESEND_API_KEY/.test(err.message || '')) return res.status(503).json({ error: { message: 'Email sending is not set up on the server yet.' } });
    fail(res, err, 'Failed to send the invoice');
  }
});

router.post('/api/crm/invoices/:id/paid', requireAuth, async (req, res) => {
  const b = req.body || {};
  try { res.json({ ok: true, invoice: await pay.markPaid({ tenantId: req.tenantId, id: req.params.id, via: b.via, amount: b.amount, userId: req.userId }) }); } catch (err) { fail(res, err, 'Failed to record the payment'); }
});

router.post('/api/crm/invoices/:id/void', requireAuth, managersOnly, async (req, res) => {
  try { await pay.voidInvoice({ tenantId: req.tenantId, id: req.params.id, userId: req.userId }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to cancel the invoice'); }
});

// ---------- the homeowner's pay page ----------

router.get('/i/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'public', 'invoice.html'));
});

router.get('/api/crm-public/invoices/:token', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  try {
    const inv = req.query.session ? await pay.confirmReturn({ token: req.params.token, sessionId: req.query.session }) : await pay.publicInvoice(req.params.token);
    if (!inv) return res.status(404).json({ error: { message: 'This invoice link is not valid. Please contact the company that sent it.' } });
    res.json({ invoice: inv });
  } catch (err) { fail(res, err, 'Failed to load the invoice'); }
});

const hits = new Map();
router.post('/api/crm-public/invoices/:token/checkout', async (req, res) => {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter(t => now - t < 3600000);
  list.push(now); hits.set(req.ip, list);
  if (list.length > 20) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  try { res.json(await pay.checkout({ token: req.params.token, baseUrl: baseUrlOf(req) })); } catch (err) { fail(res, err, 'Failed to start the payment'); }
});

// Stripe → Eagle I, for payments on connected accounts. Needs the raw body.
async function handleConnectWebhook(req, res) {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) return res.status(503).send('Not configured.');
  let event;
  try {
    const Stripe = require('stripe');
    event = new Stripe(process.env.STRIPE_SECRET_KEY).webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    return res.status(400).send('Webhook signature verification failed.');
  }
  res.json({ received: true });
  pay.handleConnectEvent(event).catch(err => console.error('[crmPayments] webhook failed:', err.message));
}

module.exports = { router, handleConnectWebhook };
