// Eagle I — multi-tenant server. Auth (auth.js) gates everything except the
// public login/signup/onboarding pages and the Stripe webhook. Business
// logic lives in routes/*; this file just wires it together.

const express = require('express');
const path = require('path');

const { sessionMiddleware, registerAuthRoutes } = require('./auth');
const { query } = require('./db');
const claudeRoutes = require('./routes/claude');
const onboardingRoutes = require('./routes/onboarding');
const { router: socialRoutes } = require('./routes/social');
const { router: stripeRoutes, handleWebhook } = require('./routes/stripe');
const { handleInboundWebhook } = require('./routes/inboundEmail');
const leadsRoutes = require('./routes/leads');
const reviewsRoutes = require('./routes/reviews');
const adminRoutes = require('./routes/admin');
const permitsRoutes = require('./routes/permits');
const signalsRoutes = require('./routes/signals');
const imagesRoutes = require('./routes/images');
const adsRoutes = require('./routes/ads');
const { router: gbpRoutes } = require('./routes/gbp');
const searchConsoleRoutes = require('./routes/searchConsole');
const lsaReadinessRoutes = require('./routes/lsaReadiness');
const scheduledPostsRoutes = require('./routes/scheduledPosts');
const partnersRoutes = require('./routes/partners');
const websiteCheckupRoutes = require('./routes/websiteCheckup');
const jobsRoutes = require('./routes/jobs');
const tbaeRoutes = require('./routes/tbaeRegistrants');
const tdlrRoutes = require('./routes/tdlrRegistrants');
const tsbpeRoutes = require('./routes/tsbpeRegistrants');
const tbpelsRoutes = require('./routes/tbpelsRegistrants');
const trecRoutes = require('./routes/trecRegistrants');
const tdiRoutes = require('./routes/tdiRegistrants');
const tdaRoutes = require('./routes/tdaRegistrants');
const tdiAgenciesRoutes = require('./routes/tdiAgencies');
const comptrollerTradesRoutes = require('./routes/comptrollerTrades');
const vendorDirectoryRoutes = require('./routes/vendorDirectory');
const unsubscribeRoutes = require('./routes/unsubscribe');
const outreachInsightsRoutes = require('./routes/outreachInsights');
const leadSequenceRoutes = require('./routes/leadSequence');
const customersRoutes = require('./routes/customers');
const workWithUsRoutes = require('./routes/workWithUs');
const sendingDomainRoutes = require('./routes/sendingDomain');
const photoRequestsRoutes = require('./routes/photoRequests');
const redditLeadsRoutes = require('./routes/redditLeads');
const crmRoutes = require('./routes/crm');
const crmEstimateRoutes = require('./routes/crmEstimates');
const crmIntakeRoutes = require('./routes/crmIntake');
const crmGoogleRoutes = require('./routes/crmGoogle');
const crmReportRoutes = require('./routes/crmReports');
const crmPortalRoutes = require('./routes/crmPortal');
const { router: crmPaymentRoutes, handleConnectWebhook } = require('./routes/crmPayments');
const crmJobRoutes = require('./routes/crmJobs');
const crmCostRoutes = require('./routes/crmCosts');
const crmQualifyRoutes = require('./routes/crmQualify');
const crmLifetimeRoutes = require('./routes/crmLifetime');
const crmMarketingRoutes = require('./routes/crmMarketing');
const crmAssistRoutes = require('./routes/crmAssist');
const crmDrawsPulseRoutes = require('./routes/crmDrawsPulse');
const crmDailyRoutes = require('./routes/crmDaily');
const crmSubsRoutes = require('./routes/crmSubs');
const crmAssistantRoutes = require('./routes/crmAssistant');
const crmCheckinRoutes = require('./routes/crmCheckins');
const crmBillingRoutes = require('./routes/crmBilling');
const crmCoachRoutes = require('./routes/crmCoach');
const crmAiPlusRoutes = require('./routes/crmAiPlus');
const crmSubPortalRoutes = require('./routes/crmSubPortal');
const crmCalendarRoutes = require('./routes/crmCalendar');
const crmTrashRoutes = require('./routes/crmTrash');
const { sendCrashAlert } = require('./lib/alerting');
const { startWeatherSignalPoller } = require('./lib/weatherSignals');
const { startScheduledPostsWorker } = require('./lib/scheduledPostsWorker');
const { startCompetitorRatingWorker } = require('./lib/competitorRatingWorker');
const { startRedditPollWorker } = require('./lib/redditPollWorker');
const { startTbaeRosterWorker } = require('./lib/tbaeRosterWorker');
const { startTdlrRosterWorker } = require('./lib/tdlrRosterWorker');
const { startTsbpeRosterWorker } = require('./lib/tsbpeRosterWorker');
const { startTbpelsRosterWorker } = require('./lib/tbpelsRosterWorker');
const { startTrecRosterWorker } = require('./lib/trecRosterWorker');
const { startTdiRosterWorker } = require('./lib/tdiRosterWorker');
const { startTdaRosterWorker } = require('./lib/tdaRosterWorker');
const { startTdiAgenciesWorker } = require('./lib/tdiAgenciesWorker');
const { startComptrollerTradesWorker } = require('./lib/comptrollerTradesWorker');
const { startFollowUpWorker } = require('./lib/followUpWorker');
const { startFdicBanksWorker } = require('./lib/fdicBanksWorker');
const { startCslbRosterWorker } = require('./lib/cslbRosterWorker');
const { startDreRosterWorker } = require('./lib/dreRosterWorker');

