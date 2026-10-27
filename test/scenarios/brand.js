// A project under a company in the group (Levi Homes under Levi Construction
// Group): what the homeowner gets (emails, the estimate and invoice pages, the
// project page) carries Levi Homes' name, with the main company's address and
// contact details. A project not under a company keeps the main company's name.
const { R } = require('./_local');
const assert = require('assert/strict');
process.env.RESEND_API_KEY = 'test-only'; delete process.env.ANTHROPIC_API_KEY;
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm');
const subs = require(R + '/lib/crmSubsidiaries');
const est = require(R + '/lib/crmEstimates');
const pay = require(R + '/lib/crmPayments');
const portal = require(R + '/lib/crmPortal');
const tag = Date.now().toString(36);
const send = async (m) => { sent.push(m); return { id: 'x' }; };

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Group Brand Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, phone, address) VALUES ($1, 'office@group.test', '713-555-0100', '11777 Katy Fwy, Houston TX 77079')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', 'Olive', 'owner', 'crm') RETURNING id`, [t, `o.${tag}@group.test`])).rows[0].id;
    const lh = await subs.save({ tenantId: t, body: { name: 'Levi Homes', address: '999 Somewhere Else, Austin TX', phone: '512-000-0000', email: 'lh@else.test' } });
    const deal = await crm.createDeal({ tenantId: t, name: 'Rita Ruiz', email: `rita.${tag}@home.test`, title: 'Ruiz kitchen', userId: owner, subsidiaryId: lh.id });
    const plain = await crm.createDeal({ tenantId: t, name: 'Sam Lee', email: `sam.${tag}@home.test`, title: 'Lee bath', userId: owner });
    assert.equal(await subs.brandName(t, deal.id, 'Group Brand Co'), 'Levi Homes');
    assert.equal(await subs.brandName(t, plain.id, 'Group Brand Co'), 'Group Brand Co');
    const check = (m, name) => {
      assert.equal(m.fromName, name, 'sent in the project company’s name');
      const body = (m.html || '') + (m.text || '');
      assert.ok(body.includes(name), 'named in the email');
      assert.ok(!/Austin|512-000-0000|lh@else\.test/.test(body), 'never the company’s own address');
      assert.notEqual(m.replyTo, 'lh@else.test');
    };
    // The estimate: email and page.
    for (const [d, name] of [[deal, 'Levi Homes'], [plain, 'Group Brand Co']]) {
      const e = await est.createEstimate({ tenantId: t, dealId: d.id, userId: owner });
      await est.saveEstimate({ tenantId: t, id: e.id, body: { title: 'Work', lines: [{ description: 'Cabinets', quantity: 1, unit: 'ea', unit_cost: 1000, markup_pct: 20 }] } });
      sent.length = 0;
      await est.sendEstimate({ tenantId: t, id: e.id, baseUrl: 'https://app.test', send });
      check(sent[0], name);
      if (name === 'Levi Homes') assert.match(sent[0].html, /11777 Katy Fwy/, 'the main company’s address');
      const tok = (await query('SELECT public_token FROM crm_estimates WHERE id = $1', [e.id])).rows[0].public_token;
      const view = await est.getByToken(tok);
      assert.equal(view.view.company.name, name, 'the estimate page too');
    }
    // The invoice: email and page.
    const inv = await pay.createInvoice({ tenantId: t, dealId: deal.id, kind: 'progress', title: 'Rough-in', amount: 5000, userId: owner });
    sent.length = 0;
    await pay.sendInvoice({ tenantId: t, id: inv.id, baseUrl: 'https://app.test', send });
    check(sent[0], 'Levi Homes');
    const itok = (await query('SELECT public_token FROM crm_invoices WHERE id = $1', [inv.id])).rows[0].public_token;
    const iv = await pay.publicInvoice(itok);
    assert.equal(iv.company.name, 'Levi Homes'); assert.equal(iv.company.address, '11777 Katy Fwy, Houston TX 77079');
    // The project page and its link email.
    sent.length = 0;
    await portal.emailPortalLink({ tenantId: t, dealId: deal.id, baseUrl: 'https://app.test' });
    check(sent[0], 'Levi Homes'); assert.match(sent[0].subject, /Your project with Levi Homes/);
    const ptok = (await query('SELECT portal_token FROM crm_deals WHERE id = $1', [deal.id])).rows[0].portal_token;
    const pv = await portal.portalView(ptok);
    assert.equal(pv.company.name, 'Levi Homes'); assert.equal(pv.company.phone, '713-555-0100');
    console.log('BRAND SCENARIO PASSED');
  } catch (e) {
    console.error('BRAND SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
