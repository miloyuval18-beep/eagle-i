// Eagle I CRM accounts (lib/crmAccounts.js): creating one of the four kinds,
// signing in at /crm/login, a homeowner's or sub's own page (/crm/home),
// and, for the owner and admins, letting in people who asked to join.
const express = require('express');
const path = require('path');
const { requireAuth, deviceOf } = require('../auth');
const acc = require('../lib/crmAccounts');
const team = require('../lib/crmTeam');

const router = express.Router();
const { limit } = require('../lib/rateLimit');
const FIFTEEN = 15 * 60000;
// Tests make many accounts from one address; the limits only apply outside them.
const lim = (...a) => process.env.CRM_RATE_LIMITS === 'off' ? (req, res, next) => next() : limit(...a);
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
function fail(res, err, what) {
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };

// A fresh session for whoever signed in: a company login, or a homeowner/sub account.
function start(req, who) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => {
    if (e) return reject(e);
    if (who.as === 'staff') { req.session.userId = who.id; req.session.tenantId = who.tenantId; }
    else { req.session.accountId = who.id; req.session.accountKind = who.as; }
    req.session.device = deviceOf(req);
    // Saved before replying: after Google, the browser follows the redirect as
    // soon as it arrives, which could beat a save made at the end of the reply.
    req.session.save((e2) => (e2 ? reject(e2) : resolve()));
  }));
}
const whereTo = (as) => as === 'staff' ? '/crm' : '/crm/home';

// Signing in (also reached from /api/auth/login with app: 'crm').
async function crmLogin(req, res) {
  const { email, password, as } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: { message: 'Enter your email and password.' } });
  try {
    const r = await acc.signIn({ email, password, as: ['staff', 'homeowner', 'sub'].includes(as) ? as : null });
    if (r.choose) return res.json({ choose: r.choose });
    // Owners and admins on a device they haven't trusted: a code by email first.
    if (r.as === 'staff') {
      const u = await team.getUser(r.id);
      if (acc.needsTwoStep(u) && !(await acc.isTrusted(u.id, cookieOf(req, TRUST_COOKIE)))) {
        const sent = await acc.sendLoginCode(u.id).catch(e => { throw Object.assign(new Error(e.status === 429 ? e.message : 'We couldn’t email your sign-in code just now. Try again in a few minutes, or use “Sign in with Google”.'), { status: e.status || 503 }); });
        req.session.twoStep = { userId: u.id, tenantId: u.tenant_id, at: Date.now() };
        return res.json({ code: true, to: sent.to });
      }
    }
    await start(req, r);
    res.json({ ok: true, go: whereTo(r.as) });
  } catch (err) { fail(res, err, 'Sign-in failed'); }
}
// The code from the email (two-step sign-in); `remember` trusts this device for 30 days.
const TRUST_COOKIE = 'eagle_trust';
function cookieOf(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
router.post('/api/crm-auth/login/code', lim('code2', 20, FIFTEEN), wrap('Couldn’t check the code', async (req, res) => {
  const p = req.session && req.session.twoStep;
  if (!p || Date.now() - p.at > 15 * 60000) return res.status(400).json({ error: { message: 'That took too long. Sign in again.' } });
  const b = req.body || {};
  if (b.resend) return res.json({ ok: true, ...(await acc.sendLoginCode(p.userId)) });
  await acc.checkLoginCode(p.userId, b.code);
  const fresh = !b.remember;
  await start(req, { as: 'staff', id: p.userId, tenantId: p.tenantId });
  if (b.remember) {
    const token = await acc.trustDevice(p.userId, deviceOf(req).name);
    res.cookie(TRUST_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30 * 86400000, path: '/' });
  }
  require('../lib/crmAudit').log({ tenantId: p.tenantId, actor: { id: p.userId }, action: 'signed_in_new', detail: `${deviceOf(req).name}${fresh ? '' : ' (trusted for 30 days)'}` });
  res.json({ ok: true, go: '/crm' });
}));
router.post('/api/crm-auth/login', lim('login', 20, FIFTEEN, { byEmail: true }), crmLogin);

