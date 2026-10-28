// The companies in a group (Levi Construction Group → Levi Homes, …). One team,
// one set of roles and permissions for all of them; each company has its own
// profile, and each project (deal or job, with its files) belongs to one.
//
// The group's portfolio (/crm, public/crm-portfolio.html) lists them, each with
// a way into the CRM opened on that company.
const { query } = require('../db');

const GROUP_SLUG = 'levi-construction-group'; // tenants.slug of the group the portfolio shows
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); return t || null; };
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const slugOf = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'company';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PUBLIC = (s) => ({ id: s.id, name: s.name, slug: s.slug, what: s.what, services: s.services || [], about: s.about, address: s.address, phone: s.phone, email: s.email, website: s.website, logo: s.logo || null, upcoming: !!s.upcoming });

async function list(tenantId, { counts = false } = {}) {
  const rows = (await query(
    `SELECT s.*${counts ? `,
       (SELECT COUNT(*)::int FROM crm_deals d WHERE d.subsidiary_id = s.id AND d.stage NOT IN ('signed', 'production', 'complete', 'lost')) AS selling,
       (SELECT COUNT(*)::int FROM crm_deals d WHERE d.subsidiary_id = s.id AND d.stage IN ('signed', 'production')) AS jobs,
       (SELECT COUNT(*)::int FROM crm_deals d WHERE d.subsidiary_id = s.id AND d.stage = 'complete') AS done` : ''}
     FROM crm_subsidiaries s WHERE s.tenant_id = $1 AND s.archived_at IS NULL ORDER BY s.position, s.created_at`, [tenantId])).rows;
  return rows.map(r => ({ ...PUBLIC(r), ...(counts ? { selling: r.selling, jobs: r.jobs, done: r.done } : {}) }));
}

async function get(tenantId, idOrSlug) {
  const key = String(idOrSlug || '');
  return (await query(`SELECT * FROM crm_subsidiaries WHERE tenant_id = $1 AND archived_at IS NULL AND ${UUID.test(key) ? 'id = $2::uuid' : 'slug = $2'}`, [tenantId, key.toLowerCase()])).rows[0] || null;
}

