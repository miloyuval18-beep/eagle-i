// The home-screen assistant with Google Drive and "email anyone": a scripted
// model searches Drive, reads a plan, puts it on the job and emails a sub with
// it attached (after the person confirms). Fake Google, no network.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-only';
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'eaglei@test.iam.gserviceaccount.com', client_id: '1', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const ai = require(R + '/lib/anthropic');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const A = require(R + '/lib/crmAssistant'); const drive = require(R + '/lib/crmDrive'); const portal = require(R + '/lib/crmPortal');

// ---- a small fake Google Drive ----
const files = new Map(); let n = 0; const queries = [];
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const PDF = Buffer.from('%PDF-1.4\n% Garcia survey\n%%EOF');
drive.setHttp(async (url, opts = {}) => {
  const u = new URL(url); const m = opts.method || 'GET';
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'tok', expires_in: 3600 });
  const p = u.pathname.replace('/drive/v3', '').replace('/upload', '');
  if (m === 'POST' && p === '/drives') return json({ id: 'sd1' });
  if (p === '/changes/startPageToken') return json({ startPageToken: '0' });
  if (p === '/changes') return json({ changes: [], newStartPageToken: '0' });
  if (m === 'GET' && p === '/files') { queries.push(u.searchParams.get('q')); return json({ files: [...files.values()].filter(f => !f.folder && /Garcia/.test(u.searchParams.get('q')) && /Garcia/.test(f.name)).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.data.length), modifiedTime: '2026-10-01T00:00:00Z', parents: f.parents, webViewLink: 'https://drive.test/' + f.id })) }); }
  if (m === 'POST' && p === '/files' && u.searchParams.get('uploadType') === 'multipart') { const id = 'up' + (++n); files.set(id, { id, name: 'uploaded', data: Buffer.alloc(0), parents: [] }); return json({ id }); }
  if (m === 'POST' && p === '/files') { const b = JSON.parse(opts.body); const id = 'fo' + (++n); files.set(id, { id, name: b.name, folder: true, parents: b.parents, data: Buffer.alloc(0) }); return json({ id }); }
  const copy = p.match(/^\/files\/([^/]+)\/copy$/);
  if (copy) { const src = files.get(copy[1]); const b = JSON.parse(opts.body); const id = 'cp' + (++n); files.set(id, { ...src, id, name: b.name, parents: b.parents }); return json({ id, mimeType: src.mimeType, webViewLink: 'https://drive.test/' + id, modifiedTime: '2026-10-20T00:00:00Z', size: String(src.data.length) }); }
  const exp = p.match(/^\/files\/([^/]+)\/export$/);
  if (exp) return { ok: true, status: 200, arrayBuffer: async () => { const b = Buffer.from('Scope: new 14x18 primary suite, 10 ft plates.\u0000'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } }; // (a stray NUL, as some exports have)
  const one = p.match(/^\/files\/([^/]+)$/);
  const f = one && files.get(decodeURIComponent(one[1]));
  if (!f) return json({ error: { message: 'not found' } }, 404);
  if (u.searchParams.get('alt') === 'media') return { ok: true, status: 200, arrayBuffer: async () => f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.length) };
  if (m === 'PATCH') return json({ id: f.id });
  return json({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.data.length), webViewLink: 'https://drive.test/' + f.id, parents: f.parents });
});
files.set('survey1', { id: 'survey1', name: 'Garcia lot survey.pdf', mimeType: 'application/pdf', data: PDF, parents: ['somewhere'] });
files.set('doc1', { id: 'doc1', name: 'Garcia scope notes', mimeType: 'application/vnd.google-apps.document', data: Buffer.alloc(0), parents: ['somewhere'] });

