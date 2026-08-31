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
const leadsRoutes = require('./routes/leads');
const reviewsRoutes = require('./routes/reviews');
const adminRoutes = require('./routes/admin');
const permitsRoutes = require('./routes/permits');
const { sendCrashAlert } = require('./lib/alerting');

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

// Stripe requires the RAW body to verify webhook signatures, so this route
// must be mounted before express.json() parses (and consumes) the body.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// 2mb accommodates a base64-encoded logo upload (client caps the source file at 1MB).
app.use(express.json({ limit: '2mb' }));
// A malformed JSON body throws inside express.json() itself, before any
// route runs — without this it falls through to Express's default HTML
// error page, breaking the "every error is JSON" contract every route
// otherwise follows. This is a client mistake, not a server fault, so it
// isn't alerted on.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Malformed JSON in request body.' } });
  }
  next(err);
});
app.use(sessionMiddleware());

// Public, unauthenticated pages (login/signup/onboarding UI).
app.use(express.static(path.join(__dirname, 'public')));

registerAuthRoutes(app);
app.use(onboardingRoutes);
app.use(claudeRoutes);
app.use(socialRoutes);
app.use(leadsRoutes);
app.use(reviewsRoutes);
app.use(adminRoutes);
app.use(permitsRoutes);
app.use(stripeRoutes);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// The dashboard itself: not logged in -> /login.html; logged in but never
// finished onboarding -> /onboarding.html; otherwise serve the app.
app.get(['/', '/index.html'], async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login.html');
  }
  try {
    const result = await query(
      'SELECT generated_content FROM business_profile WHERE tenant_id = $1',
      [req.session.tenantId]
    );
    const onboarded = result.rows.length && Object.keys(result.rows[0].generated_content || {}).length > 0;
    if (!onboarded) return res.redirect('/onboarding.html');
  } catch (err) {
    console.error('Onboarding-status check failed:', err.message);
    // Fail open to the dashboard rather than locking someone out on a transient DB error.
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Everything else static (none of it should contain per-tenant secrets).
app.use(express.static(path.join(__dirname), { index: false }));

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
    if (!process.env[key]) console.warn(`WARNING: ${key} is not set.`);
  }
});