// Add one (no id) or change one. { name, what, services: [] or "a, b", about, address, phone, email, website, upcoming }
async function save({ tenantId, id = null, body = {} }) {
  const cur = id ? await get(tenantId, id) : null;
  if (id && !cur) throw err('That company isn’t in your group.', 404);
  const name = 'name' in body ? clip(body.name, 80) : cur && cur.name;
  if (!name) throw err('Give the company a name.');
  const services = 'services' in body ? (Array.isArray(body.services) ? body.services : String(body.services || '').split(/[,\n]/)).map(x => clip(x, 40)).filter(Boolean).slice(0, 20) : cur ? cur.services : [];
  const email = 'email' in body ? clip(body.email, 200) : cur && cur.email;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err('That email address doesn’t look right.');
  let website = 'website' in body ? clip(body.website, 200) : cur && cur.website;
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website.replace(/^\/+/, '');
  const f = (k, n) => k in body ? clip(body[k], n) : cur ? cur[k] : null;
  const vals = [name, f('what', 120), services, f('about', 1000), f('address', 200), f('phone', 40), email, website, 'upcoming' in body ? !!body.upcoming : !!(cur && cur.upcoming)];
  if (cur) {
    return PUBLIC((await query(`UPDATE crm_subsidiaries SET name = $3, what = $4, services = $5, about = $6, address = $7, phone = $8, email = $9, website = $10, upcoming = $11 WHERE id = $1 AND tenant_id = $2 RETURNING *`, [cur.id, tenantId, ...vals])).rows[0]);
  }
  // A short name for its address (/crm/c/levi-homes), different from the others'.
  const base = slugOf(name);
  const taken = new Set((await query(`SELECT slug FROM crm_subsidiaries WHERE tenant_id = $1`, [tenantId])).rows.map(r => r.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  const pos = ((await query(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM crm_subsidiaries WHERE tenant_id = $1`, [tenantId])).rows[0] || {}).p || 0;
  return PUBLIC((await query(`INSERT INTO crm_subsidiaries (tenant_id, name, what, services, about, address, phone, email, website, upcoming, slug, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`, [tenantId, ...vals, slug, pos])).rows[0]);
}

// Taken off the list; its projects stay, just no longer under a company.
async function archive(tenantId, id) {
  const cur = await get(tenantId, id);
  if (!cur) throw err('That company isn’t in your group.', 404);
  await query(`UPDATE crm_subsidiaries SET archived_at = now() WHERE id = $1`, [cur.id]);
  await query(`UPDATE crm_deals SET subsidiary_id = NULL WHERE subsidiary_id = $1`, [cur.id]);
  return { ok: true };
}

// A company's profile: its details, its projects by where they stand, and its latest files.
async function profile({ tenantId, id, seeMoney = true }) {
  const s = await get(tenantId, id);
  if (!s) throw err('That company isn’t in your group.', 404);
  const deals = (await query(
    `SELECT d.id, d.title, d.stage, d.value, d.updated_at, c.name AS contact_name, p.address
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
     WHERE d.tenant_id = $1 AND d.subsidiary_id = $2 ORDER BY d.updated_at DESC LIMIT 300`, [tenantId, s.id])).rows
    .map(d => seeMoney ? d : { ...d, value: null });
  const files = (await query(
    `SELECT f.id, f.filename, f.folder, f.created_at, f.deal_id, d.title AS deal_title, f.drive_link
     FROM crm_files f JOIN crm_deals d ON d.id = f.deal_id
     WHERE f.tenant_id = $1 AND d.subsidiary_id = $2 AND f.superseded_at IS NULL ORDER BY f.created_at DESC LIMIT 40`, [tenantId, s.id])).rows;
  return {
    company: PUBLIC(s),
    selling: deals.filter(d => !['signed', 'production', 'complete', 'lost'].includes(d.stage)),
    jobs: deals.filter(d => ['signed', 'production'].includes(d.stage)),
    done: deals.filter(d => d.stage === 'complete').slice(0, 30),
    files
  };
}

// The name customers see on a project's emails and pages: the company in the
// group it belongs to (Levi Homes), or the company itself. The address, phone and
// sending address stay the main company's.
async function brandName(tenantId, dealId, fallback) {
  if (!dealId) return fallback;
  const r = (await query(`SELECT s.name FROM crm_deals d JOIN crm_subsidiaries s ON s.id = d.subsidiary_id WHERE d.id = $1 AND d.tenant_id = $2 AND s.archived_at IS NULL`, [dealId, tenantId]).catch(() => ({ rows: [] }))).rows[0];
  return r ? r.name : fallback;
}

// Its logo, for the customer's pages (the lion for Levi Homes), or null.
async function brandLogo(tenantId, dealId) {
  if (!dealId) return null;
  const r = (await query(`SELECT s.logo FROM crm_deals d JOIN crm_subsidiaries s ON s.id = d.subsidiary_id WHERE d.id = $1 AND d.tenant_id = $2 AND s.archived_at IS NULL`, [dealId, tenantId]).catch(() => ({ rows: [] }))).rows[0];
  return (r && r.logo) || null;
}

// For the public portfolio page: the group and its companies (what's on their websites anyway).
async function portfolio() {
  const t = (await query(`SELECT id, company_name FROM tenants WHERE slug = $1`, [GROUP_SLUG])).rows[0];
  if (!t) return { group: null, companies: [] };
  return { group: { name: t.company_name, slug: GROUP_SLUG }, companies: await list(t.id), tenantId: t.id };
}

module.exports = { GROUP_SLUG, slugOf, list, get, save, archive, profile, portfolio, brandName, brandLogo };
