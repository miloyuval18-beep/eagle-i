// The recycle bin: a deal deleted with everything hanging off it comes back
// exactly (files byte for byte, emails re-linked), small things too,
// archived things un-archive, a failed delete leaves nothing in the bin, other
// companies can't touch it, and after 30 days it's gone for good.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const { query, pool } = require(R + '/db');
const L = (m) => require(R + '/lib/' + m);
const crm = L('crm'), jobs = L('crmJobs'), trash = L('crmTrash');

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Bin Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Bin Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address) VALUES ($1, 'o@bin.test', '1 Main St, Houston TX 77002')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@bin.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@owner.test', address: '12 Oak St, Houston TX 77008', title: 'Ruiz kitchen', userId: owner, ownerUserId: owner });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'production', userId: owner });
    const vendor = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Framing', email: 'gulf@sub.test' } });
    await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Framing', startDate: '2026-11-02', endDate: '2026-11-04', vendorId: vendor.id } });
    await L('crmTasks').createTask({ tenantId: t, dealId: deal.id, title: 'Order hinges', assigneeUserId: owner });
    const bytes = crypto.randomBytes(5000);
    const file = await L('crmPortal').addFile({ tenantId: t, dealId: deal.id, filename: 'Plan A2.pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4 '), bytes]), userId: owner });
    const est = await L('crmEstimates').createEstimate({ tenantId: t, dealId: deal.id, userId: owner });
    const inv = await L('crmPayments').createInvoice({ tenantId: t, dealId: deal.id, title: 'Deposit', amount: 1000, userId: owner });
    await query(`INSERT INTO crm_draws (tenant_id, deal_id, title, pct, invoice_id) VALUES ($1, $2, 'Deposit 10%', 10, $3)`, [t, deal.id, inv.id]);
    await jobs.createPO({ tenantId: t, dealId: deal.id, vendorId: vendor.id, title: 'Lumber', lines: [{ description: 'Studs', quantity: 10, unit_cost: 8 }] });
    await jobs.createCO({ tenantId: t, dealId: deal.id, title: 'Pot filler', amount: 950 });
    await jobs.saveSelection({ tenantId: t, dealId: deal.id, body: { category: 'Tile', options: [{ name: 'A', price: 0 }] } });
    await L('crmCalendar').createEvent({ tenantId: t, actor: { id: owner, role: 'owner' }, body: { title: 'Walkthrough', date: '2026-11-05', time: '10:00', dealId: deal.id } });
    await jobs.addLog({ tenantId: t, dealId: deal.id, body: 'Demo done', userId: owner });
    // An email stays when the deal goes, but loses its link; it must come back linked.
    const email = (await query(`INSERT INTO crm_emails (tenant_id, message_key, mailbox_email, direction, subject, sent_at, deal_id) VALUES ($1, '<x1@x>', 'moran@bin.test', 'in', 'Hi', now(), $2) RETURNING id`, [t, deal.id])).rows[0].id;

    const count = async () => (await query(
      `SELECT (SELECT COUNT(*) FROM crm_job_items WHERE deal_id = $1)::int ji, (SELECT COUNT(*) FROM crm_tasks WHERE deal_id = $1)::int tk, (SELECT COUNT(*) FROM crm_files WHERE deal_id = $1)::int fl,
              (SELECT COUNT(*) FROM crm_estimates WHERE deal_id = $1)::int es, (SELECT COUNT(*) FROM crm_estimate_lines l JOIN crm_estimates e ON e.id = l.estimate_id WHERE e.deal_id = $1)::int el,
              (SELECT COUNT(*) FROM crm_invoices WHERE deal_id = $1)::int iv, (SELECT COUNT(*) FROM crm_draws WHERE deal_id = $1 AND invoice_id IS NOT NULL)::int dr, (SELECT COUNT(*) FROM crm_purchase_orders WHERE deal_id = $1)::int po,
              (SELECT COUNT(*) FROM crm_change_orders WHERE deal_id = $1)::int co, (SELECT COUNT(*) FROM crm_selections WHERE deal_id = $1)::int se, (SELECT COUNT(*) FROM crm_events WHERE deal_id = $1)::int ev,
              (SELECT COUNT(*) FROM crm_daily_logs WHERE deal_id = $1)::int lg, (SELECT COUNT(*) FROM crm_activities WHERE deal_id = $1)::int ac, (SELECT COUNT(*) FROM crm_emails WHERE deal_id = $1)::int em`, [deal.id])).rows[0];
    const before = await count();
    assert.ok(before.ji && before.tk && before.fl && before.es && before.iv && before.dr && before.po && before.co && before.se && before.ev && before.lg && before.ac && before.em, 'the deal has one of everything: ' + JSON.stringify(before));

    // 1. Delete the deal through the bin: everything goes, the email stays unlinked.
    const r = await trash.around({ tenantId: t, kind: 'deal', id: deal.id, userId: owner }, () => crm.deleteDeal(t, deal.id));
    assert.equal(r.ok, true); assert.ok(r.undo);
    assert.equal(await crm.getDeal(t, deal.id), null);
    assert.equal((await query('SELECT deal_id FROM crm_emails WHERE id = $1', [email])).rows[0].deal_id, null);
    const bin = await trash.list(t);
    assert.equal(bin[0].label, 'Ruiz kitchen'); assert.equal(bin[0].name, 'Deal'); assert.ok(bin[0].n > 10);
    // Another company can't restore it or see it.
    await assert.rejects(trash.restore({ tenantId: t2, id: r.undo }), /no longer in the recycle bin/);
    assert.equal((await trash.list(t2)).length, 0);

    // 2. Restore: every row back, the email re-linked, the file byte for byte.
    await trash.restore({ tenantId: t, id: r.undo });
    assert.ok(await crm.getDeal(t, deal.id));
    assert.deepEqual(await count(), before);
    assert.equal((await query('SELECT deal_id FROM crm_emails WHERE id = $1', [email])).rows[0].deal_id, deal.id);
    const back = await L('crmPortal').getFile(t, file.id);
    assert.ok(Buffer.from(back.data).equals(Buffer.concat([Buffer.from('%PDF-1.4 '), bytes])), 'the file comes back byte for byte');
    assert.equal((await trash.list(t)).length, 0, 'restored things leave the bin');

    // 3. Small things: a task; a failed delete leaves nothing behind.
    const task = (await query('SELECT id FROM crm_tasks WHERE deal_id = $1', [deal.id])).rows[0];
    const rt = await trash.around({ tenantId: t, kind: 'task', id: task.id, userId: owner }, () => L('crmTasks').deleteTask({ tenantId: t, id: task.id }));
    await trash.restore({ tenantId: t, id: rt.undo });
    assert.ok((await query('SELECT 1 FROM crm_tasks WHERE id = $1', [task.id])).rows.length);
    const draw = (await query('SELECT id FROM crm_draws WHERE deal_id = $1', [deal.id])).rows[0];
    await assert.rejects(trash.around({ tenantId: t, kind: 'draw', id: draw.id, userId: owner }, () => L('crmDraws').deleteDraw({ tenantId: t, id: draw.id })), /Invoiced payments/);
    assert.equal((await trash.list(t)).length, 0, 'a delete that didn’t happen leaves nothing in the bin');
    const notMine = await trash.around({ tenantId: t2, kind: 'task', id: task.id }, () => L('crmTasks').deleteTask({ tenantId: t2, id: task.id }));
    assert.equal(notMine.ok, false);
    assert.ok((await query('SELECT 1 FROM crm_tasks WHERE id = $1', [task.id])).rows.length, 'another company can’t delete it');

    // 4. Archived: restoring un-archives.
    const rv = await trash.around({ tenantId: t, kind: 'vendor', id: vendor.id, userId: owner }, () => jobs.archiveVendor({ tenantId: t, id: vendor.id }));
    assert.equal((await query('SELECT archived FROM crm_vendors WHERE id = $1', [vendor.id])).rows[0].archived, true);
    assert.equal((await trash.list(t))[0].mode, 'archived');
    await trash.restore({ tenantId: t, id: rv.undo });
    assert.equal((await query('SELECT archived FROM crm_vendors WHERE id = $1', [vendor.id])).rows[0].archived, false);

    // 5. If it already came back some other way, restoring just clears the entry.
    const rf = await trash.around({ tenantId: t, kind: 'file', id: file.id, userId: owner }, () => L('crmPortal').deleteFile({ tenantId: t, id: file.id, drive: false }));
    await trash.restore({ tenantId: t, id: rf.undo });
    await assert.rejects(trash.restore({ tenantId: t, id: rf.undo }), /no longer/);

    // 6. After 30 days: gone for good.
    const rc = await trash.around({ tenantId: t, kind: 'deal', id: deal.id, userId: owner }, () => crm.deleteDeal(t, deal.id));
    await query(`UPDATE crm_trash SET deleted_at = now() - interval '31 days' WHERE id = $1`, [rc.undo]);
    assert.equal((await trash.list(t)).length, 0, 'older than 30 days isn’t listed');
    assert.ok((await trash.purge()) >= 1);
    await assert.rejects(trash.restore({ tenantId: t, id: rc.undo }), /no longer/);
    console.log('TRASH SCENARIO PASSED');
  } catch (e) {
    console.error('TRASH SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM crm_trash WHERE tenant_id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