// Last-resort safety net: anything that escapes every route's own try/catch
// (a genuine bug, not a "service not configured" 4xx) gets emailed to the
// admin instead of silently vanishing into Render's logs. Not a substitute
// for real uptime monitoring — see the "safety nets" note in project memory.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  sendCrashAlert('Uncaught exception', err.message, err.stack || '')
    .finally(() => process.exit(1)); // process state is unreliable after this — let Render restart it
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '';
  console.error('Unhandled promise rejection:', reason);
  sendCrashAlert('Unhandled promise rejection', message, stack);
});

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', true); // Render sits behind a proxy; needed for real client IPs + secure cookies

// Pages opened on Render's own name (*.onrender.com, from older emails) or www
// go to https://myeaglei.com: Google sign-in only works there, and that's where
// people are signed in. Health checks, webhooks and API calls are left alone.
app.use((req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  const { RENDER_HOST, CANONICAL } = require('./lib/appUrl');
  if ((RENDER_HOST.test(host) || host === 'www.myeaglei.com') && ['GET', 'HEAD'].includes(req.method) && !/^\/(api|healthz)(\/|$)/.test(req.path)) return res.redirect(301, CANONICAL + req.originalUrl);
  next();
});

// Stripe requires the RAW body to verify webhook signatures, so this route
// must be mounted before express.json() parses (and consumes) the body.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleWebhook);
// Same requirement for Resend's inbound-email webhook signature (svix).
app.post('/api/webhooks/resend-inbound', express.raw({ type: 'application/json' }), handleInboundWebhook);
// Eagle I CRM: payments on companies' own Stripe accounts (Stripe Connect). Same raw-body need.
app.post('/api/stripe/connect-webhook', express.raw({ type: 'application/json' }), handleConnectWebhook);

// 12mb accommodates a base64-encoded post image (routes/images.js caps the
// raw file at 8MB; base64 adds ~33% overhead on top of that, plus a little
// JSON envelope — 8MB raw comes to ~10.9MB encoded).
app.use(express.json({ limit: '12mb' }));
// A malformed JSON body throws inside express.json() itself, before any
// route runs — without this it falls through to Express's default HTML
// error page, breaking the "every error is JSON" contract every route
// otherwise follows. This is a client mistake, not a server fault, so it
// isn't alerted on.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Malformed JSON in request body.' } });
  }
  // Too big to accept (an upload over the limit): a plain answer, not a server error.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'That file is too big. Files can be up to 8 MB: take a smaller photo, or save it as a PDF.' } });
  }
  next(err);
});
app.use(sessionMiddleware());