// { type: 'company' | 'join' | 'homeowner' | 'sub', ... }
router.post('/api/crm-auth/signup', lim('signup', 10, FIFTEEN), wrap('Couldn’t create the account', async (req, res) => {
  const b = req.body || {};
  if (!b.acceptedTerms) return res.status(400).json({ error: { message: 'Tick the box to agree to the Terms of Service and Privacy Policy.' } });
  const baseUrl = baseUrlOf(req);
  if (b.type === 'company') {
    const r = await acc.createCompany({ companyName: b.companyName, name: b.name, email: b.email, password: b.password, phone: b.phone, baseUrl });
    await start(req, { as: 'staff', id: r.user.id, tenantId: r.user.tenant_id });
    return res.json({ ok: true, go: '/crm' });
  }
  if (b.type === 'join') {
    const r = await acc.requestJoin({ code: b.code, name: b.name, email: b.email, password: b.password, note: b.note, baseUrl });
    if (r.pending) return res.json({ ok: true, pending: true, confirm: !!r.confirm, emailed: r.emailed !== false, companyName: r.companyName });
    await start(req, { as: 'staff', id: r.user.id, tenantId: r.user.tenant_id });
    return res.json({ ok: true, go: '/crm', companyName: r.companyName });
  }
  if (acc.KINDS.includes(b.type)) {
    const r = await acc.createAccount({ kind: b.type, name: b.name, email: b.email, password: b.password, phone: b.phone, businessName: b.businessName, trade: b.trade, baseUrl });
    await start(req, { as: b.type, id: r.account.id });
    return res.json({ ok: true, go: '/crm/home', emailed: r.emailed });
  }
  res.status(400).json({ error: { message: 'Pick what kind of account you need.' } });
}));

// "Continue with Google": the same Google sign-in Eagle I already uses for Gmail
// (same return address), so nothing new has to be set up at Google.
const redirectUri = (req) => process.env.GOOGLE_CRM_REDIRECT_URI || `${baseUrlOf(req)}/api/crm/google/oauth/callback`;
router.post('/api/crm-auth/google/start', lim('google', 30, FIFTEEN), wrap('Couldn’t start Google sign-in', async (req, res) => {
  const b = req.body || {};
  if (b.type !== 'signin' && !b.acceptedTerms) return res.status(400).json({ error: { message: 'Tick the box to agree to the Terms of Service and Privacy Policy.' } });
  res.json({ url: await acc.googleStart({ type: b.type, companyName: b.companyName, code: b.code, businessName: b.businessName, trade: b.trade, phone: b.phone, redirectUri: redirectUri(req) }) });
}));
// Mounted ahead of the CRM's sign-in check (routes/crm.js): a sign-up has no session yet.
async function googleCallback(req, res, next) {
  try { if (!(await acc.isSignupState(req.query.state))) return next(); } catch (e) { return next(); }
  try {
    const r = await acc.googleFinish({ code: req.query.code, state: req.query.state, error: req.query.error, redirectUri: redirectUri(req), baseUrl: baseUrlOf(req) });
    if (r.pending) return res.redirect('/crm/login?pending=' + encodeURIComponent(r.companyName));
    await start(req, r);
    res.redirect(whereTo(r.as));
  } catch (err) {
    res.redirect('/crm/login?google_error=' + encodeURIComponent(err.message));
  }
}

// "Join Levi Homes?" before they fill everything in.
router.get('/api/crm-auth/company-code', lim('code', 30, FIFTEEN), wrap('Couldn’t check the code', async (req, res) => {
  const t = await acc.companyForCode(req.query.code);
  if (!t) return res.status(404).json({ error: { message: 'That code doesn’t match a company. It looks like ABCD-2345; check it with whoever gave it to you.' } });
  res.json({ companyName: t.company_name, code: acc.tidyCode(req.query.code) });
}));

