// Project files: folders, plan versions, more file types, and Google Drive
// both ways, against a fake Google (token endpoint + Drive API in memory).
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'eaglei@test.iam.gserviceaccount.com', client_id: '123', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const portal = require(R + '/lib/crmPortal'); const drive = require(R + '/lib/crmDrive');

// ---------- a fake Google Drive ----------
const files = new Map(); const changes = []; let n = 0; const calls = [];
const now = () => new Date(Date.now() + n * 1000).toISOString();
const touch = (f) => { f.modifiedTime = now(); changes.push({ fileId: f.id, removed: false, file: { ...f, data: undefined } }); };
const mk = (o) => { const f = { id: 'f' + (++n), trashed: false, appProperties: {}, ...o }; files.set(f.id, f); touch(f); return f; };
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, arrayBuffer: async () => new ArrayBuffer(0) });
function parseMultipart(buf, ctype) {
  const b = '--' + ctype.match(/boundary=(.+)$/)[1];
  const s = buf.toString('latin1');
  const p1 = s.indexOf('\r\n\r\n') + 4, e1 = s.indexOf('\r\n' + b, p1);
  const meta = JSON.parse(buf.slice(p1, e1).toString('utf8'));
  const p2 = s.indexOf('\r\n\r\n', e1) + 4, e2 = s.lastIndexOf('\r\n' + b + '--');
  return { meta, data: buf.slice(p2, e2) };
}
drive.setHttp(async (url, opts = {}) => {
  const u = new URL(url); const m = opts.method || 'GET'; calls.push(`${m} ${u.pathname}`);
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'tok', expires_in: 3600 });
  const p = u.pathname.replace('/drive/v3', '').replace('/upload', '');
  if (m === 'POST' && p === '/drives') return json({ id: 'shared1' });
  if (m === 'GET' && p === '/changes/startPageToken') return json({ startPageToken: String(changes.length) });
  if (m === 'GET' && p === '/changes') { const from = Number(u.searchParams.get('pageToken')); return json({ changes: changes.slice(from), newStartPageToken: String(changes.length) }); }
  if (m === 'POST' && p === '/files' && u.searchParams.get('uploadType') === 'multipart') {
    const { meta, data } = parseMultipart(Buffer.from(opts.body), opts.headers['Content-Type']);
    const f = mk({ name: meta.name, parents: meta.parents, appProperties: meta.appProperties || {}, mimeType: 'application/octet-stream', size: String(data.length), data, webViewLink: 'https://drive.test/view' });
    return json({ id: f.id, webViewLink: f.webViewLink, modifiedTime: f.modifiedTime });
  }
  if (m === 'POST' && p === '/files') { const b = JSON.parse(opts.body); return json({ id: mk({ name: b.name, mimeType: b.mimeType, parents: b.parents }).id }); }
  const id = (p.match(/^\/files\/([^/]+)$/) || [])[1];
  const f = id && files.get(decodeURIComponent(id));
  if (!f) return json({ error: { message: 'not found' } }, 404);
  if (m === 'GET' && u.searchParams.get('alt') === 'media') return { ok: true, status: 200, arrayBuffer: async () => f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.length) };
  if (m === 'GET') return json({ parents: f.parents });
  if (m === 'PATCH') {
    const b = opts.body ? JSON.parse(opts.body) : {};
    if (u.searchParams.get('addParents')) f.parents = [...f.parents.filter(x => !(u.searchParams.get('removeParents') || '').split(',').includes(x)), u.searchParams.get('addParents')];
    if (b.name) f.name = b.name;
    if (b.trashed) f.trashed = true;
    touch(f); return json({ id: f.id });
  }
  return json({ error: { message: 'unexpected ' + m + ' ' + p } }, 400);
});

