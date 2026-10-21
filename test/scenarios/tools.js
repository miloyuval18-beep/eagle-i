// Every tool the assistant has, run on a real company's data: each one either
// works or says plainly why not (never a crash), members can't reach what's
// only for owners, and another company's ids get nothing back.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
process.env.ANTHROPIC_API_KEY = 'test-only';
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
// The AI answers with plausible JSON for whatever it's asked.
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { ...require(R + '/lib/anthropic'), generateJSON: async (p) => {
  if (/estimate/i.test(p) && /lines/.test(p)) return { title: 'Kitchen', lines: [{ description: 'Cabinets', quantity: 1, unit: 'ea', unit_cost: 9000, category: 'materials' }] };
  if (/reply/i.test(p)) return { subject: 'Re: your kitchen', body: 'Hi Ana, thanks!' };
  return { summary: 'ok', move: 'Call Ana', why: 'Quiet for a week', advice: [], title: 'x' };
} } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs'); const A = require(R + '/lib/crmAssistant');
const MARK = 'SECRET' + Date.now();

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Tools Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Tools Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const crashes = [], said = [];
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address) VALUES ($1, '713-555-0100', 'o@tools.test', '1 Main St, Houston TX 77002')`, [t]);
    await query(`INSERT INTO business_profile (tenant_id, email) VALUES ($1, 'o@other.test')`, [t2]);
    const ownerId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@tools.test', 'x', 'Moran Levi', 'owner') RETURNING id`, [t])).rows[0].id;
    const alexId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@tools.test', 'x', 'Alex Romero', 'member') RETURNING id`, [t])).rows[0].id;
    const xId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'x@other.test', 'x', 'X Other', 'owner') RETURNING id`, [t2])).rows[0].id;
    const owner = { tenantId: t, userId: ownerId, name: 'Moran Levi', role: 'owner', manager: true, baseUrl: 'https://app.test' };
    const alex = { tenantId: t, userId: alexId, name: 'Alex Romero', role: 'member', manager: false, baseUrl: 'https://app.test' };
    const other = { tenantId: t2, userId: xId, name: 'X Other', role: 'owner', manager: true, baseUrl: 'https://app.test' };

    // A company with one of everything.
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz ' + MARK, email: 'ana@owner.test', phone: '713-555-0142', address: '12 Oak St, Houston TX 77008', title: 'Ruiz kitchen ' + MARK, value: 85000, userId: ownerId, ownerUserId: ownerId });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'production', userId: ownerId });
    const lead = await crm.createDeal({ tenantId: t, name: 'Bo Lee', email: 'bo@owner.test', title: 'Lee bath', userId: alexId, ownerUserId: alexId });
    const vendor = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Framing', trade: 'Framing', email: 'gulf@sub.test' } });
    const phase = (await query(`SELECT id, title FROM crm_job_items WHERE deal_id = $1 ORDER BY position LIMIT 1`, [deal.id])).rows[0]
      || await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Framing', startDate: '2026-11-02', endDate: '2026-11-04' } });
    const est = await require(R + '/lib/crmEstimates').createEstimate({ tenantId: t, dealId: deal.id, userId: ownerId });
    await require(R + '/lib/crmEstimates').updateEstimate?.({ tenantId: t, id: est.id, body: { title: 'Kitchen', lines: [{ description: 'Cabinets', quantity: 1, unit_cost: 9000, markup_pct: 20 }] } }).catch(() => {});
    const inv = await require(R + '/lib/crmPayments').createInvoice({ tenantId: t, dealId: deal.id, title: 'Deposit', amount: 5000, userId: ownerId });
    const co = await jobs.createCO({ tenantId: t, dealId: deal.id, title: 'Pot filler', amount: 950 });
    const po = await jobs.createPO({ tenantId: t, dealId: deal.id, vendorId: vendor.id, title: 'Lumber', lines: [{ description: 'Studs', quantity: 10, unit_cost: 8 }] });
    const file = await require(R + '/lib/crmPortal').addFile({ tenantId: t, dealId: deal.id, filename: 'Plan A2.pdf', buffer: Buffer.from('%PDF-1.4 plan ' + MARK), userId: ownerId });
    const chatFile = await A.saveChatUpload(owner, { filename: 'site.pdf', dataBase64: Buffer.from('%PDF-1.4 site').toString('base64') });
    const email = (await query(`INSERT INTO crm_emails (tenant_id, message_key, mailbox_email, direction, from_email, to_emails, subject, snippet, sent_at, contact_id, deal_id, user_id)
      VALUES ($1, '<m1@x>', 'moran@tools.test', 'in', 'ana@owner.test', '{moran@tools.test}', $2, 'Can we add a pot filler?', now() - interval '2 days', $3, $4, $5) RETURNING id`, [t, 'Pot filler ' + MARK, deal.contact_id, deal.id, ownerId])).rows[0].id;
    const mw = (await query(`INSERT INTO crm_mail_threads (tenant_id, mailbox_email, user_id, thread_id, counterpart_email, counterpart_name, subject, last_dir, last_at, last_message_key, state, expects, importance, classified_at)
      VALUES ($1, 'moran@tools.test', $2, 'th1', 'gulf@sub.test', 'Gulf Framing', $3, 'out', now() - interval '6 days', '<o1@x>', 'waiting', true, 'high', now()) RETURNING id`, [t, ownerId, 'Framing price ' + MARK])).rows[0].id;

    // Inputs for every tool (ids from this company).
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const later = new Date(Date.now() + 5 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const INPUT = {
      search_crm: { query: 'Ruiz' }, get_deal: { deal_id: deal.id }, list_deals: {}, team_members: {}, team_activity: { person: 'Alex' }, needs_you: {}, upcoming: { days: 7 },
      calendar: {}, add_to_calendar: { title: 'Walkthrough', date: later, time: '10:00', deal_id: deal.id }, money: {}, list_vendors: {}, search_emails: { query: 'pot filler' }, read_email: { email_id: String(email) },
      sub_prices: { trade: 'Framing' }, job_margins: {}, win_rates: {}, lead_sources: {}, next_move: { deal_id: lead.id }, job_outlook: { deal_id: deal.id }, check_estimate: { estimate_id: est.id },
      win_loss: {}, coaching: { person: 'Alex' }, add_punch_item: { deal_id: deal.id, issue: 'Paint touch-up in hall', location: 'Hall' }, draft_reply: { deal_id: deal.id }, read_file: { file_id: file.id },
      list_bids: { deal_id: deal.id }, weekly_report: {}, create_task: { title: 'Order hinges', deal_id: deal.id, due_date: later }, add_note: { deal_id: deal.id, text: 'Spoke with Ana' },
      log_work: { deal_id: deal.id, text: 'Demo finished today' }, set_site_visit: { deal_id: lead.id, date: later, time: '10:00' }, move_stage: { deal_id: lead.id, stage: 'qualified' },
      create_deal: { name: 'Cy Park', email: 'cy@owner.test', title: 'Park deck' }, draft_estimate: { deal_id: deal.id, scope: 'New kitchen cabinets and counters' },
      update_phase: { deal_id: deal.id, phase: phase.title, start_date: later, end_date: later }, add_phase: { deal_id: deal.id, title: 'Paint', start_date: later, end_date: later },
      add_cost: { deal_id: deal.id, amount: 120, description: 'Screws' }, add_vendor: { name: 'Bright Electric', trade: 'Electrical', email: 'b@sub.test' },
      create_change_order: { deal_id: deal.id, title: 'Extra outlet', amount: 300 }, create_purchase_order: { deal_id: deal.id, vendor: 'Gulf Framing', title: 'Nails', lines: [{ description: 'Nails', quantity: 1, unit_cost: 40 }] },
      create_invoice: { deal_id: deal.id, title: 'Progress 1', amount: 10000 }, mark_invoice_paid: { invoice_number: inv.number, via: 'check' }, save_chat_file_to_deal: { chat_file_id: chatFile.id, deal_id: deal.id },
      send_bid_request: { deal_id: deal.id, vendor_ids: [vendor.id], scope: 'Frame the addition', due_date: later }, send_change_order: { change_order_id: co.id }, send_purchase_order: { purchase_order_id: po.id },
      send_invoice: { invoice_id: inv.id }, drive_search: { query: 'plan' }, drive_read: { file_id: 'x' }, drive_save_to_deal: { file_id: 'x', deal_id: deal.id },
      send_email: { to: 'ana@owner.test', subject: 'Hello', message: 'Hi Ana', deal_id: deal.id }, send_sub_page: { vendor: 'Gulf Framing' }, email_watch: {},
      send_follow_up: { id: String(mw) }, send_project_page: { deal_id: deal.id }, email_homeowner: { deal_id: deal.id, subject: 'Update', message: 'All good' },
      post_portal_update: { deal_id: deal.id, text: 'Cabinets are in' }, send_estimate: { estimate_id: est.id }
    };
    const missing = Object.keys(A.TOOLS).filter(k => !INPUT[k]);
    assert.deepEqual(missing, [], 'every tool has an input here');

    // Runs one tool the way the assistant does (confirm tools: prepare, then execute).
    async function call(ctx, name, input) {
      const tool = A.TOOLS[name];
      if (!tool.confirm) return tool.run(ctx, input);
      const prep = await tool.prepare(ctx, input);
      assert.ok(prep && prep.payload && prep.summary && prep.summary.title, `${name} prepares a card`);
      return tool.execute(ctx, prep.payload);
    }
    // An intentional "no" has a status; anything else is a crash.
    const isCrash = (e) => !(e && e.status) || e instanceof TypeError || e instanceof ReferenceError;
    // 1. As the owner: every tool works or says why.
    for (const name of Object.keys(A.TOOLS)) {
      try { const r = await call(owner, name, INPUT[name]); JSON.stringify(r); }
      catch (e) { (isCrash(e) ? crashes : said).push(`${name}: ${e.message}`); }
    }
    // 2. As a member: also no crashes, and nothing that's only for owners.
    const memberSaid = [];
    for (const name of Object.keys(A.TOOLS)) {
      try { await call(alex, name, ['coaching', 'team_activity'].includes(name) ? { ...INPUT[name], person: 'Moran' } : INPUT[name]); }
      catch (e) { (isCrash(e) ? crashes : memberSaid).push(`member ${name}: ${e.message}`); }
    }
    assert.ok(memberSaid.some(m => /coaching|team_activity/.test(m)), 'a member can’t pull a colleague’s coaching or activity');
    // 3. Another company, with this company's ids: nothing comes back, nothing changes.
    const before = JSON.stringify((await query(`SELECT (SELECT COUNT(*) FROM crm_deals WHERE tenant_id = $1) d, (SELECT COUNT(*) FROM crm_tasks WHERE tenant_id = $1) k, (SELECT status FROM crm_invoices WHERE id = $2) i, (SELECT stage FROM crm_deals WHERE id = $3) s`, [t, inv.id, lead.id])).rows[0]);
    const leaks = [];
    for (const name of Object.keys(A.TOOLS)) {
      try { const r = await call(other, name, INPUT[name]); if (JSON.stringify(r || {}).includes(MARK)) leaks.push(name); }
      catch (e) { if (isCrash(e)) crashes.push(`other company ${name}: ${e.message}`); if (String(e.message).includes(MARK)) leaks.push(name + ' (in the error)'); }
    }
    const after = JSON.stringify((await query(`SELECT (SELECT COUNT(*) FROM crm_deals WHERE tenant_id = $1) d, (SELECT COUNT(*) FROM crm_tasks WHERE tenant_id = $1) k, (SELECT status FROM crm_invoices WHERE id = $2) i, (SELECT stage FROM crm_deals WHERE id = $3) s`, [t, inv.id, lead.id])).rows[0]);
    assert.deepEqual(leaks, [], 'another company never sees this one’s data');
    assert.equal(after, before, 'another company changed nothing here');
    assert.deepEqual(crashes, [], 'no tool crashes');
    console.log('Member was told no:\n  ' + memberSaid.join('\n  '));
    console.log('Said no (as owner):\n  ' + said.join('\n  '));
    console.log('TOOLS SCENARIO PASSED');
  } catch (e) {
    console.error('TOOLS SCENARIO FAILED:', e, '\nCRASHES:\n  ' + crashes.join('\n  '));
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
