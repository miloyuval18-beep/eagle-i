// Gmail: emails already logged get their text filled in from the mailbox that has them.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
const { query, pool } = require(R + '/db');
const g = require(R + '/lib/crmGoogle');
const crm = require(R + '/lib/crm');
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Mail Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const sa = { client_email: 'eaglei@sa.test', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' };
    await query(`INSERT INTO crm_google_connections (tenant_id, domain, admin_email) VALUES ($1, 'mail.test', 'admin@mail.test')`, [t]);
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@home.test', title: 'Kitchen' });
    const row = (await query(`INSERT INTO crm_emails (tenant_id, message_key, mailbox_email, direction, from_email, to_emails, subject, snippet, sent_at, contact_id, deal_id)
      VALUES ($1, '<abc123@home.test>', 'sam@mail.test', 'in', 'ana@home.test', '{sam@mail.test}', 'Tile', 'We picked the', now(), $2, $3) RETURNING id`, [t, deal.contact_id, deal.id])).rows[0];
    const calls = [];
    const http = async (url, opts) => {
      calls.push(String(url));
      const json = (o) => ({ ok: true, status: 200, json: async () => o });
      if (/oauth2/.test(url)) return json({ access_token: 'tok', expires_in: 3600 });
      if (/messages\?/.test(url)) { assert.match(decodeURIComponent(url), /rfc822msgid:abc123@home\.test/); return json({ messages: [{ id: 'g1' }] }); }
      if (/messages\/g1/.test(url)) return json({ id: 'g1', payload: { mimeType: 'text/plain', body: { data: b64('We picked the zellige tile in white.\nCan install start the 3rd?\n\nOn Mon, Sam wrote:\n> Which tile?') } } });
      throw new Error('unexpected ' + url);
    };
    const r = await g.backfillBodies({ http, sa });
    assert.equal(r.filled, 1);
    const e = (await query('SELECT body_text, gmail_id FROM crm_emails WHERE id = $1', [row.id])).rows[0];
    assert.equal(e.body_text, 'We picked the zellige tile in white.\nCan install start the 3rd?'); assert.equal(e.gmail_id, 'g1');
    calls.length = 0;
    assert.equal((await g.backfillBodies({ http, sa })).filled, 0, 'tried once'); assert.equal(calls.length, 0);
    const hits = (await query(`SELECT id FROM crm_emails WHERE tenant_id = $1 AND to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body_text,'')) @@ websearch_to_tsquery('english', 'zellige')`, [t])).rows;
    assert.equal(hits.length, 1);
    console.log('GMAIL TEXT SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
