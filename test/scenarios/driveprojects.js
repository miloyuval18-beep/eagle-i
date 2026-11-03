// Projects from the folders already in Google Drive: Eagle I reads the folders and file
// names, the AI picks the ones that are customer projects (with homeowner, address, stage),
// nothing is made until they're ticked; made as history (no automatic emails), each with a
// link back to its folder; the same one twice is skipped.
const { R } = require('./_local');
const assert = require('assert/strict');
process.env.ANTHROPIC_API_KEY = 'test';
const { query, pool } = require(R + '/db');
const D = require(R + '/lib/crmDrive');
let sentLines = '';
const ai = require(R + '/lib/anthropic');
ai.generateJSON = async (prompt) => {
  sentLines = prompt;
  return { projects: [
    { folder_id: 'f-hemmi', title: 'Hemmi Residence', homeowner: 'Veronica Hemmi', address: null, stage: 'production', company: 'Levi Homes', why: 'Recent photos and invoices' },
    { folder_id: 'f-stog', title: 'Stogner pool', homeowner: 'Stogner', address: '39 W Rivercrest Dr', stage: 'signed', why: 'Permits and contract' },
    { folder_id: 'nope', title: 'Made up', stage: 'proposal' }
  ] };
};
const tag = Date.now().toString(36);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Drive Co ${tag}', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO crm_subsidiaries (tenant_id, name, slug, what, position) VALUES ($1, 'Levi Homes', $2, 'Luxury home construction', 0), ($1, 'Trace the Leak', $3, null, 1)`, [t, 'lh' + tag, 'tl' + tag]);
    await query(`INSERT INTO crm_google_connections (tenant_id, kind, status, admin_email, domain, drive_on, drive_root_id, drive_shared_id) VALUES ($1, 'signin', 'connected', 'a@x.test', '', true, 'eagle', 'eagle')`, [t]);
    const folders = [
      { id: 'f-jobs', name: 'Jobs', parents: ['root'], driveId: 'sd1', createdTime: '2025-01-01T00:00:00Z' },
      { id: 'f-hemmi', name: 'Hemmi Residence', parents: ['f-jobs'], driveId: 'sd1', createdTime: '2026-03-02T00:00:00Z' },
      { id: 'f-hemmi-p', name: 'Plans', parents: ['f-hemmi'], driveId: 'sd1' },
      { id: 'f-stog', name: '39 W Rivercrest - Stogner', parents: ['f-jobs'], driveId: 'sd1', createdTime: '2026-05-10T00:00:00Z' },
      { id: 'f-hr', name: 'HR', parents: ['root'], driveId: 'sd1' },
      { id: 'f-eagle', name: 'Old job', parents: ['eagle'], driveId: 'eagle' }
    ];
    const files = [
      { name: 'A1.pdf', parents: ['f-hemmi-p'], modifiedTime: '2026-10-30T00:00:00Z' }, { name: 'Invoice 3.pdf', parents: ['f-hemmi'], modifiedTime: '2026-10-28T00:00:00Z' },
      { name: 'Permit.pdf', parents: ['f-stog'], modifiedTime: '2026-09-01T00:00:00Z' }, { name: 'Handbook.docx', parents: ['f-hr'], modifiedTime: '2024-01-01T00:00:00Z' },
      { name: 'x.pdf', parents: ['f-eagle'], modifiedTime: '2026-01-01T00:00:00Z' }
    ];
    D.call = async (conn, method, path, { params } = {}) => {
      if (path === '/drives') return { drives: [{ id: 'sd1', name: 'Levi Homes Projects' }] };
      return { files: /mimeType = /.test(params.q) ? folders : files };
    };
    const P = require(R + '/lib/crmDriveProjects');
    await P.request(t);
    assert.equal((await P.processRequests()).done >= 1, true);
    const s = await P.getState(t);
    assert.equal(s.status, 'done');
    assert.match(sentLines, /f-hemmi \| Levi Homes Projects \/ Jobs \/ Hemmi Residence \| 2 files/, 'paths and counts through subfolders');
    assert.ok(!/f-eagle/.test(sentLines), 'not Eagle I’s own drive');
    assert.deepEqual(s.projects.map(p => [p.title, p.stage, p.company]), [['Hemmi Residence', 'production', 'Levi Homes'], ['Stogner pool', 'signed', null]], 'only real folders; newest first');
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_deals WHERE tenant_id = $1`, [t])).rows[0].n, 0, 'nothing made until ticked');

    const r = await P.apply(t, ['f-hemmi', 'f-stog']);
    assert.equal(r.added, 2);
    const deals = (await query(`SELECT d.title, d.stage, d.subsidiary_id IS NOT NULL AS co, c.name AS homeowner, p.address FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id WHERE d.tenant_id = $1 ORDER BY d.title`, [t])).rows;
    assert.deepEqual(deals.map(d => [d.title, d.stage, d.co, d.homeowner]), [['Hemmi Residence', 'production', true, 'Veronica Hemmi'], ['Stogner pool', 'signed', false, 'Stogner']]);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_playbook_sends WHERE tenant_id = $1`, [t])).rows[0].n, 0, 'history: no automatic emails');
    assert.match((await query(`SELECT body FROM crm_activities WHERE tenant_id = $1 AND body LIKE 'Found in Google Drive%' LIMIT 1`, [t])).rows[0].body, /drive\.google\.com\/drive\/folders\//);
    // Again: nothing twice.
    assert.equal((await P.apply(t, ['f-hemmi'])).added, 0);
    // Their files on each project: listed, sorted by subfolder and name, opened from Drive (nothing copied).
    const kids = { 'f-hemmi': [{ id: 'f-hemmi-p', name: 'Plans', mimeType: 'application/vnd.google-apps.folder' }, { id: 'd-inv', name: 'Invoice 3.pdf', mimeType: 'application/pdf', size: '120000', modifiedTime: '2026-10-28T00:00:00Z', webViewLink: 'https://drive/x' }, { id: 'd-pic', name: 'IMG_1.jpg', mimeType: 'image/jpeg', size: '900000', modifiedTime: '2026-10-29T00:00:00Z' }],
      'f-hemmi-p': [{ id: 'd-a1', name: 'A1.pdf', mimeType: 'application/pdf', size: '5000000', modifiedTime: '2026-10-30T00:00:00Z' }], 'f-stog': [{ id: 'd-permit', name: 'Permit.pdf', mimeType: 'application/pdf', size: '1000' }] };
    D.driveOn = async () => ({ tenant_id: t, drive_shared_id: 'eagle' });
    D.call = async (conn, method, path, { params } = {}) => { const m = /^'([^']+)' in parents/.exec(params.q || ''); return { files: m ? (kids[m[1]] || []) : [] }; };
    assert.equal((await P.getState(t)).files_link, 'requested', 'asked for when they were added');
    await P.processFileLinks();
    const fl = (await query(`SELECT d.title, f.filename, f.folder, f.data IS NULL AS in_drive_only FROM crm_files f JOIN crm_deals d ON d.id = f.deal_id WHERE f.tenant_id = $1 ORDER BY d.title, f.filename`, [t])).rows;
    assert.deepEqual(fl.map(x => [x.title, x.filename, x.folder, x.in_drive_only]), [
      ['Hemmi Residence', 'A1.pdf', 'plans', true], ['Hemmi Residence', 'IMG_1.jpg', 'photos', true], ['Hemmi Residence', 'Invoice 3.pdf', 'other', true], ['Stogner pool', 'Permit.pdf', 'permits', true]]);
    assert.equal((await P.getState(t)).files_link, 'done');
    assert.equal((await query(`SELECT drive_folder_id FROM crm_deals WHERE tenant_id = $1 AND title = 'Hemmi Residence'`, [t])).rows[0].drive_folder_id, 'f-hemmi', 'its Drive home');
    // Again: nothing twice.
    (await P.getState(t)); await query(`UPDATE app_flags SET value = jsonb_set(value, '{files_link}', '"requested"') WHERE key = $1`, [`drive_projects:${t}`]);
    await P.processFileLinks();
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_files WHERE tenant_id = $1`, [t])).rows[0].n, 4);
    // Later, in Drive: a photo added two folders down, the invoice renamed, the permit's sheet deleted.
    // Read again (folders outside Eagle I's own drive aren't in Drive's change feed): the project follows.
    kids['f-hemmi'].push({ id: 'f-hemmi-ph', name: 'Photos', mimeType: 'application/vnd.google-apps.folder' });
    kids['f-hemmi-ph'] = [{ id: 'f-hemmi-ph-fr', name: 'Framing', mimeType: 'application/vnd.google-apps.folder' }];
    kids['f-hemmi-ph-fr'] = [{ id: 'd-new', name: 'stud wall.jpg', mimeType: 'image/jpeg', size: '300000', modifiedTime: '2026-11-03T00:00:00Z' }];
    kids['f-hemmi'].find(x => x.id === 'd-inv').name = 'Invoice 3 (paid).pdf';
    const hemmi = (await query(`SELECT id FROM crm_deals WHERE tenant_id = $1 AND title = 'Hemmi Residence'`, [t])).rows[0].id;
    let rr = await P.rescanOne(t, hemmi);
    assert.deepEqual([rr.added, rr.updated, rr.removed], [1, 1, 0]);
    const stog = (await query(`SELECT id FROM crm_deals WHERE tenant_id = $1 AND title = 'Stogner pool'`, [t])).rows[0].id;
    kids['f-stog'] = [];
    rr = await P.rescanOne(t, stog);
    assert.equal(rr.removed, 1, 'gone from Drive: taken off');
    const after = (await query(`SELECT filename, folder FROM crm_files WHERE tenant_id = $1 ORDER BY filename`, [t])).rows;
    assert.deepEqual(after.map(x => x.filename), ['A1.pdf', 'IMG_1.jpg', 'Invoice 3 (paid).pdf', 'stud wall.jpg']);
    assert.equal(after.find(x => x.filename === 'stud wall.jpg').folder, 'photos');
    assert.ok((await query(`SELECT drive_rescanned_at FROM crm_deals WHERE id = $1`, [hemmi])).rows[0].drive_rescanned_at, 'when it was last read');
    // Google not answering: nothing is taken off.
    D.call = async () => { throw new Error('Google is down'); };
    await assert.rejects(P.rescanOne(t, hemmi));
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_files WHERE tenant_id = $1`, [t])).rows[0].n, 4);
    // The background round runs (no Drive connection for this test company: nothing to do).
    assert.equal((await P.rescanDue()).errors, 0);
    console.log('DRIVE PROJECTS SCENARIO PASSED');
  } catch (e) {
    console.error('DRIVE PROJECTS SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query(`DELETE FROM app_flags WHERE key = $1`, [`drive_projects:${t}`]).catch(() => {});
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
