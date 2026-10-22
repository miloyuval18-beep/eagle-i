// Moving in from another system: a Buildertrend-style subs list (.xlsx with
// a title line, text kept in the cells, blank styled cells), a schedule with
// US dates and durations, JobTread-style tasks, a cost catalog, past invoices
// and site logs. Each is recognised, checked without writing anything,
// brought in, not doubled on a second run, and undone completely. Another
// company is never touched.
const { R } = require('./_local');
const assert = require('assert/strict');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs');
const imp = require(R + '/lib/crmImport');
const { zip } = require(R + '/lib/zip');
const b64 = (s) => Buffer.from(s).toString('base64');
const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// A real .xlsx the way web apps write them: text inside each cell, blank styled cells.
function xlsx(rows) {
  const col = (i) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => v === '' ? `<c r="${col(ci)}${ri + 1}" s="2"/>` : typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${x(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Subs" sheetId="1"/></sheets></workbook>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]).toString('base64');
}

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Move Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Move Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address) VALUES ($1, 'o@move.test', '1 Main St, Houston TX 77002')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@move.test', 'x', 'Moran Levi', 'owner') RETURNING id`, [t])).rows[0].id;
    const alex = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@move.test', 'x', 'Alex Romero', 'member') RETURNING id`, [t])).rows[0].id;
    const ruiz = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@owner.test', address: '12 Oak St, Houston TX 77008', title: 'Ruiz Kitchen', userId: owner });
    await crm.changeStage({ tenantId: t, dealId: ruiz.id, stage: 'production', userId: owner });
    await query('DELETE FROM crm_job_items WHERE deal_id = $1', [ruiz.id]);
    const gulf = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Framing', trade: 'Framing' } }); // here already, no email yet
    const count = async (table, tenant = t) => (await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant])).rows[0].n;
    const go = async (filename, dataBase64, expectKind) => {
      const p = await imp.preview({ filename, dataBase64 });
      assert.equal(p.kind, expectKind, `${filename} is recognised as ${expectKind} (got ${p.kind})`);
      const args = { tenantId: t, userId: owner, filename, dataBase64, kind: p.kind, mapping: p.mapping, headerRow: p.headerRow };
      return { p, args, check: await imp.check(args) };
    };

    // 0. Reading values the way exports write them.
    assert.equal(imp.day('11/2/2026'), '2026-11-02'); assert.equal(imp.day('2026-11-02'), '2026-11-02'); assert.equal(imp.day('Nov 2nd, 2026'), '2026-11-02');
    assert.equal(imp.day('46328'), '2026-11-02', 'Excel date number'); assert.equal(imp.day('2/30/2026'), null); assert.equal(imp.day(''), null);
    assert.equal(imp.money('$1,250.00'), 1250); assert.equal(imp.money('(500.25)'), -500.25); assert.equal(imp.money('abc'), null);

    // 1. A Buildertrend subs list (.xlsx): recognised, checked, brought in; the existing sub gets its blanks filled.
    const subs = xlsx([
      ['Subs/Vendors', '', '', '', '', '', '', ''],
      ['Company Name', 'Division', 'Primary Contact', 'Email', 'Cell Phone', 'License #', 'Liability Insurance Expiration', 'Notes'],
      ['Gulf Framing', 'Framing', 'Ray Gulf', 'gulf@sub.test', '713-555-0199', '', '12/31/2026', ''],
      ['Bright Electric', 'Electrical', 'Bo Bright', 'jobs@bright.test', '713-555-0123', 'TECL 12345', '06/30/2027', 'Great on service calls'],
      ['', 'Plumbing', 'No Name', '', '', '', '', ''],
      ['Lone Star Plumbing', '', '', 'Not an email', '832-555-0100', '', '', '']
    ]);
    const s = await go('Buildertrend_SubsVendors.xlsx', subs, 'vendors');
    assert.equal(s.p.platform, 'Buildertrend'); assert.equal(s.p.headerRow, 1, 'the title line above the headers is skipped');
    assert.equal(s.p.headers[s.p.headers.length - 1], 'Notes');
    assert.deepEqual([s.check.added, s.check.updated, s.check.skipped], [2, 1, 1]);
    assert.equal(s.check.reasons['no company name'], 1);
    assert.equal(await count('crm_vendors'), 1, 'checking writes nothing');
    const sr = await imp.run({ ...s.args, platform: s.p.platform });
    assert.equal(await count('crm_vendors'), 3);
    const g = (await query('SELECT * FROM crm_vendors WHERE id = $1', [gulf.id])).rows[0];
    assert.equal(g.email, 'gulf@sub.test'); assert.equal(g.trade, 'Framing'); assert.equal(g.import_id, null, 'an existing sub isn’t taken out by undo');
    const bright = (await query(`SELECT * FROM crm_vendors WHERE tenant_id = $1 AND name = 'Bright Electric'`, [t])).rows[0];
    assert.equal(bright.license_no, 'TECL 12345'); assert.match(String(bright.insurance_expires instanceof Date ? bright.insurance_expires.toISOString() : bright.insurance_expires), /^2027-06-30/);
    assert.equal((await query(`SELECT email FROM crm_vendors WHERE tenant_id = $1 AND name = 'Lone Star Plumbing'`, [t])).rows[0].email, null, 'a broken email isn’t kept');
    assert.equal((await imp.check(s.args)).added, 0, 'a second run adds nothing');

    // 2. A schedule: US dates, durations, subs by name; one job here already, one made.
    const sched = ['Job Name,Title,Start,End,Duration,Assigned To,Status', 'Ruiz Kitchen,Demo,10/26/2026,10/28/2026,3,Alex Romero,Complete', 'Ruiz Kitchen,Framing,11/2/2026,,4,Gulf Framing,Not Started',
      'Lee Addition,Foundation,11/9/2026,11/13/2026,,Bright Electric,', 'Lee Addition,,11/16/2026,,,,'].join('\n');
    const sc = await go('Schedule.csv', b64(sched), 'schedule');
    assert.deepEqual([sc.check.added, sc.check.skipped], [3, 1]); assert.deepEqual(sc.check.newJobs, ['Lee Addition']);
    assert.equal(await count('crm_job_items'), 0);
    const scr = await imp.run(sc.args);
    assert.equal(scr.jobsCreated, 1);
    const items = (await query(`SELECT i.title, i.start_date, i.end_date, i.status, i.vendor_id, i.assignee_user_id, d.title AS job, d.stage FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id WHERE i.tenant_id = $1 ORDER BY i.title`, [t])).rows;
    const fr = items.find(i => i.title === 'Framing');
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(ymd(fr.start_date), '2026-11-02'); assert.equal(ymd(fr.end_date), '2026-11-05', 'end from the duration'); assert.equal(fr.vendor_id, gulf.id);
    assert.equal(items.find(i => i.title === 'Demo').status, 'done'); assert.equal(items.find(i => i.title === 'Demo').assignee_user_id, alex);
    assert.equal(items.find(i => i.title === 'Foundation').stage, 'production');
    assert.equal(items.filter(i => i.job === 'Lee Addition').length, 1, 'the new job has the file’s schedule, not a template');
    assert.equal((await imp.check(sc.args)).added, 0, 'already on the schedule');

    // 3. JobTread-style tasks, a cost catalog, past invoices, site logs.
    const tk = await go('jobtread-todos.csv', b64(['Job,To-Do,Due Date,Assignee,Completed', 'Ruiz Kitchen,Order hinges,11/03/2026,Alex,No', ',Renew contractor license,2026-12-01,Moran Levi,', 'Ruiz Kitchen,Call the city,10/20/2026,,Yes'].join('\n')), 'tasks');
    assert.equal(tk.check.added, 3);
    await imp.run(tk.args);
    const tasks = (await query(`SELECT title, assignee_user_id, done_at FROM crm_tasks WHERE tenant_id = $1 AND import_id IS NOT NULL ORDER BY title`, [t])).rows;
    assert.equal(tasks.find(x => x.title === 'Order hinges').assignee_user_id, alex); assert.ok(tasks.find(x => x.title === 'Call the city').done_at);
    const cat = await go('cost-items.csv', b64(['Item,Cost Type,Unit,Unit Cost,Markup %', '2x4 stud 8ft,Material,Each,$4.25,25', 'Framing labor,Labor,Sq Ft,3.10,', 'Drywall hang & finish,Subcontractor,SF,"$2.40",20'].join('\n')), 'catalog');
    assert.equal(cat.check.added, 3);
    await imp.run(cat.args);
    const items2 = (await query(`SELECT name, category, unit, unit_cost FROM crm_catalog_items WHERE tenant_id = $1 ORDER BY name`, [t])).rows;
    assert.deepEqual(items2.map(i => [i.name, i.category, i.unit, Number(i.unit_cost)]), [['2x4 stud 8ft', 'materials', 'ea', 4.25], ['Drywall hang & finish', 'subcontract', 'sf', 2.4], ['Framing labor', 'labor', 'sf', 3.1]]);
    sent.length = 0;
    const inv = await go('Invoices.csv', b64(['Job,Invoice #,Description,Amount,Status,Due Date,Date Paid', 'Ruiz Kitchen,1043,Deposit,"$12,500.00",Paid,10/01/2026,10/03/2026', 'Ruiz Kitchen,1051,Framing draw,"$18,000.00",Unpaid,11/15/2026,', 'Ruiz Kitchen,1052,Nothing,$0,,,'].join('\n')), 'invoices');
    assert.deepEqual([inv.check.added, inv.check.skipped], [2, 1]);
    await imp.run(inv.args);
    const invs = (await query(`SELECT title, amount, status, note FROM crm_invoices WHERE deal_id = $1 ORDER BY amount`, [ruiz.id])).rows;
    assert.deepEqual(invs.map(i => [i.title, Number(i.amount), i.status]), [['Deposit', 12500, 'paid'], ['Framing draw', 18000, 'draft']]);
    assert.match(invs[0].note, /was #1043/);
    assert.equal(sent.length, 0, 'nobody is emailed by an import');
    assert.equal((await imp.check(inv.args)).added, 0, 'invoices aren’t doubled');
    const lg = await go('daily-logs.csv', b64(['Job,Date,Notes,Weather', 'Ruiz Kitchen,10/27/2026,Demo finished; dumpster hauled.,Sunny 78', 'Ruiz Kitchen,10/28/2026,"Plumber found a leak, fixed it.",Rain'].join('\n')), 'logs');
    await imp.run(lg.args);
    const logs = (await query(`SELECT body, crew, shared FROM crm_daily_logs WHERE deal_id = $1 ORDER BY log_date`, [ruiz.id])).rows;
    assert.equal(logs.length, 2); assert.equal(logs[1].body, 'Plumber found a leak, fixed it.'); assert.equal(logs[0].shared, false, 'kept private to the team');

    // 4. A file can be steered: told it's a different kind, and missing columns are named.
    const forced = await imp.preview({ filename: 'Schedule.csv', dataBase64: b64(sched), kind: 'tasks' });
    assert.equal(forced.kind, 'tasks');
    await assert.rejects(imp.check({ tenantId: t, userId: owner, filename: 'x.csv', dataBase64: b64('Foo,Bar\n1,2'), kind: 'vendors', mapping: {} }), /company name/);

    // 4b. Through the assistant: attach the export, a card says what will happen, then it's done.
    const A = require(R + '/lib/crmAssistant');
    const octx = { tenantId: t, userId: owner, manager: true, baseUrl: 'https://app.test' };
    const cf = await A.saveChatUpload(octx, { filename: 'QuickBooks Vendors.csv', dataBase64: b64('Vendor,Phone,Email,Account #\nHouston Lumber Supply,713-555-0177,orders@hlumber.test,A-1\n') });
    const card = await A.TOOLS.import_file.prepare(octx, { chat_file_id: cf.id });
    assert.match(card.summary.lines.join(' | '), /Subs and vendors from QuickBooks/); assert.match(card.summary.lines.join(' | '), /Will add 1/);
    await assert.rejects(A.TOOLS.import_file.prepare({ ...octx, userId: alex, manager: false }, { chat_file_id: cf.id }), /owner or an admin/);
    await A.TOOLS.import_file.execute(octx, card.payload);
    assert.ok((await query(`SELECT 1 FROM crm_vendors WHERE tenant_id = $1 AND name = 'Houston Lumber Supply'`, [t])).rows.length);
    await assert.rejects(A.TOOLS.import_file.prepare(octx, { chat_file_id: cf.id }), /nothing new/);

    // 5. Undo takes each import back out completely (and the job it made); nothing of another company's moves.
    const list = await imp.list(t);
    assert.ok(list.length >= 6 && list.every(i => i.kindLabel));
    assert.equal(list.find(i => i.filename === 'Buildertrend_SubsVendors.xlsx').platform, 'Buildertrend');
    await assert.rejects(imp.undo({ tenantId: t2, id: sr.id }), /not found/);
    for (const i of list) await imp.undo({ tenantId: t, id: i.id });
    assert.equal(await count('crm_vendors'), 1, 'only the sub that was already here');
    assert.equal(await count('crm_job_items'), 0); assert.equal(await count('crm_catalog_items'), 0); assert.equal(await count('crm_daily_logs'), 0);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_deals WHERE tenant_id = $1 AND title = 'Lee Addition'`, [t])).rows[0].n, 0);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_invoices WHERE tenant_id = $1`, [t])).rows[0].n, 0);
    assert.ok(await crm.getDeal(t, ruiz.id), 'the job that was already here stays');
    await assert.rejects(imp.undo({ tenantId: t, id: sr.id }), /already undone/);
    assert.equal(await count('crm_vendors', t2), 0);
    console.log('IMPORTS SCENARIO PASSED');
  } catch (e) {
    console.error('IMPORTS SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