const JPEG = (k = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200 + k), Buffer.from([0xff, 0xd9])]);
const PDF = (size = 300) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size, 0x20), Buffer.from('\n%%EOF')]);
const DOCX = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), crypto.randomBytes(100)]);
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Drive Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const u = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'sam@drive.test', 'x', 'Sam', 'owner') RETURNING id`, [t])).rows[0].id;
    await query(`INSERT INTO business_profile (tenant_id, email) VALUES ($1, 'o@drive.test')`, [t]);
    const deal = await crm.createDeal({ tenantId: t, name: 'Maria Garcia', email: 'maria@drive.test', title: 'Garcia kitchen', userId: u });

    // 1. Without Drive: folders and versions work; more file types; 8 MB limit with a pointer to Drive.
    const ph = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'IMG_2201.jpg', buffer: JPEG(), userId: u });
    assert.equal(ph.folder, 'photos');
    const permit = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'Building Permit.pdf', buffer: PDF(), userId: u });
    assert.equal(permit.folder, 'permits');
    const docx = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'Scope of work.docx', buffer: DOCX, userId: u });
    assert.equal(docx.kind, 'document'); assert.match(docx.content_type, /wordprocessingml/);
    await assert.rejects(portal.addFile({ tenantId: t, dealId: deal.id, filename: 'x.html', buffer: Buffer.from('<html><script>alert(1)</script>'), userId: u }), /can’t be added/);
    await assert.rejects(portal.addFile({ tenantId: t, dealId: deal.id, filename: 'notes.txt', buffer: Buffer.from('<svg onload=alert(1)>'), userId: u }), /can’t be added/, 'markup in a text file is refused');
    await assert.rejects(portal.addFile({ tenantId: t, dealId: deal.id, filename: 'Plans.docx', buffer: DOCX, userId: u, fromHomeowner: true }), /Only photos/);
    await assert.rejects(portal.addFile({ tenantId: t, dealId: deal.id, filename: 'big.pdf', buffer: PDF(9 * 1024 * 1024), userId: u }), /8 MB, or 50 MB once Google Drive/);
    const a1 = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'A1 Floor Plan rev1.pdf', buffer: PDF(), userId: u });
    assert.equal(a1.folder, 'plans'); assert.equal(a1.version, 1);
    const a1b = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'A1 Floor Plan rev2.pdf', buffer: PDF(400), userId: u });
    assert.equal(a1b.version, 2); assert.equal(a1b.replaced, 'A1 Floor Plan rev1.pdf');
    const e1 = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'E1 Electrical.pdf', buffer: PDF(), userId: u });
    assert.equal(e1.version, 1, 'a different sheet is not a version');
    assert.deepEqual(await portal.latestVersions([a1.id, e1.id]).then(x => x.sort()), [a1b.id, e1.id].sort(), 'bid requests see the newest plans');
    // The homeowner never sees an old version.
    await portal.updateFile({ tenantId: t, id: a1.id, shared: true }); await portal.updateFile({ tenantId: t, id: a1b.id, shared: true });
    const pv = await portal.portalView(await portal.portalToken(t, deal.id));
    assert.ok(pv.files.some(f => f.id === a1b.id) && !pv.files.some(f => f.id === a1.id));
    // Deleting the current plan brings the one before it back.
    const a1c = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'A1 Floor Plan rev3.pdf', buffer: PDF(500), userId: u });
    await portal.deleteFile({ tenantId: t, id: a1c.id });
    assert.equal((await portal.getFile(t, a1b.id)).superseded_at, null);
    // "Not a new version" pulls it out of the chain.
    await portal.updateFile({ tenantId: t, id: a1b.id, splitVersion: true });
    assert.equal((await portal.getFile(t, a1b.id)).version, 1);
    assert.equal((await portal.getFile(t, a1.id)).superseded_at, null, 'the other one is current again');

    // 2. Drive on: a shared drive, folders per job, files copied over.
    await query(`INSERT INTO crm_google_connections (tenant_id, domain, admin_email) VALUES ($1, 'drive.test', 'admin@drive.test')`, [t]);
    const st = await drive.enable(t);
    assert.equal(st.on, true); assert.equal(st.sharedDrive, true);
    const s1 = await drive.processDriveSync();
    assert.ok(s1.folders >= 1); assert.equal(s1.pushed, 6, 'every existing file is copied to Drive');
    const map = (await query('SELECT drive_folders FROM crm_deals WHERE id = $1', [deal.id])).rows[0].drive_folders;
    for (const k of ['plans', 'permits', 'contracts', 'photos', 'selections', 'receipts', 'warranties', 'other', 'old']) assert.ok(map[k], k);
    const inDrive = (id) => [...files.values()].find(f => f.appProperties.eagleiFileId === id);
    assert.deepEqual(inDrive(permit.id).parents, [map.permits]);
    assert.ok((await portal.getFile(t, ph.id)).data, 'small files keep a copy here');

    // A big file (only in Drive) and a new plan version (the old one moves to "Old versions").
    const big = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'Full plan set.pdf', buffer: PDF(9 * 1024 * 1024), userId: u });
    const bigRow = await portal.getFile(t, big.id);
    assert.equal(bigRow.data, null); assert.ok(bigRow.drive_id);
    assert.equal((await portal.fileData(bigRow)).length, 9 * 1024 * 1024 + 15, 'opened straight from Drive');
    const s2 = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'S1 Foundation.pdf', buffer: PDF(), userId: u });
    await new Promise(r => setTimeout(r, 300));
    const s2b = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'S1 Foundation (revised).pdf', buffer: PDF(350), userId: u });
    assert.equal(s2b.version, 2);
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(inDrive(s2.id).parents, [map.old], 'the old version moved to Plans/Old versions');

    // Moving, renaming and deleting in Eagle I follow in Drive.
    await portal.updateFile({ tenantId: t, id: docx.id, folder: 'contracts' });
    assert.deepEqual(inDrive(docx.id).parents, [map.contracts]);
    await portal.updateFile({ tenantId: t, id: docx.id, filename: 'Signed scope' });
    assert.equal(inDrive(docx.id).name, 'Signed scope.docx');
    await portal.deleteFile({ tenantId: t, id: ph.id });
    assert.equal(inDrive(ph.id).trashed, true, 'deleted here: in Drive’s trash, restorable');

    // 3. Changes made in Drive come back.
    await drive.processDriveSync(); // catch up on our own changes (nothing should break)
    assert.ok(await portal.getFile(t, permit.id), 'our own uploads stay put');
    const dropped = mk({ name: 'Survey.pdf', mimeType: 'application/pdf', parents: [map.permits], size: '1234', webViewLink: 'https://drive.test/s', data: PDF() });
    const gdoc = mk({ name: 'Punch notes', mimeType: 'application/vnd.google-apps.document', parents: [map.other], webViewLink: 'https://docs.test/d' });
    mk({ name: 'Unrelated.pdf', mimeType: 'application/pdf', parents: ['somewhere-else'], data: PDF() });
    const s3 = await drive.processDriveSync();
    assert.equal(s3.added, 2);
    const row = (await query('SELECT * FROM crm_files WHERE drive_id = $1', [dropped.id])).rows[0];
    assert.equal(row.folder, 'permits'); assert.equal(row.deal_id, deal.id); assert.equal(row.data, null);
    assert.equal((await portal.fileData(row)).slice(0, 5).toString(), '%PDF-');
    assert.equal(await portal.fileData((await query('SELECT * FROM crm_files WHERE drive_id = $1', [gdoc.id])).rows[0]), null, 'a Google Doc opens in Drive');
    dropped.parents = [map.contracts]; touch(dropped);
    await drive.processDriveSync();
    assert.equal((await query('SELECT folder FROM crm_files WHERE drive_id = $1', [dropped.id])).rows[0].folder, 'contracts', 'moved in Drive, moved here');
    dropped.trashed = true; touch(dropped);
    await drive.processDriveSync();
    assert.equal((await query('SELECT 1 FROM crm_files WHERE drive_id = $1', [dropped.id])).rows.length, 0, 'deleted in Drive, gone here');
    // Edited in Drive: the stale copy here is dropped and fetched fresh.
    const pf = inDrive(permit.id); pf.data = PDF(999); touch(pf);
    await drive.processDriveSync();
    assert.equal((await portal.getFile(t, permit.id)).data, null);
    assert.equal((await portal.fileData(await portal.getFile(t, permit.id))).length, 999 + 15);

    // 4. Switching off deletes nothing; status reads right.
    const off = await drive.disable(t);
    assert.equal(off.on, false); assert.ok(await portal.getFile(t, big.id));
    assert.match(drive.SCOPE, /auth\/drive$/);
    console.log('DRIVE SCENARIO PASSED');
  } catch (e) {
    console.error('DRIVE SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
