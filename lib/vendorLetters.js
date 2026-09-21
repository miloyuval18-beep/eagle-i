// Postal letters for vendors that can't (or shouldn't) be emailed — most of
// the directory has no published email, but many have a street address, either
// from the state record or from the Google lookup. The server decides who gets
// a letter and fills in each one; the browser lays out the PDF (jsPDF, same as
// the Permits mailer). The user prints and mails them, so nothing here sends
// anything — it only records which businesses were lettered so the same one
// isn't lettered twice by accident.
const crypto = require('crypto');
const { query } = require('../db');
const dir = require('./vendorDirectories');
const tpl = require('./outreachTemplate');

const RECENT_DAYS = 90;
const MAX_LETTERS = 200;

async function buildLetters({ tenantId, sourceKey, categoryKey, ids, message, includeWithEmail = false, includeRecentlyLettered = false }) {
  const source = dir.SOURCES[sourceKey];
  const category = source && source.categories[categoryKey];
  if (!source || !category) throw new Error('Unknown category.');
  const wanted = [...new Set((ids || []).map(n => parseInt(n, 10)).filter(Number.isFinite))].slice(0, MAX_LETTERS);
  if (!wanted.length) return { letters: [], skipped: [], batchId: null };

  const m = source.mail || { street: 'NULL', city: 'NULL', zip: 'NULL' };
  const rows = (await query(
    `SELECT id, ${source.name} AS name, ${dir.greetSql(source, category)} AS greet_first, ${source.extra || 'NULL'} AS extra,
            contact_email, email_check_status, places_formatted_address,
            ${m.street} AS street, ${m.city} AS city, ${m.zip} AS zip,
            (SELECT MAX(x.created_at) FROM vendor_mailings x
              WHERE x.tenant_id = $2 AND x.source = $3 AND x.source_id = ${source.table}.id) AS lettered_at
     FROM ${source.table} WHERE id = ANY($1)`,
    [wanted, tenantId, sourceKey]
  )).rows;
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const cutoff = Date.now() - RECENT_DAYS * 86400000;

  const letters = [];
  const skipped = [];
  for (const id of wanted) {
    const r = byId.get(id);
    if (!r) continue;
    const name = tpl.properName(r.name);
    const hasEmail = r.contact_email && r.email_check_status !== 'invalid';
    const lines = tpl.addressLines({ street: r.street, city: r.city, zip: r.zip, placesAddress: r.places_formatted_address });
    if (hasEmail && !includeWithEmail) { skipped.push({ id, name, reason: 'has_email' }); continue; }
    if (lines.length < 2) { skipped.push({ id, name, reason: 'no_address' }); continue; }
    if (r.lettered_at && new Date(r.lettered_at).getTime() > cutoff && !includeRecentlyLettered) { skipped.push({ id, name, reason: 'recently_lettered' }); continue; }

    const greeting = tpl.friendlyGreeting(r.name, r.greet_first);
    const { body, links } = tpl.splitLetterLinks(tpl.fillName(message, greeting));
    letters.push({
      id, name, greeting,
      attn: source.attnFromExtra && r.extra ? tpl.properName(r.extra) : null,
      addressLines: lines,
      paragraphs: body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean),
      links
    });
  }

  const batchId = crypto.randomUUID();
  for (const l of letters) {
    await query(
      `INSERT INTO vendor_mailings (tenant_id, source, source_id, vendor_name, address, batch_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, sourceKey, l.id, l.name, l.addressLines.join(', '), batchId]
    );
  }
  return { letters, skipped, batchId };
}

module.exports = { buildLetters, RECENT_DAYS, MAX_LETTERS };