// Public, unauthenticated pages (login/signup/onboarding UI).
app.use(express.static(path.join(__dirname, 'public')));

// Every server error a real person hits is kept and emailed (lib/crmErrors.js).
app.use(require('./lib/crmErrors').middleware());
registerAuthRoutes(app);
// Team members invited to Eagle I CRM use only the CRM. The marketing product's
// API is for the company owner, so everything outside /api/crm and /api/auth
// is closed to them.
app.use('/api', async (req, res, next) => {
  if (!req.session || !req.session.userId || req.path.startsWith('/crm') || req.path.startsWith('/auth')) return next();
  try {
    const r = await query('SELECT role, app FROM users WHERE id = $1', [req.session.userId]);
    if (r.rows.length && ((r.rows[0].role && r.rows[0].role !== 'owner') || r.rows[0].app === 'crm')) {
      return res.status(403).json({ error: { message: 'Your login is for Eagle I CRM only.' } });
    }
    next();
  } catch (err) {
    next(err);
  }
});
app.use(onboardingRoutes);
app.use(claudeRoutes);
app.use(socialRoutes);
app.use(leadsRoutes);
app.use(reviewsRoutes);
app.use(adminRoutes);
app.use(permitsRoutes);
app.use(signalsRoutes);
app.use(imagesRoutes);
app.use(adsRoutes);
app.use(gbpRoutes);
app.use(searchConsoleRoutes);
app.use(lsaReadinessRoutes);
app.use(scheduledPostsRoutes);
app.use(partnersRoutes);
app.use(websiteCheckupRoutes);
app.use(jobsRoutes);
app.use(tbaeRoutes);
app.use(tdlrRoutes);
app.use(tsbpeRoutes);
app.use(tbpelsRoutes);
app.use(trecRoutes);
app.use(tdiRoutes);
app.use(tdaRoutes);
app.use(tdiAgenciesRoutes);
app.use(comptrollerTradesRoutes);
app.use(vendorDirectoryRoutes);
app.use(unsubscribeRoutes);
app.use(outreachInsightsRoutes);
app.use(leadSequenceRoutes);
app.use(customersRoutes);
app.use(workWithUsRoutes);
app.use(sendingDomainRoutes);
app.use(photoRequestsRoutes);
app.use(redditLeadsRoutes);
// CRM answers are live business data (and the homeowner's private pages):
// never let a browser or proxy show a stale copy.
app.use(['/api/crm', '/api/crm-public'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// A homeowner's page in Spanish (header X-Lang: es) gets its error messages in Spanish.
app.use('/api/crm-public', (req, res, next) => {
  if (String(req.get('x-lang') || '').toLowerCase() !== 'es') return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && body.error && typeof body.error.message === 'string') body = { ...body, error: { ...body.error, message: require('./lib/crmSpanish').translateError('es', body.error.message) } };
    return json(body);
  };
  next();
});
app.use(crmRoutes);
app.use(crmEstimateRoutes); // after crmRoutes: their /api/crm/* routes rely on that sign-in check
app.use(crmIntakeRoutes);
app.use(crmGoogleRoutes);
app.use(crmReportRoutes);
app.use(crmPortalRoutes);
app.use(crmPaymentRoutes);
app.use(crmJobRoutes);
app.use(crmCostRoutes);
app.use(crmQualifyRoutes);
app.use(crmLifetimeRoutes);
app.use(crmMarketingRoutes);
app.use(crmAssistRoutes);
app.use(crmDrawsPulseRoutes);
app.use(crmDailyRoutes);
app.use(crmSubsRoutes);
app.use(crmAssistantRoutes);
app.use(crmCheckinRoutes);
app.use(crmBillingRoutes);
app.use(crmCoachRoutes);
app.use(crmAiPlusRoutes);
app.use(crmSubPortalRoutes);
app.use(crmCalendarRoutes);
app.use(crmTrashRoutes);
app.use(require('./routes/crmAccounts')); // after crmRoutes: its /api/crm/* routes rely on that sign-in check
app.use(stripeRoutes);

