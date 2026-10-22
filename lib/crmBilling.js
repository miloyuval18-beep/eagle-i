// Plans and billing for Eagle I CRM.
//
// Every company starts with a 14-day trial of everything. Plans differ by how
// many people can sign in and how much the assistant can be used each month;
// prices and names live here (and can be changed with env vars without a code
// change). Stripe Checkout takes the card, the Stripe billing portal handles
// changes and cancellations, and Stripe's webhook keeps the plan here in step.
// Stripe products and prices are created on first use (found again by lookup
// key), so nothing has to be set up in the Stripe dashboard first.
//
// Nothing is ever locked unless billing is switched on (STRIPE_SECRET_KEY and
// CRM_BILLING_ENFORCE=true). Then, after the trial (or 7 days past due), the
// CRM turns read-only until a plan is chosen: people can still see everything,
// and the automatic emails to homeowners keep going.
const { query } = require('../db');

const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
function plans() {
  return {
    builder: { key: 'builder', name: env('CRM_PLAN_BUILDER_NAME', 'Builder'), monthly: +env('CRM_PLAN_BUILDER_PRICE', 199), seats: +env('CRM_PLAN_BUILDER_SEATS', 3), aiMessages: 1500,
      blurb: 'For an owner and a small crew.', features: ['Up to 3 people', 'Every CRM feature', 'Ask Eagle I assistant'] },
    team: { key: 'team', name: env('CRM_PLAN_TEAM_NAME', 'Team'), monthly: +env('CRM_PLAN_TEAM_PRICE', 399), seats: +env('CRM_PLAN_TEAM_SEATS', 10), aiMessages: 5000, popular: true,
      blurb: 'For a growing design-build team.', features: ['Up to 10 people', 'Every CRM feature', 'More assistant use', 'Priority support'] },
    company: { key: 'company', name: env('CRM_PLAN_COMPANY_NAME', 'Company'), monthly: +env('CRM_PLAN_COMPANY_PRICE', 699), seats: +env('CRM_PLAN_COMPANY_SEATS', 1000), aiMessages: 20000,
      blurb: 'For established builders with several crews.', features: ['Everyone on your team', 'Every CRM feature', 'Highest assistant use', 'Help moving your data in'] }
  };
}
const TRIAL_DAYS = 14;
const GRACE_DAYS = 7;
const annualPrice = (p) => p.monthly * 10; // two months free

function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
let stripeOverride = null;
function setStripe(s) { stripeOverride = s; }
function stripe() {
  if (stripeOverride) return stripeOverride;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}
const enforcing = () => !!stripe() && process.env.CRM_BILLING_ENFORCE === 'true';

async function tenantBilling(tenantId) {
  return (await query(`SELECT id, company_name, crm_plan, crm_billing_status, crm_trial_ends_at, crm_period_end, crm_stripe_customer_id, crm_stripe_subscription_id, crm_past_due_since FROM tenants WHERE id = $1`, [tenantId])).rows[0];
}

// Pure: what this company can do right now.
function access(t, now = new Date(), enforce = enforcing()) {
  const status = t.crm_billing_status || 'trialing';
  const trialEnds = t.crm_trial_ends_at ? new Date(t.crm_trial_ends_at) : null;
  const daysLeft = trialEnds ? Math.max(0, Math.round((trialEnds - now) / 86400000)) : null; // round: a daylight-saving hour shouldn’t add a day
  let locked = false, reason = null;
  if (status === 'active') locked = false;
  else if (status === 'past_due') {
    const since = t.crm_past_due_since ? new Date(t.crm_past_due_since) : now;
    if (now - since > GRACE_DAYS * 86400000) { locked = true; reason = 'Your last payment didn’t go through. Update your card to keep making changes.'; }
  } else if (status === 'canceled') { locked = true; reason = 'Your plan was cancelled. Choose a plan to keep making changes.'; }
  else if (trialEnds && trialEnds < now) { locked = true; reason = 'Your free trial has ended. Choose a plan to keep making changes; everything you’ve entered is still here.'; }
  const p = plans()[t.crm_plan] || null;
  return { status, plan: p ? p.key : null, planName: p ? p.name : null, trialDaysLeft: status === 'trialing' ? daysLeft : null, locked: enforce && locked, wouldLock: locked, reason, seats: p ? p.seats : (status === 'trialing' ? plans().team.seats : null), aiMessages: p ? p.aiMessages : plans().team.aiMessages };
}

