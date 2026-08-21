// Stripe Checkout + webhook skeleton (Phase 1 scope — see the plan file for
// what's deferred to Phase 2: Customer Portal, plan changes, dunning).
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// price_id -> { tier, cap } — keeps the webhook from trusting client input
// for what plan/cap a payment should grant.
const PLAN_BY_PRICE_ID = {}; // populated lazily below once env vars are read
function loadPlanMap() {
  if (process.env.STRIPE_PRICE_STARTER) {
    PLAN_BY_PRICE_ID[process.env.STRIPE_PRICE_STARTER] = { tier: 'starter', cap: 300 };
  }
  if (process.env.STRIPE_PRICE_PRO) {
    PLAN_BY_PRICE_ID[process.env.STRIPE_PRICE_PRO] = { tier: 'pro', cap: 1200 };
  }
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  // Lazy require so the app still boots without the stripe package configured.
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

router.post('/api/stripe/create-checkout-session', requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(500).json({ error: { message: 'Billing is not configured yet.' } });

  const { priceId } = req.body || {};
  loadPlanMap();
  if (!priceId || !PLAN_BY_PRICE_ID[priceId]) {
    return res.status(400).json({ error: { message: 'Unknown price.' } });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: req.tenantId,
      success_url: `${req.protocol}://${req.get('host')}/?billing=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/?billing=cancelled`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create checkout session: ' + err.message } });
  }
});

// Mounted separately in server.js with express.raw() (Stripe requires the
// raw request body, unparsed, to verify the webhook signature).
async function handleWebhook(req, res) {
  const stripe = getStripe();
  if (!stripe) return res.status(500).send('Billing not configured.');

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  loadPlanMap();

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const tenantId = session.client_reference_id;
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = subscription.items.data[0]?.price?.id;
      const plan = PLAN_BY_PRICE_ID[priceId];

      if (tenantId && plan) {
        await query(
          `UPDATE tenants SET plan_tier = $1, monthly_generation_cap = $2,
             stripe_customer_id = $3, stripe_subscription_id = $4
           WHERE id = $5`,
          [plan.tier, plan.cap, session.customer, session.subscription, tenantId]
        );
      }
    }
    // customer.subscription.deleted / updated (downgrades, cancellations) is Phase 2.
    res.json({ received: true });
  } catch (err) {
    res.status(500).send(`Webhook handling failed: ${err.message}`);
  }
}

module.exports = { router, handleWebhook };
