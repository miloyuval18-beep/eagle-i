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
const scheduledPostsRoutes = require('./routes/scheduledPosts');
const { startScheduledPostsWorker } = require('./lib/scheduledPostsWorker');
const leadsRoutes = require('./routes/leads');
const reviewsRoutes = require('./routes/reviews');
const adminRoutes = require('./routes/admin');
const permitsRoutes = require('./routes/permits');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', true); // Render sits behind a proxy; needed for real client IPs + secure cookies

// Stripe requires the RAW body to verify webhook signatures, so this route
// must be mounted before express.json() parses (and consumes) the body.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// 2mb accommodates a base64-encoded logo upload (client caps the source file at 1MB).
app.use(express.json({ limit: '2mb' }));
app.use(sessionMiddleware());

// Public, unauthenticated pages (login/signup/onboarding UI).
app.use(express.static(path.join(__dirname, 'public')));

registerAuthRoutes(app);
app.use(onboardingRoutes);
app.use(claudeRoutes);
app.use(socialRoutes);
app.use(scheduledPostsRoutes);
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

app.listen(PORT, () => {
  console.log(`Eagle I server running at http://localhost:${PORT}`);
  for (const key of ['ANTHROPIC_API_KEY', 'DATABASE_URL', 'SESSION_SECRET', 'SOCIAL_CREDENTIALS_KEY', 'RESEND_API_KEY', 'GOOGLE_PLACES_API_KEY']) {
    if (!process.env[key]) console.warn(`WARNING: ${key} is not set.`);
  }
  startScheduledPostsWorker();
});