async function accessFor(tenantId, now = new Date()) {
  const t = await tenantBilling(tenantId);
  if (!t) return { locked: false };
  if (!t.crm_trial_ends_at && t.crm_billing_status === 'trialing') {
    await query(`UPDATE tenants SET crm_trial_ends_at = now() + make_interval(days => $2) WHERE id = $1 AND crm_trial_ends_at IS NULL`, [tenantId, TRIAL_DAYS]);
    t.crm_trial_ends_at = new Date(now.getTime() + TRIAL_DAYS * 86400000);
  }
  return access(t, now);
}

async function overview(tenantId) {
  const a = await accessFor(tenantId);
  const people = (await query('SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND disabled_at IS NULL', [tenantId])).rows[0].n;
  const used = await aiUsedThisMonth(tenantId);
  return {
    ...a, people, aiUsed: used, billingReady: !!stripe(), enforcing: enforcing(),
    plans: Object.values(plans()).map(p => ({ key: p.key, name: p.name, monthly: p.monthly, annual: annualPrice(p), seats: p.seats, blurb: p.blurb, features: p.features, popular: !!p.popular }))
  };
}

// A Stripe price for this plan and interval, made the first time it's needed.
async function priceFor(s, planKey, interval) {
  const p = plans()[planKey];
  if (!p) throw err('Pick a plan.');
  const lookup = `eaglei_crm_${planKey}_${interval}_${interval === 'year' ? annualPrice(p) : p.monthly}`;
  const found = await s.prices.list({ lookup_keys: [lookup], active: true, limit: 1 });
  if (found.data && found.data.length) return found.data[0].id;
  const product = await s.products.create({ name: `Eagle I CRM ${p.name}`, metadata: { product: 'crm', plan: planKey } });
  const price = await s.prices.create({ product: product.id, currency: 'usd', unit_amount: Math.round((interval === 'year' ? annualPrice(p) : p.monthly) * 100), recurring: { interval }, lookup_key: lookup, metadata: { product: 'crm', plan: planKey } });
  return price.id;
}

async function checkout({ tenantId, plan, interval = 'month', baseUrl, email = null }) {
  const s = stripe();
  if (!s) throw err('Billing isn’t set up on the server yet.', 503);
  if (!plans()[plan]) throw err('Pick a plan.');
  const iv = interval === 'year' ? 'year' : 'month';
  const t = await tenantBilling(tenantId);
  const price = await priceFor(s, plan, iv);
  const trialLeft = t.crm_billing_status === 'trialing' && t.crm_trial_ends_at && new Date(t.crm_trial_ends_at) - Date.now() > 2 * 86400000;
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: tenantId,
    ...(t.crm_stripe_customer_id ? { customer: t.crm_stripe_customer_id } : email ? { customer_email: email } : {}),
    metadata: { product: 'crm', tenant_id: tenantId, plan },
    subscription_data: { metadata: { product: 'crm', tenant_id: tenantId, plan }, ...(trialLeft ? { trial_end: Math.floor(new Date(t.crm_trial_ends_at).getTime() / 1000) } : {}) },
    allow_promotion_codes: true,
    success_url: `${baseUrl}/crm?billing=done#billing`,
    cancel_url: `${baseUrl}/crm#billing`
  });
  return { url: session.url };
}