// The link in the "confirm your email" message for a join request: an
// invitation lets them in now; otherwise the owner and admins are asked.
router.get('/crm/join-confirm', async (req, res) => {
  try {
    const r = await acc.confirmJoin({ token: req.query.token, baseUrl: baseUrlOf(req) });
    if (!r) return res.redirect('/crm/login?google_error=' + encodeURIComponent('That link is old or was already used. Ask to join again with the company code.'));
    if (r.pending) return res.redirect('/crm/login?pending=' + encodeURIComponent(r.companyName) + '&confirmed=1');
    await start(req, { as: 'staff', id: r.user.id, tenantId: r.user.tenant_id });
    res.redirect('/crm');
  } catch (err) { res.redirect('/crm/login?google_error=' + encodeURIComponent(err.message)); }
});

// The link in the "confirm your email" message for homeowners and subs.
router.get('/crm/verify', wrap('Couldn’t confirm', async (req, res) => {
  const a = await acc.verifyAccount(req.query.token);
  res.redirect(a ? '/crm/home?confirmed=1' : '/crm/home?confirmed=0');
}));

// ---------- a homeowner's or sub's own page ----------

function account(req, res, next) {
  if (!req.session || !req.session.accountId) return res.status(401).json({ error: { message: 'Not signed in.' } });
  req.accountId = req.session.accountId;
  next();
}
router.get('/crm/home', (req, res) => {
  if (!req.session || !req.session.accountId) return res.redirect(req.session && req.session.userId ? '/crm' : '/crm/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'crm-home.html'));
});
router.get('/api/crm-account', account, wrap('Couldn’t load your account', async (req, res) => {
  const h = await acc.home(req.accountId, baseUrlOf(req));
  res.json(h);
}));
router.patch('/api/crm-account', account, wrap('Couldn’t save', async (req, res) => {
  const b = req.body || {};
  res.json({ account: await acc.saveProfile(req.accountId, b, { done: !!b.done }) });
}));
router.post('/api/crm-account/link', account, wrap('Couldn’t add it', async (req, res) => {
  res.json(await acc.linkByUrl(req.accountId, (req.body || {}).url));
}));
router.post('/api/crm-account/tips', account, wrap('Couldn’t save', async (req, res) => {
  res.json({ tips: await require('../lib/crmTips').update('crm_accounts', req.accountId, req.body || {}) });
}));
router.post('/api/crm-account/resend', account, wrap('Couldn’t send it', async (req, res) => {
  res.json(await acc.sendAccountVerify(req.accountId, baseUrlOf(req)));
}));
router.post('/api/crm-account/insurance', account, wrap('Couldn’t upload it', async (req, res) => {
  const b = req.body || {};
  res.json(await require('../lib/crmAccountFeatures').uploadInsurance({ accountId: req.accountId, filename: b.filename, dataBase64: b.dataBase64, expires: b.expires }));
}));
router.post('/api/crm-account/password', account, wrap('Couldn’t change it', async (req, res) => {
  await acc.changePassword({ accountId: req.accountId, current: (req.body || {}).current, password: (req.body || {}).password });
  res.json({ ok: true });
}));

// ---------- for the owner and admins: the company code and join requests ----------
// (/api/crm/* sits behind routes/crm.js's sign-in and company check.)

const managersOnly = team.need('team');
router.get('/api/crm/join-code', requireAuth, managersOnly, wrap('Couldn’t load the code', async (req, res) => {
  res.json({ code: await acc.joinCode(req.tenantId), requests: await acc.listJoinRequests(req.tenantId) });
}));
router.post('/api/crm/join-code/new', requireAuth, managersOnly, wrap('Couldn’t make a new code', async (req, res) => {
  res.json({ code: await acc.joinCode(req.tenantId, { fresh: true }) });
}));
router.post('/api/crm/join-requests/:id', requireAuth, managersOnly, wrap('Couldn’t save', async (req, res) => {
  const b = req.body || {};
  res.json(await acc.decideJoin({ tenantId: req.tenantId, actor: req.crmUser, id: req.params.id, approve: !!b.approve, role: b.role || 'member', reportsTo: b.reportsTo || null, baseUrl: baseUrlOf(req) }));
}));

// ---------- homeowner and sub accounts, from the company's side (lib/crmAccountFeatures.js) ----------
const feat = require('../lib/crmAccountFeatures');
router.get('/api/crm/account-features', requireAuth, wrap('Couldn’t load', async (req, res) => res.json({ features: await feat.features(req.tenantId), labels: feat.FEATURES })));
router.patch('/api/crm/account-features', requireAuth, team.need('settings'), wrap('Couldn’t save', async (req, res) => res.json({ features: await feat.setFeatures(req.tenantId, req.body || {}, req.crmUser) })));
router.get('/api/crm/deals/:id/account-invite', requireAuth, wrap('Couldn’t load', async (req, res) => res.json(await feat.inviteStatus({ tenantId: req.tenantId, dealId: req.params.id }))));
router.post('/api/crm/deals/:id/account-invite', requireAuth, wrap('Couldn’t send it', async (req, res) => res.json(await feat.sendInvite({ tenantId: req.tenantId, dealId: req.params.id, actor: req.crmUser, baseUrl: baseUrlOf(req) }))));
router.get('/api/crm/vendors/:id/account-invite', requireAuth, wrap('Couldn’t load', async (req, res) => res.json(await feat.inviteStatus({ tenantId: req.tenantId, vendorId: req.params.id }))));
router.post('/api/crm/vendors/:id/account-invite', requireAuth, team.need('subs'), wrap('Couldn’t send it', async (req, res) => res.json(await feat.sendInvite({ tenantId: req.tenantId, vendorId: req.params.id, actor: req.crmUser, baseUrl: baseUrlOf(req) }))));
router.get('/api/crm/vendors/:id/insurance', requireAuth, wrap('Couldn’t load', async (req, res) => res.json({ certificate: await feat.certificateFor({ tenantId: req.tenantId, vendorId: req.params.id }) })));
router.get('/api/crm/vendors/:id/insurance/file', requireAuth, wrap('Couldn’t load the file', async (req, res) => {
  const f = await feat.certificateFile({ tenantId: req.tenantId, vendorId: req.params.id });
  if (!f) return res.status(404).json({ error: { message: 'No certificate.' } });
  res.set({ 'Content-Type': f.content_type, 'Content-Disposition': `inline; filename="${String(f.filename).replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(f.data);
}));

// ---------- "Help me set up" and errors from people's screens ----------
router.post('/api/crm/help-request', requireAuth, lim('help', 5, 60 * 60000), wrap('Couldn’t send it', async (req, res) => {
  const b = req.body || {};
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const need = clip(b.need, 2000), phone = clip(b.phone, 40), when = clip(b.bestTime, 80);
  if (!phone && !need) return res.status(400).json({ error: { message: 'Add your phone number, or say what you need help with.' } });
  const { query } = require('../db');
  await query('INSERT INTO crm_help_requests (tenant_id, user_id, phone, best_time, need) VALUES ($1, $2, $3, $4, $5)', [req.tenantId, req.userId, phone || null, when || null, need || null]);
  const u = req.crmUser;
  const co = (await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId])).rows[0] || {};
  const { sendEmail } = require('../lib/email');
  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const to = process.env.ADMIN_ALERT_EMAIL || 'miloyuval18@gmail.com';
  await sendEmail({ to, subject: `🙋 Setup help: ${u.name || u.email} at ${co.company_name}`, replyTo: u.email,
    text: `${u.name || u.email} (${u.email}, ${u.role}) at ${co.company_name} wants help setting up.
Phone: ${phone || '—'}
Best time: ${when || '—'}

${need || ''}`,
    html: `<p style="font-size:16px"><b>${esc(u.name || u.email)}</b> (${esc(u.email)}, ${esc(u.role)}) at <b>${esc(co.company_name)}</b> wants help setting up.</p><p style="font-size:16px">Phone: ${esc(phone || '—')}<br>Best time: ${esc(when || '—')}</p><p style="font-size:16px;white-space:pre-wrap">${esc(need)}</p>` })
    .catch(e => console.warn('[help] not emailed:', e.message));
  sendEmail({ to: u.email, subject: 'We got your request for setup help', text: `Thanks${u.name ? ', ' + u.name.split(' ')[0] : ''}. Someone from Eagle I will call you${phone ? ' at ' + phone : ''}${when ? ' (' + when.toLowerCase() + ')' : ''}, usually within one business day.`,
    html: `<p style="font-size:18px">Thanks${u.name ? ', ' + esc(u.name.split(' ')[0]) : ''}. Someone from Eagle I will call you${phone ? ' at ' + esc(phone) : ''}${when ? ' (' + esc(when.toLowerCase()) + ')' : ''}, usually within one business day.</p>` }).catch(() => {});
  res.json({ ok: true });
}));
// Errors in someone's browser on the CRM (crm.html sends them).
router.post('/api/crm/client-error', requireAuth, lim('clienterr', 30, 60 * 60000), (req, res) => {
  const b = req.body || {};
  if (b.message) require('../lib/crmErrors').record({ source: 'browser', message: String(b.message), detail: [b.stack, b.agent ? 'Browser: ' + b.agent : ''].filter(Boolean).join('\n'), path: String(b.screen || ''), tenantId: req.tenantId, userId: req.userId }).catch(() => {});
  res.json({ ok: true });
});

// ---------- the quick way through setup (lib/crmQuickSetup.js) ----------
const quick = require('../lib/crmQuickSetup');
router.get('/api/crm/setup/company-lookup', requireAuth, team.need('settings'), wrap('Couldn’t look it up', async (req, res) => {
  res.json(await quick.lookup({ tenantId: req.tenantId, userId: req.userId }));
}));
router.get('/api/crm/setup/from-email', requireAuth, wrap('Couldn’t read your email', async (req, res) => {
  res.json({ ...(await quick.scan({ tenantId: req.tenantId, userId: req.userId, fresh: req.query.fresh === '1' })), canAddSubs: team.can(req.crmUser, 'subs') });
}));
router.post('/api/crm/setup/from-email', requireAuth, wrap('Couldn’t add them', async (req, res) => {
  const b = req.body || {};
  if ((b.subs || []).length && !team.can(req.crmUser, 'subs')) return res.status(403).json({ error: { message: team.denyText('subs') } });
  res.json(await quick.addFound({ tenantId: req.tenantId, userId: req.userId, customers: b.customers, subs: b.subs }));
}));
// { people: [{ name, email, role }] } or { text: 'one per line' }
router.post('/api/crm/team/invites/bulk', requireAuth, team.need('team'), wrap('Couldn’t send the invitations', async (req, res) => {
  const b = req.body || {};
  const people = Array.isArray(b.people) ? b.people : quick.parseList(b.text).map(p => ({ ...p, role: b.role || 'member' }));
  res.json(await quick.inviteMany({ tenantId: req.tenantId, actor: req.crmUser, people, baseUrl: baseUrlOf(req) }));
}));
router.get('/api/crm/setup/emails', requireAuth, team.need('emails'), wrap('Couldn’t load them', async (req, res) => res.json({ emails: await quick.recommended(req.tenantId) })));
router.post('/api/crm/setup/emails', requireAuth, team.need('emails'), wrap('Couldn’t turn them on', async (req, res) => res.json(await quick.turnOn({ tenantId: req.tenantId, ids: (req.body || {}).ids }))));

module.exports = router;
module.exports.crmLogin = (req, res) => lim('login', 20, FIFTEEN, { byEmail: true })(req, res, () => crmLogin(req, res));
module.exports.googleCallback = googleCallback;
