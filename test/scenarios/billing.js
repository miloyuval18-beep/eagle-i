// Plans and billing with a fake Stripe.
const { R } = require('./_local');
const assert = require('assert/strict');
const { query, pool } = require(R + '/db');
const b = require(R + '/lib/crmBilling');
const calls = [];
const prices = new Map();
const fake = {
  prices: { list: async ({ lookup_keys }) => ({ data: prices.has(lookup_keys[0]) ? [{ id: prices.get(lookup_keys[0]) }] : [] }), create: async (p) => { const id = 'price_' + prices.size; prices.set(p.lookup_key, id); calls.push(['price', p]); return { id }; } },
  products: { create: async (p) => { calls.push(['product', p]); return { id: 'prod_1' }; } },
  checkout: { sessions: { create: async (p) => { calls.push(['checkout', p]); return { url: 'https://checkout.test/s1' }; } } },
  billingPortal: { sessions: { create: async (p) => { calls.push(['portal', p]); return { url: 'https://portal.test/p1' }; } } },
  subscriptions: { retrieve: async (id) => ({ id, status: 'active', customer: 'cus_1', current_period_end: 2000000000, metadata: { product: 'crm', tenant_id: TENANT, plan: 'team' }, items: { data: [{ price: { metadata: { plan: 'team' } } }] } }) }
};
let TENANT;
(async () => {
  const t = TENANT = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Bill Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    // A new company is on a 14-day trial; nothing locks without billing switched on.
    let a = await b.accessFor(t);
    assert.equal(a.status, 'trialing'); assert.ok(a.trialDaysLeft >= 13); assert.equal(a.locked, false);
    await query(`UPDATE tenants SET crm_trial_ends_at = now() - interval '1 day' WHERE id = $1`, [t]);
    a = await b.accessFor(t);
    assert.equal(a.wouldLock, true); assert.equal(a.locked, false, 'not enforced: nobody is locked out');
    // Switched on: read-only after the trial.
    b.setStripe(fake); process.env.CRM_BILLING_ENFORCE = 'true';
    a = await b.accessFor(t);
    assert.equal(a.locked, true); assert.match(a.reason, /trial has ended/);
    // Checkout makes the Stripe price once and passes the plan along.
    const c1 = await b.checkout({ tenantId: t, plan: 'team', interval: 'year', baseUrl: 'https://x', email: 'o@bill.test' });
    assert.equal(c1.url, 'https://checkout.test/s1');
    const ck = calls.find(x => x[0] === 'checkout')[1];
    assert.equal(ck.client_reference_id, t); assert.equal(ck.subscription_data.metadata.plan, 'team'); assert.equal(ck.customer_email, 'o@bill.test');
    assert.equal(calls.find(x => x[0] === 'price')[1].unit_amount, 399000, '$3,990 a year (two months free)');
    await b.checkout({ tenantId: t, plan: 'team', interval: 'year', baseUrl: 'https://x' });
    assert.equal(calls.filter(x => x[0] === 'price').length, 1, 'the price is reused');
    await assert.rejects(b.checkout({ tenantId: t, plan: 'gold', baseUrl: 'https://x' }), /Pick a plan/);
    // Stripe says it's paid: active, unlocked.
    assert.equal(await b.handleEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: t, customer: 'cus_1', subscription: 'sub_1', metadata: { product: 'crm', plan: 'team' } } } }), true);
    a = await b.accessFor(t);
    assert.equal(a.status, 'active'); assert.equal(a.plan, 'team'); assert.equal(a.locked, false); assert.equal(a.seats, 10);
    assert.equal(await b.handleEvent({ type: 'checkout.session.completed', data: { object: { metadata: {} } } }), false, 'marketing events are left alone');
    // A failed payment: a 7-day grace, then read-only; fixed: back on.
    await b.handleEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'past_due', customer: 'cus_1', metadata: { product: 'crm', tenant_id: t, plan: 'team' } } } });
    a = await b.accessFor(t);
    assert.equal(a.status, 'past_due'); assert.equal(a.locked, false, 'grace period');
    await query(`UPDATE tenants SET crm_past_due_since = now() - interval '8 days' WHERE id = $1`, [t]);
    assert.equal((await b.accessFor(t)).locked, true);
    await b.handleEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { product: 'crm', tenant_id: t, plan: 'company' } } } });
    a = await b.accessFor(t);
    assert.equal(a.locked, false); assert.equal(a.plan, 'company');
    assert.equal((await query('SELECT crm_past_due_since FROM tenants WHERE id = $1', [t])).rows[0].crm_past_due_since, null);
    // Billing portal for the customer.
    assert.equal((await b.portal({ tenantId: t, baseUrl: 'https://x' })).url, 'https://portal.test/p1');
    // Seats: a Builder plan with 3 people can't invite a 4th.
    await b.handleEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { product: 'crm', tenant_id: t, plan: 'builder' } } } });
    for (const e of ['a@bill.test', 'b@bill.test', 'c@bill.test']) await query(`INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'member')`, [t, e]);
    await assert.rejects(b.checkSeat(t), /includes 3 people/);
    // Cancelled: read-only at once.
    await b.handleEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', metadata: { product: 'crm', tenant_id: t } } } });
    assert.equal((await b.accessFor(t)).locked, true);
    const o = await b.overview(t);
    assert.equal(o.plans.length, 3); assert.equal(o.plans.find(p => p.key === 'team').annual, 3990);
    console.log('BILLING SCENARIO PASSED');
  } finally { b.setStripe(null); delete process.env.CRM_BILLING_ENFORCE; await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