// Which build is live (Render sets RENDER_GIT_COMMIT), so a deploy can be checked from outside.
app.get('/healthz', (req, res) => res.json({ ok: true, version: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null }));

// Eagle I CRM: a separate product with its own app, login and signup.
// /crm is Levi Construction Group's portfolio (public/crm-portfolio.html): each
// company in the group, with a button into that company's CRM. The CRM itself is
// /crm/app. Older links (/crm#needs, /crm?google=…) still open the app: the page
// forwards anything after # and the server forwards anything after ?.
app.get(['/crm', '/crm/'], (req, res) => {
  if (Object.keys(req.query || {}).length) return res.redirect('/crm/app' + req.originalUrl.slice(req.originalUrl.indexOf('?')));
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'crm-portfolio.html'));
});
// One company in the group: signed in, the CRM opens on its profile; otherwise the sign-in page, which then does.
app.get('/crm/c/:slug', async (req, res) => {
  try {
    const subs = require('./lib/crmSubsidiaries');
    const p = await subs.portfolio();
    const slug = String(req.params.slug).toLowerCase().slice(0, 60);
    if (!p.group || !p.companies.some(c => c.slug === slug)) return res.redirect('/crm');
    if (req.session && req.session.userId && req.session.tenantId === p.tenantId) return res.redirect('/crm/app#co/' + slug);
    if (req.session && req.session.userId && ((await query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId])).rows[0] || {}).is_admin) {
      if (req.session.viewAs !== p.tenantId) {
        req.session.viewAs = p.tenantId; req.session.viewMode = 'view';
        await require('./lib/crmAudit').log({ tenantId: p.tenantId, actor: null, action: 'settings', detail: 'The Eagle I admin looked at the CRM (view only)' }).catch(() => {});
      }
      return res.redirect('/crm/app#co/' + slug);
    }
    let other = '';
    if (req.session && req.session.userId) other = ((await query(`SELECT t.company_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.app <> 'marketing'`, [req.session.userId])).rows[0] || {}).company_name || '';
    res.redirect(`/crm/login?co=${encodeURIComponent(slug)}${other ? '&other=' + encodeURIComponent(other) : ''}`);
  } catch (err) { console.error('CRM company link failed:', err.message); res.redirect('/crm/login'); }
});
// The portfolio's contents: the group and its companies (public: what's on their websites).
app.get('/api/crm-portfolio', async (req, res) => {
  try { const p = await require('./lib/crmSubsidiaries').portfolio(); res.json({ group: p.group, companies: p.companies.map(({ id, ...c }) => c) }); }
  catch (err) { res.status(500).json({ error: { message: 'Could not load the companies.' } }); }
});
// A company's name for its sign-in page.
app.get('/api/crm-portfolio/:slug', async (req, res) => {
  const p = await require('./lib/crmSubsidiaries').portfolio().catch(() => ({ companies: [] }));
  const c = p.companies.find(x => x.slug === String(req.params.slug).toLowerCase());
  if (!c) return res.status(404).json({ error: { message: 'Not found.' } });
  res.json({ name: c.name });
});
app.get(['/crm/app', '/crm/app/'], async (req, res) => {
  // Homeowners and subs have their own page; marketing logins are separate from the CRM's.
  if (req.session && !req.session.userId && req.session.accountId) return res.redirect('/crm/home');
  if (!req.session || !req.session.userId) return res.redirect('/crm/login');
  try {
    const u = (await query(`SELECT u.app, u.is_admin, ('crm' = ANY(t.products)) AS crm FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [req.session.userId])).rows[0];
    if (!u) return res.redirect('/crm/login');
    // The Eagle I admin has no CRM company of their own: they pick one to look at.
    if (u.is_admin && !req.session.viewAs && !u.crm) return res.redirect('/admin');
    if (u.app === 'marketing' && !(req.session.viewAs && u.is_admin)) return res.redirect('/crm/login?marketing=1');
  } catch (err) { console.error('CRM login check failed:', err.message); }
  // Always check for a newer copy, so a deploy's page never runs against an older or newer server.
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'crm.html'));
});
// The Eagle I admin's page (routes/admin.js): every CRM company, each viewable read-only.
app.get(['/admin', '/admin/'], async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login.html');
  const u = (await query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]).catch(() => ({ rows: [] }))).rows[0];
  if (!u || !u.is_admin) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/crm/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'crm-login.html')));
app.get('/crm/join', (req, res) => res.sendFile(path.join(__dirname, 'public', 'crm-join.html')));

// The homepage: pick Eagle I CRM or Eagle I Marketing (public/home.html).
// Coming back from connecting Facebook, Google Ads and the rest (/?ads_connected=…): that's the marketing dashboard.
app.get('/', (req, res) => {
  if (Object.keys(req.query || {}).length) return res.redirect('/marketing' + req.originalUrl.slice(1));
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});
// Eagle I Marketing's dashboard: not logged in -> /login.html; logged in but never
// finished onboarding -> /onboarding.html; otherwise serve the app.
app.get(['/marketing', '/marketing/', '/index.html'], async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login.html');
  }
  try {
    const result = await query(
      `SELECT bp.generated_content, t.products, u.role, u.app FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id
       LEFT JOIN users u ON u.id = $2 WHERE t.id = $1`,
      [req.session.tenantId, req.session.userId]
    );
    // A CRM-only company has no marketing dashboard, and team members invited
    // to the CRM only use the CRM: send them to its own app.
    if (result.rows.length && ((Array.isArray(result.rows[0].products) && !result.rows[0].products.includes('marketing')) || (result.rows[0].role && result.rows[0].role !== 'owner') || result.rows[0].app === 'crm')) {
      return res.redirect('/crm/app');
    }
    const onboarded = result.rows.length && Object.keys(result.rows[0].generated_content || {}).length > 0;
    if (!onboarded) return res.redirect('/onboarding.html');
  } catch (err) {
    console.error('Onboarding-status check failed:', err.message);
    // Fail open to the dashboard rather than locking someone out on a transient DB error.
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Nothing else from the project folder is served: the pages above have their
// own routes and public/ holds the rest. (Serving the folder itself exposed the
// server's source code, migrations and config to anyone who asked.)

// Last-resort handler for any route that calls next(err) instead of handling
// its own error (every route in this codebase currently self-handles via
// try/catch, so this mainly guards future code) — alerts the admin and
// returns clean JSON instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  sendCrashAlert('Unhandled route error', err.message, `${req.method} ${req.originalUrl}\n${err.stack || ''}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: { message: 'Internal server error.' } });
});

app.listen(PORT, () => {
  console.log(`Eagle I server running at http://localhost:${PORT}`);
  for (const key of ['ANTHROPIC_API_KEY', 'DATABASE_URL', 'SESSION_SECRET', 'SOCIAL_CREDENTIALS_KEY', 'RESEND_API_KEY', 'GOOGLE_PLACES_API_KEY']) {
    // RESEND_INBOUND_DOMAIN/RESEND_WEBHOOK_SECRET are deliberately not in
    // this list — both are optional (reply-capture degrades gracefully to
    // reply-straight-to-the-tenant without them, see routes/inboundEmail.js).
    if (!process.env[key]) console.warn(`WARNING: ${key} is not set.`);
  }
  startWeatherSignalPoller();
  startScheduledPostsWorker();
  startCompetitorRatingWorker();
  startRedditPollWorker();
  startTbaeRosterWorker();
  startTdlrRosterWorker();
  startTsbpeRosterWorker();
  startTbpelsRosterWorker();
  startTrecRosterWorker();
  startTdiRosterWorker();
  startTdaRosterWorker();
  startTdiAgenciesWorker();
  startComptrollerTradesWorker();
  startFollowUpWorker();
  require('./lib/crmHealth').startHealthWatch();
  startFdicBanksWorker();
  startCslbRosterWorker();
  startDreRosterWorker();
});
