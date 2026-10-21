// Bugs found in the full-CRM test pass, kept fixed.
const { R } = require('./_local');
const assert = require('assert/strict');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const E = require(R + '/lib/crmEstimates'); const jobs = require(R + '/lib/crmJobs');
const bids = require(R + '/lib/crmBids'); const pulse = require(R + '/lib/crmPulse'); const portal = require(R + '/lib/crmPortal'); const portalAi = require(R + '/lib/crmPortalAi');
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Reg Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address) VALUES ($1, 'o@reg.test', '1 Main St, Houston TX 77002')`, [t]);
    const u = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'o@reg.test', 'x', 'Owner', 'owner') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Pat Lee', email: 'pat@reg.test', address: '55 Elm St, Houston TX 77007', title: 'Bath', value: 35000, userId: u });

    // 1. Accepting a construction estimate makes its price the contract (the lead-stage guess is replaced).
    const est = await E.createEstimate({ tenantId: t, dealId: deal.id, userId: u });
    await E.saveEstimate({ tenantId: t, id: est.id, body: { title: 'Bath', kind: 'construction', default_markup_pct: 20, lines: [{ description: 'Tile', quantity: 100, unit: 'sf', unit_cost: 20 }] } });
    await query(`UPDATE crm_estimates SET status = 'sent', sent_at = now() WHERE id = $1`, [est.id]);
    const tok = (await query('SELECT public_token FROM crm_estimates WHERE id = $1', [est.id])).rows[0].public_token;
    await E.acceptByToken({ token: tok, name: 'Pat Lee', ip: '1.1.1.1', baseUrl: 'https://app.test' });
    assert.equal(Number((await crm.getDeal(t, deal.id)).value), 2400, 'contract = accepted total');

    // 2. Absurd estimate numbers get a clear message, not a database error.
    const est2 = await E.createEstimate({ tenantId: t, dealId: deal.id, userId: u });
    await assert.rejects(E.saveEstimate({ tenantId: t, id: est2.id, body: { title: 'X', kind: 'construction', lines: [{ description: 'Huge', quantity: 1e7, unit_cost: 1e8 }] } }), /more than any real job/);

    // 3. Subs never see the street before the job is theirs.
    assert.equal(bids.areaOf('55 Elm St, Houston TX 77007'), 'Houston TX 77007');
    assert.equal(bids.areaOf('12 River Oaks Blvd, Houston, TX 77019'), 'Houston, TX 77019');
    assert.equal(bids.areaOf('55 Elm St Houston TX 77007'), '77007');

    // 4. A homeowner's comment after a low score shows on the Needs-you item.
    const ptok = require('crypto').randomBytes(24).toString('hex');
    await query('INSERT INTO crm_pulses (tenant_id, deal_id, token, sent_at) VALUES ($1, $2, $3, now())', [t, deal.id, ptok]);
    await pulse.answer({ token: ptok, score: 2 });
    await pulse.answer({ token: ptok, score: 2, comment: 'Mess in the driveway.' });
    const item = (await query(`SELECT detail FROM crm_inbox WHERE tenant_id = $1 AND kind = 'unhappy'`, [t])).rows[0];
    assert.match(item.detail, /Mess in the driveway/);

    // 5. A question asked in the portal is labelled as a question (not just "a message").
    const portalTok = await portal.portalToken(t, deal.id);
    await portalAi.ask({ token: portalTok, question: 'When do you start?' });
    assert.ok((await crm.listInbox(t)).some(i => /asked a question in their portal/.test(i.title)));
    assert.ok(sent.some(m => /^Question from Pat Lee/.test(m.subject)));

    // 6. Approved change orders stay visible to the homeowner.
    const co = await jobs.createCO({ tenantId: t, dealId: deal.id, title: 'Extra outlet', amount: 150 });
    await query(`UPDATE crm_change_orders SET status = 'approved', approved_at = now(), approved_name = 'Pat Lee' WHERE id = $1`, [co.id]);
    const v = await portal.portalView(portalTok);
    assert.ok(v.job.changeOrders.some(c => c.status === 'approved' && c.approvedName === 'Pat Lee'));
    console.log('REGRESSIONS SCENARIO PASSED');
  } catch (e) {
    console.error('REGRESSIONS SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