async function portal({ tenantId, baseUrl }) {
  const s = stripe();
  if (!s) throw err('Billing isn’t set up on the server yet.', 503);
  const t = await tenantBilling(tenantId);
  if (!t.crm_stripe_customer_id) throw err('Choose a plan first.');
  const session = await s.billingPortal.sessions.create({ customer: t.crm_stripe_customer_id, return_url: `${baseUrl}/crm#billing` });
  return { url: session.url };
}

// Stripe tells us what happened (called from routes/stripe.js for CRM events).
async function handleEvent(event) {
  const o = event.data.object;
  const meta = o.metadata || {};
  if (event.type === 'checkout.session.completed') {
    if (meta.product !== 'crm' || !o.client_reference_id) return false;
    await query(`UPDATE tenants SET crm_stripe_customer_id = $2, crm_stripe_subscription_id = $3, crm_plan = $4 WHERE id = $1`, [o.client_reference_id, o.customer, o.subscription, meta.plan || null]);
    if (o.subscription && stripe()) await applySubscription(await stripe().subscriptions.retrieve(o.subscription));
    return true;
  }
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type)) {
    if (meta.product !== 'crm') return false;
    await applySubscription(o, event.type === 'customer.subscription.deleted');
    return true;
  }
  return false;
}
async function applySubscription(sub, deleted = false) {
  const meta = sub.metadata || {};
  const tenantId = meta.tenant_id;
  if (!tenantId) return;
  const map = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', incomplete: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };
  const status = deleted ? 'canceled' : map[sub.status] || 'past_due';
  const lookup = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.metadata;
  const plan = (lookup && lookup.plan) || meta.plan || null;
  await query(
    `UPDATE tenants SET crm_billing_status = $2::varchar, crm_plan = COALESCE($3::varchar, crm_plan), crm_stripe_subscription_id = $4, crm_stripe_customer_id = COALESCE($5::text, crm_stripe_customer_id),
       crm_period_end = $6, crm_past_due_since = CASE WHEN $2::text = 'past_due' THEN COALESCE(crm_past_due_since, now()) ELSE NULL END WHERE id = $1`,
    [tenantId, status, plan, sub.id, sub.customer || null, sub.current_period_end ? new Date(sub.current_period_end * 1000) : null]);
}

// ---------- limits ----------

async function aiUsedThisMonth(tenantId) {
  return (await query(`SELECT COUNT(*)::int AS n FROM crm_ai_messages m JOIN crm_ai_threads t ON t.id = m.thread_id
    WHERE t.tenant_id = $1 AND m.role = 'user' AND m.display IS NOT NULL AND m.created_at >= date_trunc('month', now())`, [tenantId])).rows[0].n;
}
async function checkSeat(tenantId) {
  if (!enforcing()) return;
  const a = await accessFor(tenantId);
  const people = (await query('SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1', [tenantId])).rows[0].n
    + (await query(`SELECT COUNT(*)::int AS n FROM crm_invites WHERE tenant_id = $1 AND accepted_at IS NULL AND expires_at > now()`, [tenantId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  if (a.seats && people >= a.seats) throw err(`Your ${a.planName || 'current'} plan includes ${a.seats} ${a.seats === 1 ? 'person' : 'people'}. Move to a bigger plan to add more.`, 402);
}
async function checkAi(tenantId) {
  if (!enforcing()) return;
  const a = await accessFor(tenantId);
  if (a.aiMessages && (await aiUsedThisMonth(tenantId)) >= a.aiMessages) throw err(`You’ve used this month’s ${a.aiMessages.toLocaleString('en-US')} assistant messages. It resets on the 1st, or move to a bigger plan.`, 402);
}

module.exports = { plans, TRIAL_DAYS, GRACE_DAYS, annualPrice, setStripe, enforcing, access, accessFor, overview, priceFor, checkout, portal, handleEvent, applySubscription, aiUsedThisMonth, checkSeat, checkAi };
