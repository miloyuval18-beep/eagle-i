process.env.CRM_PAYMENT_FEE_BPS = '50';
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const pb = require(R + '/lib/crmPlaybooks'); const est = require(R + '/lib/crmEstimates'); const pay = require(R + '/lib/crmPayments');
const calls = [];
const sessions = {};
// A fake Stripe that records what Eagle I asks it to do.
pay.setStripe({
  accounts: { create: async (a) => { calls.push(['acct', a]); return { id: 'acct_test123' }; }, retrieve: async (id) => ({ id, charges_enabled: true }) },
  accountLinks: { create: async (l) => { calls.push(['link', l]); return { url: 'https://connect.stripe.test/onboard' }; } },
  checkout: { sessions: {
    create: async (s, opts) => { calls.push(['session', s, opts]); const id = 'cs_' + Object.keys(sessions).length; sessions[id] = { id, metadata: s.metadata, amount_total: s.line_items[0].price_data.unit_amount, payment_status: 'unpaid', payment_method_types: s.payment_method_types, payment_intent: 'pi_1' }; return { id, url: 'https://checkout.stripe.test/' + id }; },
    retrieve: async (id, opts) => { calls.push(['retrieve', id, opts]); return sessions[id]; }
  } }
});
const sent = []; const send = async (m) => { sent.push(m); return { id: 'x' }; };
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Pay Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, address, email) VALUES ($1, '1001 S Dairy Ashford, Houston TX 77077', 'o@pay.test')`, [t]);
    // Connect the company's Stripe.
    const link = await pay.connectLink({ tenantId: t, email: 'o@pay.test', baseUrl: 'https://app.test' });
    assert.equal(link.url, 'https://connect.stripe.test/onboard');
    assert.equal(calls[0][1].type, 'express');
    assert.equal((await pay.refreshConnect(t)).ready, true);
    await pb.approvePlaybook({ tenantId: t, id: (await pb.listPlaybooks(t)).find(x => x.key === 'invoice_reminder').id });

    // Accepting an estimate with 10% at signing makes the deposit invoice, once.
    const deal = await crm.createDeal({ tenantId: t, name: 'Maria Garcia', email: 'maria@x.test', stage: 'proposal', ownerUserId: null });
    await query(`UPDATE crm_deals SET owner_user_id = NULL WHERE id = $1`, [deal.id]);
    const e = await est.createEstimate({ tenantId: t, dealId: deal.id });
    await est.saveEstimate({ tenantId: t, id: e.id, body: { title: 'Kitchen', deposit_pct: 10, lines: [{ description: 'Cabinets', quantity: 1, unit_cost: 40000, markup_pct: 25 }] } });
    await query(`UPDATE crm_estimates SET status = 'sent', sent_at = now() WHERE id = $1`, [e.id]);
    const token = (await est.getEstimate(t, e.id)).public_token;
    const view = await est.acceptByToken({ token, name: 'Maria Garcia' });
    assert.equal(view.depositInvoice.amount, 5000);
    assert.equal(view.depositInvoice.paid, false);
    await pay.depositForEstimate(e.id);
    const invs = await pay.listInvoices(t, { dealId: deal.id });
    assert.equal(invs.length, 1, 'one deposit invoice, even if asked twice');
    const inv = invs[0];
    assert.equal(inv.status, 'sent'); assert.equal(Number(inv.amount), 5000); assert.equal(inv.kind, 'deposit');

    // The homeowner pays online on the company's own account, with Eagle I's 0.5% fee.
    const pubToken = inv.public_token;
    assert.equal((await pay.publicInvoice(pubToken)).payOnline, true);
    const co = await pay.checkout({ token: pubToken, baseUrl: 'https://app.test' });
    const sessCall = calls.find(c => c[0] === 'session');
    assert.equal(sessCall[2].stripeAccount, 'acct_test123', 'charged on the company account');
    assert.equal(sessCall[1].line_items[0].price_data.unit_amount, 500000);
    assert.equal(sessCall[1].payment_intent_data.application_fee_amount, 2500);
    assert.deepEqual(sessCall[1].payment_method_types, ['card', 'us_bank_account']);
    // Coming back before Stripe says it's paid changes nothing.
    const sid = Object.keys(sessions)[0];
    assert.equal((await pay.confirmReturn({ token: pubToken, sessionId: sid })).status, 'sent');
    // A webhook from some other account can't mark it paid.
    sessions[sid].payment_status = 'paid';
    assert.equal((await pay.handleConnectEvent({ type: 'checkout.session.completed', account: 'acct_attacker', data: { object: sessions[sid] } })).handled, false);
    const back = await pay.confirmReturn({ token: pubToken, sessionId: sid });
    assert.equal(back.status, 'paid'); assert.equal(back.paidAmount, 5000);
    // The real webhook arriving too doesn't double-count.
    await pay.handleConnectEvent({ type: 'checkout.session.completed', account: 'acct_test123', data: { object: sessions[sid] } });
    const acts = (await crm.dealTimeline(t, deal.id)).activities.filter(a => /Paid invoice/.test(a.body));
    assert.equal(acts.length, 1, 'recorded once');
    const depTask = (await query(`SELECT done_at FROM crm_tasks WHERE tenant_id = $1 AND auto_key = $2`, [t, `${deal.id}:deposit`])).rows[0];
    assert.ok(depTask && depTask.done_at, '"Collect the deposit" ticked itself off');
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'payment' && /paid \$5,000\.00/.test(i.title)));

    // A progress invoice with a due date gets reminders, which stop when it's paid by check.
    const due = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const p2 = await pay.createInvoice({ tenantId: t, dealId: deal.id, kind: 'progress', title: 'Rough-in', amount: '12,500', dueDate: due });
    await pay.sendInvoice({ tenantId: t, id: p2.id, baseUrl: 'https://app.test', send });
    assert.match(sent[sent.length - 1].text, /\/i\/[0-9a-f]{48}/);
    let rem = (await query(`SELECT step, due_at FROM crm_playbook_sends WHERE invoice_id = $1 AND status = 'pending' ORDER BY step`, [p2.id])).rows;
    assert.equal(rem.length, 2);
    assert.equal(new Date(rem[0].due_at).getTime(), pb.invoiceDueAt(due).getTime() - 2 * 86400000);
    await pay.markPaid({ tenantId: t, id: p2.id, via: 'check', userId: null });
    rem = (await query(`SELECT COUNT(*)::int n FROM crm_playbook_sends WHERE invoice_id = $1 AND status = 'pending'`, [p2.id])).rows[0].n;
    assert.equal(rem, 0, 'reminders stop when paid');
    await assert.rejects(pay.markPaid({ tenantId: t, id: p2.id, via: 'cash' }), /already paid/);
    console.log('PAYMENT SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
