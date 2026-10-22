// The homeowner's "Waiting for you" list (estimates, change orders, selections,
// invoices), a sub hearing their dates moved (only with notices switched on),
// error alerts that email once per problem, and the assistant never passing
// dollar figures to someone without "See money".
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
process.env.RESEND_API_KEY = 'test-only'; delete process.env.ANTHROPIC_API_KEY;
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm');
const feat = require(R + '/lib/crmAccountFeatures');
const errors = require(R + '/lib/crmErrors');
const team = require(R + '/lib/crmTeam');
const tag = Date.now().toString(36);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Extras Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address) VALUES ($1, 'office@extras.test', '1 Main St, Houston TX 77002')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', 'Olive', 'owner', 'crm') RETURNING *`, [t, `olive.${tag}@extras.test`])).rows[0];
    const email = `hana.${tag}@home.test`;
    const deal = await crm.createDeal({ tenantId: t, name: 'Hana', email, title: 'Hana bath', stage: 'production', userId: owner.id });
    const tok = crypto.randomBytes(24).toString('hex');
    await query(`UPDATE crm_deals SET portal_token = $2 WHERE id = $1`, [deal.id, tok]);
    // One of each thing a homeowner can be waiting on.
    await query(`INSERT INTO crm_estimates (tenant_id, deal_id, number, kind, title, status, total, public_token, sent_at) VALUES ($1, $2, 901, 'construction', 'Bath', 'sent', 18000, $3, now())`, [t, deal.id, crypto.randomBytes(24).toString('hex')]);
    await query(`INSERT INTO crm_change_orders (tenant_id, deal_id, number, title, amount, status, sent_at) VALUES ($1, $2, 902, 'Heated floor', 1200, 'sent', now())`, [t, deal.id]);
    await query(`INSERT INTO crm_selections (tenant_id, deal_id, category, options, due_date) VALUES ($1, $2, 'Tile', '[{"name":"White","price":10}]', CURRENT_DATE + 3)`, [t, deal.id]);
    await query(`INSERT INTO crm_invoices (tenant_id, deal_id, number, title, amount, status, due_date, public_token) VALUES ($1, $2, 903, 'Deposit', 5000, 'sent', CURRENT_DATE - 2, $3)`, [t, deal.id, crypto.randomBytes(24).toString('hex')]);
    await query(`INSERT INTO crm_invoices (tenant_id, deal_id, number, title, amount, status, public_token) VALUES ($1, $2, 904, 'Paid one', 100, 'paid', $3)`, [t, deal.id, crypto.randomBytes(24).toString('hex')]);
    const w = await feat.waitingFor([{ id: deal.id, url: `/p/${tok}`, builder: 'Extras Co', title: 'Hana bath' }]);
    assert.deepEqual(w.map(x => x.kind).sort(), ['change_order', 'estimate', 'invoice', 'selection']);
    assert.equal(w[0].kind, 'invoice', 'the overdue invoice comes first'); assert.equal(w[0].late, true);
    assert.match(w.find(x => x.kind === 'estimate').url, /^\/e\//); assert.equal(w.find(x => x.kind === 'change_order').url, `/p/${tok}`);
    assert.match(w.find(x => x.kind === 'change_order').detail, /Adds \$1,200/);

    // A sub with a confirmed account hears about new dates only once notices are on.
    const subEmail = `sam.${tag}@framing.test`;
    const v = (await query(`INSERT INTO crm_vendors (tenant_id, name, email) VALUES ($1, 'Sam Framing', $2) RETURNING id`, [t, subEmail])).rows[0];
    await query(`INSERT INTO crm_accounts (kind, email, password_hash, name, email_verified) VALUES ('sub', $1, 'x', 'Sam', true)`, [subEmail]);
    const item = (await query(`INSERT INTO crm_job_items (tenant_id, deal_id, title, start_date, end_date, vendor_id, position) VALUES ($1, $2, 'Framing', CURRENT_DATE + 5, CURRENT_DATE + 7, $3, 0) RETURNING *`, [t, deal.id, v.id])).rows[0];
    const jobs = require(R + '/lib/crmJobs');
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    sent.length = 0;
    await jobs.saveItem({ tenantId: t, dealId: deal.id, id: item.id, body: { title: 'Framing', startDate: day(9), endDate: day(11), vendorId: v.id, status: 'todo' } });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(sent.filter(m => m.to === subEmail).length, 0, 'off by default');
    await feat.setFeatures(t, { notices: true });
    await jobs.saveItem({ tenantId: t, dealId: deal.id, id: item.id, body: { title: 'Framing', startDate: day(12), endDate: day(13), vendorId: v.id, status: 'todo' } });
    await new Promise(r => setTimeout(r, 300));
    const n = sent.filter(m => m.to === subEmail);
    assert.equal(n.length, 1); assert.match(n[0].subject, /Framing on Hana bath is now/);
    await jobs.saveItem({ tenantId: t, dealId: deal.id, id: item.id, body: { title: 'Framing (renamed)', startDate: day(12), endDate: day(13), vendorId: v.id, status: 'todo' } });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(sent.filter(m => m.to === subEmail).length, 1, 'a rename isn’t a date change');

    // Errors: same problem (different ids) is one alert per 6 hours.
    assert.equal(errors.shape('Deal 123 failed for 9e39a534-5185-444e-a7d2-aa9d33ff6207'), errors.shape('Deal 456 failed for 1e39a534-5185-444e-a7d2-aa9d33ff6200'));
    sent.length = 0;
    const m1 = `Boom ${tag} 1`;
    const a1 = await errors.record({ source: 'server', message: m1, path: 'GET /api/crm/deals/1', userId: owner.id, tenantId: t });
    const a2 = await errors.record({ source: 'server', message: m1.replace(/1$/, '2'), path: 'GET /api/crm/deals/2', userId: owner.id, tenantId: t });
    assert.equal(a1.alerted, true); assert.equal(a2.alerted, false, 'told once');
    assert.equal(sent.length, 1); assert.match(sent[0].text, /Olive \(owner\) at Extras Co/);
    await query(`UPDATE crm_errors SET created_at = now() - interval '7 hours' WHERE message LIKE $1`, [`Boom ${tag}%`]);
    assert.equal((await errors.record({ source: 'server', message: m1, path: 'GET /api/crm/deals/3' })).alerted, true, 'and again if it’s still happening hours later');
    assert.match(sent[1].text, /It has happened 3 times/);

    // The assistant: no dollar figures for someone without "See money".
    const sup = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', 'Sue', 'superintendent', 'crm') RETURNING *`, [t, `sue.${tag}@extras.test`])).rows[0];
    const A = require(R + '/lib/crmAssistant');
    const ctx = { tenantId: t, userId: sup.id, name: 'Sue', role: 'superintendent', manager: false, perms: team.permsOf(sup), baseUrl: 'https://app.test' };
    const prompt = await A.systemPrompt(ctx);
    assert.match(prompt, /isn't allowed to see money/);
    const home = await A.home(ctx);
    assert.equal(home.glance.openValue, null); assert.equal(home.glance.overdueInvoices, null);
    const got = team.hideMoney(await A.TOOLS.get_deal.run(ctx, { deal_id: deal.id }));
    assert.ok(!/18000|5000|1200/.test(JSON.stringify(got)), 'no figures in what the assistant sees');
    console.log('EXTRAS SCENARIO PASSED');
  } catch (e) {
    console.error('EXTRAS SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM crm_accounts WHERE email LIKE $1', [`%${tag}%`]).catch(() => {});
    await query('DELETE FROM crm_errors WHERE message LIKE $1', [`Boom ${tag}%`]).catch(() => {});
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
