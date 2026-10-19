delete process.env.ANTHROPIC_API_KEY; delete process.env.RESEND_API_KEY;
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs'); const subs = require(R + '/lib/crmSubs'); const draws = require(R + '/lib/crmDraws');
const pay = require(R + '/lib/crmPayments');
const sent = []; const send = async (m) => { sent.push(m); return { id: 'x' }; };
const day = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); };
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Sub Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address) VALUES ($1, '713-555-0100', 'o@sub.test', '1001 S Dairy Ashford, Houston TX 77077')`, [t]);
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@sub.test', address: '12 Oak Ln, Houston TX 77024', title: 'Kitchen', stage: 'proposal', value: '100000' });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed' });
    const v = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Tile', email: 'tile@sub.test', phone: '713-555-0177' } });
    const items = await jobs.listSchedule(t, deal.id);
    const tile = items.find(i => /Tile/.test(i.title));
    await jobs.saveItem({ tenantId: t, id: tile.id, body: { title: tile.title, startDate: day(2), endDate: day(3), vendorId: v.id } });
    // Weekday, mid-morning Central, the day the ask is due.
    const wd = new Date(); wd.setUTCHours(16, 0, 0, 0);
    const isWeekday = !['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(wd));
    let r = await subs.processConfirmations({ now: wd, send, baseUrl: 'https://x' });
    assert.equal(r.asked, 0, 'off until switched on');
    await subs.setSubConfirm(t, true);
    if (isWeekday) {
      r = await subs.processConfirmations({ now: wd, send, baseUrl: 'https://x' });
      assert.equal(r.asked, 1);
      assert.equal(sent[0].to, 'tile@sub.test'); assert.match(sent[0].subject, /Please confirm: Tile/); assert.match(sent[0].text, /12 Oak Ln/);
      assert.equal((await subs.processConfirmations({ now: wd, send, baseUrl: 'https://x' })).asked, 0, 'asked once');
      const token = /\/sub\/([0-9a-f]{48})/.exec(sent[0].text)[1];
      const info = await subs.confirmInfo(token);
      assert.equal(info.vendor, 'Gulf Tile'); assert.equal(info.start, day(2));
      await subs.answerConfirm({ token, yes: false, note: 'Can do Monday' });
      assert.ok((await crm.listInbox(t)).some(i => i.kind === 'sub_conflict' && /can’t make/.test(i.title)));
      await subs.answerConfirm({ token, yes: true });
      assert.equal((await jobs.listSchedule(t, deal.id)).find(i => i.id === tile.id).confirm_status, 'confirmed');
      // Moving the dates asks again, with a new link.
      await jobs.saveItem({ tenantId: t, id: tile.id, body: { title: tile.title, startDate: day(3), endDate: day(3), vendorId: v.id } });
      assert.equal((await jobs.listSchedule(t, deal.id)).find(i => i.id === tile.id).confirm_status, null);
      assert.equal(await subs.confirmInfo(token), null, 'old link retired');
      r = await subs.processConfirmations({ now: wd, send, baseUrl: 'https://x' });
      assert.equal(r.asked, 1);
    } else console.log('(weekend: skipped the send checks)');
    // No answer by the day before → Needs you.
    await query(`UPDATE crm_job_items SET confirm_status = 'sent', start_date = $2 WHERE id = $1`, [tile.id, day(1)]);
    r = await subs.processConfirmations({ now: new Date(), send });
    assert.ok(r.flagged >= 1);
    assert.ok((await crm.listInbox(t)).some(i => /hasn’t confirmed/.test(i.title)));
    // Cash flow: a sent invoice due next week; a milestone after its phase; a PO going out.
    const inv = await pay.createInvoice({ tenantId: t, dealId: deal.id, kind: 'progress', title: 'Progress', amount: 5000, dueDate: day(8) });
    await query(`UPDATE crm_invoices SET status = 'sent' WHERE id = $1`, [inv.id]);
    const old = await pay.createInvoice({ tenantId: t, dealId: deal.id, kind: 'other', title: 'Old', amount: 700, dueDate: day(-5) });
    await query(`UPDATE crm_invoices SET status = 'sent' WHERE id = $1`, [old.id]);
    const po = await jobs.createPO({ tenantId: t, dealId: deal.id, vendorId: v.id, title: 'Tile', lines: [{ description: 'Porcelain', quantity: 100, unit_cost: 4 }], neededBy: day(9) });
    await query(`UPDATE crm_purchase_orders SET status = 'sent' WHERE id = $1`, [po.id]);
    const cf = await subs.cashflow(t);
    assert.equal(cf.weeks.length, 8);
    assert.equal(cf.overdue, 700);
    const all = cf.weeks.flatMap(w => w.items);
    assert.ok(all.some(i => i.side === 'in' && i.amount === 5000));
    assert.ok(all.some(i => i.side === 'out' && i.amount === 400));
    assert.ok(all.some(i => /Rough-in complete/.test(i.label) && i.amount === 30000), JSON.stringify(all.map(i => i.label)));
    console.log('SUBS + CASH FLOW SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