// ---- a scripted model ----
let script = []; const seen = [];
ai.setClient(async ({ messages, tools }) => { seen.push({ last: messages[messages.length - 1], tools: tools.map(t => t.name) }); const next = script.shift(); if (!next) throw new Error('script ran out'); return next(messages); });
const result = (messages) => { const c = messages[messages.length - 1].content; return c.find(b => b.type === 'tool_result'); };
const say = (text) => () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const use = (name, input) => () => ({ content: [{ type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2, 8), name, input }], stop_reason: 'tool_use' });

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Home Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address) VALUES ($1, 'o@home.test', '1 Main St, Houston TX 77002')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@home.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const alex = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@home.test', 'x', 'Alex', 'member') RETURNING id`, [t])).rows[0].id;
    const ctx = { tenantId: t, userId: owner, name: 'Moran', role: 'owner', manager: true, baseUrl: 'https://x' };
    const actx = { tenantId: t, userId: alex, name: 'Alex', role: 'member', manager: false, baseUrl: 'https://x' };
    const deal = await crm.createDeal({ tenantId: t, name: 'Maria Garcia', email: 'maria@home.test', title: 'Garcia addition', userId: owner });
    await query(`INSERT INTO crm_google_connections (tenant_id, domain, admin_email) VALUES ($1, 'home.test', 'admin@home.test')`, [t]);

    // Without Drive switched on, the tools say so plainly.
    let thread = await A.createThread(ctx);
    script = [use('drive_search', { query: 'Garcia survey' }), (m) => { assert.match(result(m).content, /isn’t connected/); return say('Google Drive isn’t connected yet.')(); }];
    await A.runTurn(ctx, { threadId: thread.id, text: 'find the Garcia survey in drive' });
    await drive.enable(t);

    // 1. Search, read a PDF and a Google Doc, put the survey on the job.
    script = [
      use('drive_search', { query: 'Garcia survey' }),
      (m) => { const r = JSON.parse(result(m).content); assert.equal(r.files.length, 2); assert.equal(r.files[0].kind, 'PDF'); return use('drive_read', { file_id: 'survey1' })(); },
      (m) => { const r = result(m); assert.ok(Array.isArray(r.content) && r.content.some(b => b.type === 'document'), 'the PDF goes to the model as a document'); return use('drive_read', { file_id: 'doc1' })(); },
      (m) => { const r = result(m); assert.ok(r.content.some(b => b.type === 'text' && /14x18 primary suite/.test(b.text)), 'a Google Doc is read as text'); return use('drive_save_to_deal', { file_id: 'survey1', deal_id: deal.id, folder: 'permits' })(); },
      (m) => { const r = JSON.parse(result(m).content); assert.equal(r.folder, 'permits'); return say('Found it and put it on the Garcia job under Permits.')(); }
    ];
    const r1 = await A.runTurn(ctx, { threadId: thread.id, text: 'find the Garcia survey and the scope notes, read them, and put the survey on the job' });
    assert.match(r1.text, /Permits/);
    const onDeal = (await portal.listFiles(t, deal.id)).find(f => /survey/i.test(f.filename));
    assert.ok(onDeal && onDeal.folder === 'permits' && onDeal.in_drive, 'the copy is on the deal and in the job’s Drive folder');
    assert.ok(seen[seen.length - 1].tools.includes('send_email'));

    // 2. Email a sub (not the homeowner) with the survey attached: a card first, sent only when confirmed.
    script = [
      use('send_email', { to: ['Surveyor@Survey.test', 'bad-address'], subject: 'Garcia lot survey', message: 'Hi, see attached.', deal_id: deal.id, file_ids: [onDeal.id] }),
      (m) => { assert.match(result(m).content, /don’t look like email addresses: bad-address/); return use('send_email', { to: ['Surveyor@Survey.test'], cc: ['moran@home.test'], subject: 'Garcia lot survey', message: 'Hi, see attached.', deal_id: deal.id, file_ids: [onDeal.id] })(); },
      say('The email to the surveyor is ready. Tap Send to confirm.')
    ];
    const r2 = await A.runTurn(ctx, { threadId: thread.id, text: 'email the survey to surveyor@survey.test, cc me' });
    assert.equal(r2.actions.length, 1); assert.equal(sent.length, 0, 'nothing is sent before the person confirms');
    assert.deepEqual(r2.actions[0].summary.files, [onDeal.filename]);
    const done = await A.decideAction(ctx, r2.actions[0].id, true);
    assert.equal(done.status, 'done');
    const mail = sent[sent.length - 1];
    assert.deepEqual(mail.to, ['surveyor@survey.test']); assert.deepEqual(mail.cc, ['moran@home.test']);
    assert.equal(mail.attachments.length, 1); assert.equal(Buffer.from(mail.attachments[0].content, 'base64').slice(0, 5).toString(), '%PDF-');
    assert.ok((await crm.getDeal(t, deal.id)) && (await query(`SELECT 1 FROM crm_activities WHERE deal_id = $1 AND body LIKE 'Emailed surveyor@survey.test%'`, [deal.id])).rows.length, 'logged on the deal');

    // 3. A team member can't browse the owner's Drive through the assistant.
    const at = await A.createThread(actx);
    script = [use('drive_search', { query: 'Garcia' }), (m) => { assert.match(result(m).content, /Only the owner or an admin/); return say('Only the owner or an admin can search Drive.')(); }];
    await A.runTurn(actx, { threadId: at.id, text: 'search drive for Garcia' });

    // 4. The home screen's numbers and suggestions.
    const h = await A.home(ctx);
    assert.equal(h.drive, true); assert.ok(h.chips.some(c => /Google Drive/.test(c))); assert.ok(h.glance && h.glance.openDeals >= 1);
    assert.equal((await A.home(actx)).drive, false, 'members don’t get the Drive suggestion');
    console.log('ASK + DRIVE SCENARIO PASSED');
  } catch (e) {
    console.error('ASK + DRIVE SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
