// Emails, connections and safety: one automatic email per person a day, the
// week's emails listed and skippable, bounces and lost Google access in
// Today, the owner told about unusual actions, the self-check noticing a
// stuck background tick, a full data export that opens, and the assistant
// asking before moving a stage or marking an invoice paid (with Undo).
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
process.env.GOOGLE_CRM_CLIENT_ID = 'cid.apps.googleusercontent.com'; process.env.GOOGLE_CRM_CLIENT_SECRET = 'secret';
process.env.SOCIAL_CREDENTIALS_KEY = process.env.SOCIAL_CREDENTIALS_KEY || crypto.randomBytes(32).toString('hex');
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
const L = (m) => require(R + '/lib/' + m);
const crm = L('crm'), pb = L('crmPlaybooks');

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Safe Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Safe Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, phone, address) VALUES ($1, 'office@safe.test', '713-555-0100', '1 Main St, Houston TX 77002')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@safe.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const alex = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@safe.test', 'x', 'Alex', 'member') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@owner.test', title: 'Ruiz kitchen', userId: owner, ownerUserId: owner });
    const play = (await query(`SELECT id FROM crm_playbooks WHERE tenant_id = $1 LIMIT 1`, [t])).rows[0] || (await pb.listPlaybooks(t))[0];

    // 1. One automatic email per person a day; the week's list; Skip.
    await query(`INSERT INTO crm_playbook_sends (id, tenant_id, playbook_id, deal_id, step, entry_key, due_at, status, to_email, sent_at) VALUES ($1, $2, $3, $4, 1, 'x', now() - interval '1 hour', 'sent', 'ana@owner.test', now() - interval '1 hour')`, [crypto.randomUUID(), t, play.id, deal.id]);
    const up = await pb.upcomingSends(t);
    assert.ok(Array.isArray(up));
    const s2 = crypto.randomUUID();
    await query(`INSERT INTO crm_playbook_sends (id, tenant_id, playbook_id, deal_id, step, entry_key, due_at, status) VALUES ($1, $2, $3, $4, 1, 'y', now() + interval '2 days', 'pending')`, [s2, t, play.id, deal.id]);
    await query(`UPDATE crm_playbooks SET enabled = true WHERE id = $1`, [play.id]);
    assert.ok((await pb.upcomingSends(t)).some(x => x.id === s2 && x.to === 'Ana Ruiz'), 'listed for the week');
    assert.equal((await pb.upcomingSends(t2)).length, 0);
    assert.equal(await pb.skipSend({ tenantId: t2, id: s2 }), false, 'never another company');
    assert.equal(await pb.skipSend({ tenantId: t, id: s2 }), true);
    assert.equal((await query('SELECT cancel_reason FROM crm_playbook_sends WHERE id = $1', [s2])).rows[0].cancel_reason, 'skipped');

    // 2. A bounce lands in Today; so does lost Google access.
    const s3 = crypto.randomUUID();
    await query(`INSERT INTO crm_playbook_sends (id, tenant_id, playbook_id, deal_id, step, entry_key, due_at, status, to_email, resend_email_id) VALUES ($1, $2, $3, $4, 2, 'z', now(), 'sent', 'ana@owner.test', 're_bounce1')`, [s3, t, play.id, deal.id]);
    await pb.processDeliveryEvent({ type: 'email.bounced', data: { email_id: 're_bounce1', bounce: { type: 'Permanent' } } }, (b) => /permanent/i.test(b.type));
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'bounce' && /Ana Ruiz’s email address bounced/.test(i.title)));
    await query(`INSERT INTO crm_google_connections (tenant_id, kind, domain, admin_email, status) VALUES ($1, 'signin', '', 'moran@gmail.test', 'connected')`, [t]);
    await query(`INSERT INTO crm_mailboxes (tenant_id, email, included, refresh_token_enc, scopes, connected_by) VALUES ($1, 'moran@gmail.test', true, $2, 'gmail', $3)`, [t, JSON.stringify(L('crypto').encrypt('rt-gone')), owner]);
    const g = L('crmGoogle');
    await g.processGoogleSync({ onlyTenantId: t, http: async (u) => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }) });
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'google' && /can’t read moran@gmail\.test’s email/.test(i.title)), 'lost Google access shows in Today');

    // 3. Owner alerts: a lot deleted, someone made an admin.
    sent.length = 0;
    const trash = L('crmTrash');
    for (let i = 0; i < 5; i++) {
      const task = await L('crmTasks').createTask({ tenantId: t, title: 'tmp ' + i, assigneeUserId: alex });
      await trash.around({ tenantId: t, kind: 'task', id: task.id, userId: alex }, () => L('crmTasks').deleteTask({ tenantId: t, id: task.id }));
    }
    await new Promise(r => setTimeout(r, 300));
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'security' && /5 things were deleted/.test(i.title)));
    assert.ok(sent.some(m => m.to === 'moran@safe.test' && /deleted/.test(m.subject)), 'the owner is emailed');
    assert.ok(!sent.some(m => m.to === 'alex@safe.test'), 'not the person who did it');
    await L('crmTeam').setRole({ tenantId: t, actor: { id: owner, role: 'owner' }, userId: alex, role: 'admin' });
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'security' && /Alex is now an admin/.test(i.title)));

    // 4. The self-check notices a stuck tick and overdue emails, and says so once.
    const health = L('crmHealth');
    const alerts = [];
    const later = Date.now() + 2 * 3600000;
    const p1 = await health.runCheck({ alert: async (k, m) => alerts.push(m), now: later });
    assert.ok(p1.some(p => /background tick/.test(p)));
    await health.runCheck({ alert: async (k, m) => alerts.push(m), now: later + 60000 });
    assert.equal(alerts.length, 1, 'told once, not every half hour');
    health.beat('followUpWorker');
    assert.ok(!(await health.check(Date.now())).some(p => /background tick/.test(p)));

    // 5. Download all my data: a real zip with every sheet, this company only.
    await query(`INSERT INTO crm_contacts (tenant_id, name, email) VALUES ($1, 'Other Person', 'other@x.test')`, [t2]);
    const buf = await L('crmExport').exportAll(t);
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts like a zip');
    const files = {};
    let off = 0;
    while (buf.readUInt32LE(off) === 0x04034b50) {
      const csize = buf.readUInt32LE(off + 18), nlen = buf.readUInt16LE(off + 26), xlen = buf.readUInt16LE(off + 28);
      const name = buf.slice(off + 30, off + 30 + nlen).toString();
      files[name] = zlib.inflateRawSync(buf.slice(off + 30 + nlen + xlen, off + 30 + nlen + xlen + csize)).toString();
      off += 30 + nlen + xlen + csize;
    }
    for (const n of ['READ ME.txt', 'customers.csv', 'deals.csv', 'invoices.csv', 'calendar.csv', 'subs-and-vendors.csv']) assert.ok(files[n] !== undefined, `has ${n}`);
    assert.match(files['deals.csv'], /Ruiz kitchen/); assert.match(files['customers.csv'], /ana@owner\.test/);
    assert.ok(!files['customers.csv'].includes('other@x.test'), 'never another company’s');
    for (const [n, sql] of L('crmExport').SHEETS) await query(sql, [t]).catch(e => assert.fail(`${n}: ${e.message}`));
    assert.equal(L('crmExport').csv([{ a: '=SUM(A1)', b: 'x,"y"' }]).split('\r\n')[1], `'=SUM(A1),"x,""y"""`, 'formulas defused, quotes escaped');

    // 6. The assistant asks before moving a stage or marking paid; a stage move can be undone.
    const A = L('crmAssistant');
    const ctx = { tenantId: t, userId: owner, manager: true, baseUrl: 'https://app.test' };
    assert.equal(A.TOOLS.move_stage.confirm, true); assert.equal(A.TOOLS.mark_invoice_paid.confirm, true);
    const prep = await A.TOOLS.move_stage.prepare(ctx, { deal_id: deal.id, stage: 'signed' });
    assert.match(prep.summary.lines.join(' '), /no estimate/i, 'the card shows what looks wrong');
    const th = await A.createThread(ctx);
    const act = (await query(`INSERT INTO crm_ai_actions (tenant_id, user_id, thread_id, kind, payload, summary) VALUES ($1, $2, $3, 'move_stage', $4, $5) RETURNING id`, [t, owner, th.id, JSON.stringify(prep.payload), JSON.stringify(prep.summary)])).rows[0].id;
    const done = await A.decideAction(ctx, act, true);
    assert.equal((await crm.getDeal(t, deal.id)).stage, 'signed'); assert.ok(done.result.undo);
    const back = await A.undoAction(ctx, act);
    assert.equal((await crm.getDeal(t, deal.id)).stage, 'new'); assert.match(back.result.text, /back to New lead/);
    await assert.rejects(A.undoAction(ctx, act), /nothing to undo/);
    await assert.rejects(A.undoAction({ ...ctx, userId: alex }, act), /Not found/);
    const inv = await L('crmPayments').createInvoice({ tenantId: t, dealId: deal.id, title: 'Deposit', amount: 1000, userId: owner });
    const pp = await A.TOOLS.mark_invoice_paid.prepare(ctx, { invoice_number: inv.number, via: 'check' });
    assert.match(pp.summary.lines.join(' '), /\$1,000 by check/);
    await A.TOOLS.mark_invoice_paid.execute(ctx, pp.payload);
    await assert.rejects(A.TOOLS.mark_invoice_paid.prepare(ctx, { invoice_number: inv.number }), /already marked paid/);
    console.log('SAFETY SCENARIO PASSED');
  } catch (e) {
    console.error('SAFETY SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM crm_trash WHERE tenant_id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
