// One registry + generic query layer over every verified-vendor source
// (TBAE, TDLR, TSBPE, TBPELS, TREC, TDI escrow, TDA, TDI agencies,
// Comptroller trades). Each source keeps its own table, importer, and
// monthly worker — this only unifies how the panel LISTS, FILTERS, RANKS,
// and saves contact info, so filters, Top-N selection, and bulk outreach
// behave identically in every category instead of being re-implemented
// (and drifting) nine times.
//
// Every SQL fragment below is a hard-coded constant from this file, never
// user input — user-controlled values (search text, cities, ids) always go
// through numbered parameters.
const { query } = require('../db');
const tbae = require('./tbaeRegistrants');
const tdlr = require('./tdlrRegistrants');
const tsbpe = require('./tsbpeRegistrants');
const tbpels = require('./tbpelsRegistrants');
const trec = require('./trecRegistrants');
const tdi = require('./tdiRegistrants');
const tda = require('./tdaRegistrants');
const agencies = require('./tdiAgencies');
const trades = require('./comptrollerTrades');
const { friendlyGreeting } = require('./outreachTemplate');

const METRO_CITIES = agencies.HOUSTON_METRO_CITIES;
const person = (a, b, c) => `NULLIF(TRIM(CONCAT_WS(' ', ${a}, ${b}, ${c})), '')`;
const countyArea = (col) => `(CASE WHEN ${col} IS NOT NULL THEN INITCAP(${col}) || ' County, ' ELSE '' END || 'Houston, TX')`;
const cityArea = (col) => `(COALESCE(NULLIF(${col}, ''), 'Houston') || ', TX')`;

const SOURCES = {
  tbae: {
    table: 'tbae_registrants',
    intent: 'capacity', execute: 'execute design', ask: 'a few samples of your portfolio', greet: "NULLIF(first_name, '')",
    mail: { street: 'NULL', city: "NULLIF(city, '')", zip: 'NULL' }, attnFromExtra: true,
    sinceLabel: 'Licensed since',
    section: {
      icon: '🏛️', title: 'Houston Architects, Interior Designers & Landscape Architects',
      blurb: 'Real, currently-licensed design professionals in the Houston area, pulled directly from the Texas Board of Architectural Examiners\' own public roster. Only firms with a published firm name are listed.',
      badge: { text: '🏛️ TBAE REGISTERED', tone: 'green' }
    },
    categories: {
      architect: { label: 'Architects', noun: 'architecture firm', plural: 'architects', param: 'architect' },
      interior_designer: { label: 'Interior Designers', noun: 'interior design firm', plural: 'interior designers', param: 'interior_designer' },
      landscape_architect: { label: 'Landscape Architects', noun: 'landscape architecture firm', plural: 'landscape architects', param: 'landscape_architect' }
    },
    where: (push, cat) => [`profession = ${push(cat.param)}`, "lic_status = 'Active'", `UPPER(city) = ANY(${push(tbae.HOUSTON_METRO_CITIES)})`, 'firm_name IS NOT NULL'],
    name: 'firm_name', location: 'city', locationLabel: 'City', phone: 'phone',
    since: 'init_lic_date', expires: 'lic_exp_date',
    extra: person('prefix', 'first_name', 'last_name'),
    searchText: "CONCAT_WS(' ', firm_name, first_name, last_name)",
    lookup: { city: 'city', zip: 'NULL', area: cityArea('city'), alt: 'NULL' },
    savePhone: true
  },
  tdlr: {
    table: 'tdlr_registrants',
    intent: 'capacity', execute: 'execute', ask: 'a few photos of recent projects',
    mail: { street: "NULLIF(business_address_line1, '')", city: "NULLIF(business_city, '')", zip: "NULLIF(business_zip, '')" },
    section: {
      icon: '⚡', title: 'Houston Trade Contractors (TDLR)',
      blurb: 'Real, currently-licensed contracting businesses in the Houston metro area, from the Texas Department of Licensing and Regulation\'s public dataset — including a real business phone number straight from the state. (Plumbers are licensed by a separate board — see below. Texas has no state license for general contractors or roofers, so those aren\'t available this way.)',
      badge: { text: '⚡ TDLR LICENSED', tone: 'green' }
    },
    categories: {
      ec: { label: 'Electricians', noun: 'electrical contracting business', plural: 'electrical contractors', param: 'Electrical Contractor' },
      ac: { label: 'A/C Contractors', noun: 'A/C contracting business', plural: 'A/C contractors', param: 'A/C Contractor' },
      ww: { label: 'Water Well Drillers', noun: 'water well drilling business', plural: 'water well drillers', param: 'Water Well Driller/Pump Installer' },
      ai: { label: 'Appliance Installers', noun: 'appliance installation business', plural: 'appliance installers', param: 'Appliance Installation Contractor' },
      el: { label: 'Elevator Contractors', noun: 'elevator contracting business', plural: 'elevator contractors', param: 'Elevator Contractor' }
    },
    where: (push, cat) => [`license_type = ${push(cat.param)}`, 'business_name IS NOT NULL', 'license_expiration_date IS NOT NULL', 'license_expiration_date >= CURRENT_DATE', `UPPER(business_county) = ANY(${push(tdlr.HOUSTON_METRO_COUNTIES)})`],
    // A/C contractors carry only a county in the source (no city or zip),
    // so location falls back to it rather than showing blank.
    name: 'business_name', location: "COALESCE(NULLIF(business_city, ''), INITCAP(business_county))", locationLabel: 'City / County', phone: 'business_phone',
    since: null, expires: 'license_expiration_date', extra: 'NULLIF(owner_name, \'\')',
    searchText: "CONCAT_WS(' ', business_name, owner_name)",
    lookup: { city: "NULLIF(business_city, '')", zip: "NULLIF(business_zip, '')", area: "(COALESCE(NULLIF(business_city, ''), INITCAP(business_county) || ' County', 'Houston') || ', TX')", alt: 'NULL' },
    savePhone: false
  },
  tsbpe: {
    table: 'tsbpe_registrants',
    intent: 'capacity', execute: 'execute', ask: 'a few photos of recent projects', greet: "NULLIF(first_name, '')",
    mail: { street: "NULLIF(address_line1, '')", city: "NULLIF(city, '')", zip: "NULLIF(zip, '')" }, attnFromExtra: true,
    sinceLabel: 'Licensed since',
    section: {
      icon: '🔧', title: 'Houston Plumbers',
      blurb: 'Real, currently-licensed Responsible Master Plumbers in the Houston metro area — the license that means "licensed to run their own plumbing business" — from the Texas State Board of Plumbing Examiners\' public dataset. Includes a real business phone number and whether liability insurance is currently active, a genuine second quality signal.',
      badge: { text: '🔧 TSBPE LICENSED', tone: 'green' }
    },
    categories: { plumber: { label: 'Plumbers', noun: 'plumbing business', plural: 'plumbers' } },
    where: (push) => ["lic_status = 'Current'", `UPPER(county) = ANY(${push(tsbpe.HOUSTON_METRO_COUNTIES)})`],
    name: `COALESCE(NULLIF(plumb_company, ''), ${person('first_name', 'middle_name', 'last_name')})`,
    location: 'city', locationLabel: 'City', phone: 'phone',
    since: 'license_date', expires: 'expiration_date', extra: person('first_name', 'middle_name', 'last_name'),
    insured: 'insurance_expiry_date >= CURRENT_DATE',
    searchText: "CONCAT_WS(' ', plumb_company, first_name, last_name)",
    lookup: { city: 'city', zip: 'zip', area: cityArea('city'), alt: 'NULL' },
    savePhone: false
  },
  tbpels: {
    table: 'tbpels_registrants',
    intent: 'capacity', execute: 'execute', ask: 'a few examples of recent projects',
    mail: { street: "NULLIF(address_line1, '')", city: "NULLIF(city, '')", zip: "NULLIF(zip, '')" },
    section: {
      icon: '🏗️', title: 'Houston Engineering & Surveying Firms',
      blurb: 'Real, currently-registered engineering and land-surveying firms in the Houston metro area, from the Texas Board of Professional Engineers and Land Surveyors\' public firm roster — including a real business address and phone number straight from the state.',
      badge: { text: '🏗️ TBPELS REGISTERED', tone: 'green' }
    },
    categories: { firm: { label: 'Engineering & Surveying Firms', noun: 'engineering or surveying firm', plural: 'engineering and surveying firms' } },
    where: (push) => ['firm_name IS NOT NULL', 'expire_date IS NOT NULL', 'expire_date >= CURRENT_DATE', `UPPER(city) = ANY(${push(tbpels.HOUSTON_METRO_CITIES)})`],
    name: 'firm_name', location: 'city', locationLabel: 'City', phone: 'phone',
    since: null, expires: 'expire_date', extra: "NULLIF(firm_type, '')",
    searchText: 'firm_name',
    lookup: { city: 'city', zip: 'zip', area: cityArea('city'), alt: 'NULL' },
    savePhone: false
  },
  trec: {
    table: 'trec_registrants',
    intent: 'referral', ask: 'a quick note about your business',
    sinceLabel: 'Licensed since',
    section: {
      icon: '🏘️', title: 'Houston Real Estate Brokers',
      blurb: 'Real, currently-active real estate brokerages and individual brokers in the Houston metro area, from the Texas Real Estate Commission\'s public dataset — a strong referral-partner category. TREC\'s data has no phone or address, so contact info here always comes from the Google lookup.',
      badge: { text: '🏘️ TREC LICENSED', tone: 'green' }
    },
    categories: {
      bc: { label: 'Brokerages', noun: 'real estate brokerage', plural: 'real estate brokerages', param: 'Broker Company' },
      bi: { label: 'Individual Brokers', noun: 'real estate broker', plural: 'real estate brokers', param: 'Broker Individual', greet: "NULLIF(split_part(full_name, ' ', 1), '')" }
    },
    where: (push, cat) => [`license_type = ${push(cat.param)}`, "status = 'Active'", 'full_name IS NOT NULL', `UPPER(county) = ANY(${push(trec.HOUSTON_METRO_COUNTIES)})`],
    name: 'full_name', location: 'county', locationLabel: 'County', phone: 'phone',
    since: 'original_license_date', expires: 'expiration_date', extra: 'NULL',
    searchText: 'full_name',
    lookup: { city: 'NULL', zip: 'NULL', area: countyArea('county'), alt: 'NULL' },
    savePhone: true
  },
  tdi: {
    table: 'tdi_registrants',
    intent: 'referral', ask: 'a quick note about your business',
    section: {
      icon: '📋', title: 'Houston Title & Escrow Professionals',
      blurb: 'Real, currently-licensed escrow officers in the Houston metro area — the people who close real estate transactions at a title company — from the Texas Department of Insurance\'s public dataset. Honest limitation: TDI gives no title-company name or phone, just an individual\'s name, so the Google lookup searches by that name alone. Expect a lower hit rate than the other categories.',
      badge: { text: '📋 TDI LICENSED', tone: 'green' }
    },
    categories: { escrow: { label: 'Title & Escrow Officers', noun: 'title and escrow professional', plural: 'title and escrow professionals' } },
    where: (push) => ["license_type = 'Escrow Officer'", 'name IS NOT NULL', 'expiration_date >= CURRENT_DATE', `UPPER(city) = ANY(${push(tdi.HOUSTON_METRO_CITIES)})`],
    name: 'name', location: 'city', locationLabel: 'City', phone: 'phone',
    since: null, expires: 'expiration_date', extra: 'NULL',
    searchText: 'name',
    lookup: { city: 'city', zip: 'postal_code', area: cityArea('city'), alt: 'NULL' },
    savePhone: true
  },
  tda: {
    table: 'tda_registrants',
    intent: 'capacity', execute: 'execute', ask: 'a short overview of your services and coverage area',
    sinceLabel: 'Licensed since',
    section: {
      icon: '🐜', title: 'Houston Pest Control & Termite Companies',
      blurb: 'Real, currently-licensed structural pest control businesses in the Houston metro area, from the Texas Department of Agriculture\'s public dataset — including whether their liability insurance is currently active, a genuine second quality signal.',
      badge: { text: '🐜 TDA LICENSED', tone: 'green' }
    },
    categories: { pest: { label: 'Pest Control Companies', noun: 'pest control business', plural: 'pest control companies' } },
    where: (push) => ['legal_business_name IS NOT NULL', 'license_expired_date IS NOT NULL', 'license_expired_date >= CURRENT_DATE', `UPPER(county) = ANY(${push(tda.HOUSTON_METRO_COUNTIES)})`],
    name: "COALESCE(NULLIF(dba, ''), legal_business_name)", location: 'county', locationLabel: 'County', phone: 'phone',
    since: 'license_issued_date', expires: 'license_expired_date', extra: 'NULL',
    insured: 'insurance_expired_date >= CURRENT_DATE',
    searchText: "CONCAT_WS(' ', legal_business_name, dba)",
    lookup: { city: 'NULL', zip: 'NULL', area: countyArea('county'), alt: 'legal_business_name' },
    savePhone: false
  },
  agency: {
    table: 'tdi_agencies',
    intent: 'referral', ask: 'a quick note about your agency',
    mail: { street: 'NULL', city: "NULLIF(city, '')", zip: "NULLIF(postal_code, '')" },
    section: {
      icon: '🛡️', title: 'Houston Insurance Agencies',
      blurb: 'Real, currently-licensed insurance agencies with a Houston-metro address, from the Texas Department of Insurance\'s public agency data — general lines (commercial coverage, builders risk, bonding), specialty and surplus lines, and public adjuster firms, a natural referral source on storm and restoration jobs. TDI has no phone and doesn\'t say which agencies write construction business, so check what each agency actually writes.',
      badge: { text: '📋 TDI LICENSED', tone: 'green' }
    },
    categories: {
      general: { label: 'General & Personal Lines', noun: 'insurance agency', plural: 'insurance agencies', param: agencies.GROUPS.general.types },
      specialty: { label: 'Specialty, Surplus Lines & MGAs', noun: 'specialty insurance agency', plural: 'specialty insurance agencies', param: agencies.GROUPS.specialty.types },
      adjuster: { label: 'Public Adjusters', noun: 'public adjuster firm', plural: 'public adjusters', param: agencies.GROUPS.adjuster.types }
    },
    where: (push, cat) => [`license_type = ANY(${push(cat.param)})`, 'org_name IS NOT NULL', 'expiration_date >= CURRENT_DATE', `UPPER(city) = ANY(${push(agencies.HOUSTON_METRO_CITIES)})`],
    name: 'org_name', location: 'city', locationLabel: 'City', phone: 'phone',
    since: null, expires: 'expiration_date', extra: 'NULL',
    searchText: 'org_name',
    lookup: { city: 'city', zip: 'postal_code', area: cityArea('city'), alt: 'NULL' },
    savePhone: true
  },
  trade: {
    table: 'comptroller_trades',
    intent: 'capacity', execute: 'execute', ask: 'a few photos of recent projects',
    mail: { street: "NULLIF(outlet_address, '')", city: "NULLIF(outlet_city, '')", zip: "NULLIF(outlet_zip, '')" },
    sinceLabel: 'Permitted since',
    section: {
      icon: '🔨', title: 'Houston Trade Subcontractors',
      blurb: 'Houston-area specialty-trade businesses that no Texas board licenses, found through the state Comptroller\'s sales-tax permit records by industry code. This is not a license and not a quality guarantee: it confirms an active state tax permit at a real address and how long the business has operated. It only covers contractors who hold a sales-tax permit, so it\'s a partial list. After a lookup, the business\'s Google rating and review count appear as a second signal — check both before hiring.',
      badge: { text: '🧾 STATE TAX-REGISTERED · NOT LICENSED', tone: 'amber' }
    },
    categories: Object.fromEntries(Object.entries(trades.TRADES).map(([k, t]) => [k, { label: t.label, noun: t.noun, plural: t.noun.replace(/ \(.*\)$/, '') + 's', param: t.naics }])),
    where: (push, cat) => [`naics_code = ${push(cat.param)}`, 'active = true', 'COALESCE(outlet_name, taxpayer_name) IS NOT NULL'],
    name: "COALESCE(NULLIF(outlet_name, ''), taxpayer_name)", location: 'outlet_city', locationLabel: 'City', phone: 'phone',
    since: 'COALESCE(first_sales_date, permit_issue_date)', expires: null,
    extra: "(CASE WHEN outlet_name IS NOT NULL AND taxpayer_name IS NOT NULL AND UPPER(outlet_name) <> UPPER(taxpayer_name) THEN 'Legal name: ' || taxpayer_name END)",
    searchText: "CONCAT_WS(' ', outlet_name, taxpayer_name)",
    lookup: { city: 'outlet_city', zip: 'outlet_zip', area: "CONCAT_WS(', ', NULLIF(outlet_address, ''), COALESCE(NULLIF(outlet_city, ''), 'Houston'), 'TX')", alt: 'taxpayer_name' },
    savePhone: true
  }
};

const SORTS = ['ready', 'tenure', 'rating', 'name'];

// Government start dates include placeholder values (hundreds of Texas
// plumbers carry a license date around 1901), which would sort as "most
// established" and print as a fake founding year. Anything before this is
// treated as unknown rather than ranked on.
const MIN_PLAUSIBLE_START = '1940-01-01';
const sinceSql = (source) => source.since
  ? `(CASE WHEN (${source.since}) >= DATE '${MIN_PLAUSIBLE_START}' THEN (${source.since}) END)`
  : null;

function formatPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length !== 10) return raw;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function resolve(sourceKey, categoryKey) {
  const source = SOURCES[sourceKey];
  if (!source) throw new Error('Unknown source.');
  const cat = source.categories[categoryKey];
  if (!cat) throw new Error('Unknown category.');
  return { source, cat };
}

// What the UI needs to build every panel — titles, blurbs, badges,
// category buttons, the location filter's label, and which sorts make sense.
function getCatalog() {
  return Object.entries(SOURCES).map(([key, s]) => ({
    key,
    ...s.section,
    locationLabel: s.locationLabel,
    hasTenure: !!s.since,
    sinceLabel: s.sinceLabel || null,
    categories: Object.entries(s.categories).map(([ck, c]) => ({ key: ck, label: c.label, noun: c.noun }))
  }));
}

// An email on file that verification has not ruled out (a domain that can't
// receive mail is treated as no email at all).
const USABLE_EMAIL = "contact_email IS NOT NULL AND contact_email <> '' AND COALESCE(email_check_status, '') <> 'invalid'";

// Can a letter be addressed? Either the source itself has a street address, or
// a Google lookup has found one.
const hasAddressSql = (source) => `(${source.mail ? source.mail.street : 'NULL'} IS NOT NULL OR (places_formatted_address IS NOT NULL AND places_formatted_address <> ''))`;

// Builds "WHERE ..." + params for one category and the shared filters.
// `push` appends a value and returns its $n placeholder.
function buildWhere(source, cat, filters, tenantId, { includeUserFilters = true } = {}) {
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const conds = source.where(push, cat);

  if (includeUserFilters) {
    if (filters.search && filters.search.trim()) {
      conds.push(`${source.searchText} ILIKE ${push('%' + filters.search.trim() + '%')}`);
    }
    if (filters.locations && filters.locations.length) {
      conds.push(`UPPER(TRIM(${source.location})) = ANY(${push(filters.locations.map(l => String(l).toUpperCase().trim()))})`);
    }
    if (filters.contact === 'has_email') conds.push(USABLE_EMAIL);
    else if (filters.contact === 'verified') conds.push("email_check_status = 'verified'");
    else if (filters.contact === 'mailable') conds.push(`NOT (${USABLE_EMAIL}) AND ${hasAddressSql(source)}`);
    else if (filters.contact === 'unchecked') conds.push('contact_checked_at IS NULL');
    else if (filters.contact === 'no_email') conds.push(`contact_checked_at IS NOT NULL AND NOT (${USABLE_EMAIL})`);
    if (filters.minRating) conds.push(`google_rating >= ${push(Number(filters.minRating))}`);
    if (filters.hideEmailed) conds.push(`NOT (${emailedPredicate(source, push, tenantId)})`);
  }
  return { where: conds.join(' AND '), params, push };
}

// "This tenant already sent a real email to this vendor" — by name (the
// same key the badge has always used) OR by the address itself, so a
// business is never emailed twice even if it appears under two names.
function emailedPredicate(source, push, tenantId) {
  const t = push(tenantId);
  return `(LOWER(${source.name}) IN (SELECT LOWER(vendor_name) FROM vendor_outreach WHERE tenant_id = ${t} AND status = 'sent')
    OR (contact_email IS NOT NULL AND LOWER(contact_email) IN (SELECT LOWER(to_email) FROM vendor_outreach WHERE tenant_id = ${t} AND status = 'sent')))`;
}

const greetSql = (source, cat) => (cat.greet !== undefined ? cat.greet : source.greet) || 'NULL';

function orderBy(source, sort) {
  const tenure = source.since ? `${sinceSql(source)} ASC NULLS LAST, ` : '';
  const byName = `${source.name} ASC`;
  switch (sort) {
    case 'name': return byName;
    case 'rating': return `google_rating DESC NULLS LAST, google_review_count DESC NULLS LAST, ${byName}`;
    case 'ready': return `(${USABLE_EMAIL}) DESC, (email_check_status = 'verified') DESC NULLS LAST, google_rating DESC NULLS LAST, ${tenure}${byName}`;
    default: return `${tenure}${byName}`; // 'tenure' — falls back to A-Z where a source has no start date
  }
}

const EMAIL_NOTE = {
  invalid: (why) => `✗ Email not used — ${why || "it can't receive mail"}`,
  mismatch: (why) => `⚠ ${why}`,
  wrong_business: (why) => `⚠ ${why}`,
  unreachable: (why) => `⚠ Email not verified — ${why || "couldn't open their website"}`,
  unknown: (why) => `⚠ Email not verified — ${why || 'deliverability could not be checked'}`
};
function emailNote(r) {
  if (!r.contact_email) return null;
  if (r.email_check_status === 'verified') return null;
  if (!r.email_check_status) return '⚠ Email not verified yet';
  return (EMAIL_NOTE[r.email_check_status] || EMAIL_NOTE.unknown)(r.email_check_reason);
}

function mapRow(r) {
  const unusable = r.email_check_status === 'invalid';
  return {
    id: Number(r.id), // bigserial comes back from pg as a string; the panel keys selections by number
    name: r.name,
    location: r.location,
    phone: formatPhone(r.phone),
    sinceYear: r.since_date ? new Date(r.since_date).getUTCFullYear() : null,
    expires: r.expires_date ? String(r.expires_date instanceof Date ? r.expires_date.toISOString() : r.expires_date).slice(0, 10) : null,
    extra: r.extra || null,
    insured: r.insured === null || r.insured === undefined ? null : !!r.insured,
    website: r.website,
    contactEmail: unusable ? null : r.contact_email,
    emailStatus: r.email_check_status || null,
    emailNote: emailNote(r),
    greeting: friendlyGreeting(r.name, r.greet_first),
    address: r.places_formatted_address,
    matchedName: r.places_matched_name,
    rating: r.google_rating !== null && r.google_rating !== undefined ? Number(r.google_rating) : null,
    reviewCount: r.google_review_count,
    checked: !!r.contact_checked_at,
    emailed: !!r.emailed,
    suppressed: !!r.suppressed,
    suppressedReason: r.suppressed || null,
    mailable: !!r.mailable,
    letteredAt: r.lettered_at || null
  };
}

async function listDirectory({ source: sourceKey, category, filters = {}, sort, limit = 40, offset = 0, tenantId }) {
  const { source, cat } = resolve(sourceKey, category);
  const sortKey = SORTS.includes(sort) ? sort : (source.since ? 'tenure' : 'name');
  const { where, params, push } = buildWhere(source, cat, filters, tenantId);
  const emailed = emailedPredicate(source, push, tenantId);
  // The reason (unsubscribed / bounced / complained) when this address is
  // suppressed for the tenant, else NULL.
  const suppressed = `(SELECT s.reason FROM outreach_suppressions s WHERE s.tenant_id = ${push(tenantId)} AND LOWER(s.email) = LOWER(contact_email) LIMIT 1)`;
  const limitP = push(limit);
  const offsetP = push(offset);
  const r = await query(
    `SELECT id, ${source.name} AS name, ${source.location} AS location, ${source.phone} AS phone,
            ${sinceSql(source) || 'NULL'} AS since_date, ${source.expires || 'NULL'} AS expires_date,
            ${source.extra || 'NULL'} AS extra, ${source.insured || 'NULL'} AS insured,
            website, contact_email, email_check_status, email_check_reason, places_formatted_address,
            places_matched_name, google_rating, google_review_count, contact_checked_at,
            ${greetSql(source, cat)} AS greet_first,
            ${hasAddressSql(source)} AS mailable,
            (SELECT MAX(m.created_at) FROM vendor_mailings m WHERE m.tenant_id = ${push(tenantId)} AND m.source = ${push(sourceKey)} AND m.source_id = ${source.table}.id) AS lettered_at,
            ${emailed} AS emailed, ${suppressed} AS suppressed,
            COUNT(*) OVER() AS total_count
     FROM ${source.table}
     WHERE ${where}
     ORDER BY ${orderBy(source, sortKey)}
     LIMIT ${limitP} OFFSET ${offsetP}`,
    params
  );
  return {
    total: r.rows[0] ? Number(r.rows[0].total_count) : 0,
    sort: sortKey,
    rows: r.rows.map(mapRow)
  };
}

// Location (city or county) options with counts for the filter dropdown —
// counted across the whole category, ignoring other active filters, the
// same way the Permits area filter shows every area regardless of state.
async function getFacets({ source: sourceKey, category }) {
  const { source, cat } = resolve(sourceKey, category);
  const { where, params } = buildWhere(source, cat, {}, null, { includeUserFilters: false });
  const r = await query(
    `SELECT UPPER(TRIM(${source.location})) AS loc, COUNT(*)::int AS n
     FROM ${source.table}
     WHERE ${where} AND ${source.location} IS NOT NULL AND TRIM(${source.location}) <> ''
     GROUP BY 1 ORDER BY n DESC, loc ASC LIMIT 120`,
    params
  );
  return { label: source.locationLabel, locations: r.rows.map(x => ({ value: x.loc, count: x.n })) };
}

async function getRowForLookup(sourceKey, id) {
  const source = SOURCES[sourceKey];
  if (!source) throw new Error('Unknown source.');
  const r = await query(
    `SELECT id, ${source.name} AS name, ${source.lookup.city} AS city, ${source.lookup.zip} AS zip,
            ${source.lookup.area} AS area, ${source.lookup.alt} AS alt_name, ${source.phone} AS phone,
            website, contact_email, email_check_status, email_check_reason, places_formatted_address,
            places_matched_name, google_rating, google_review_count, contact_checked_at
     FROM ${source.table} WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContact(sourceKey, id, { website, phone, contactEmail, address, matchedName, rating, reviewCount, emailStatus, emailReason }) {
  const source = SOURCES[sourceKey];
  const values = [website || null, contactEmail || null, address || null, matchedName || null, rating ?? null, reviewCount ?? null,
    contactEmail ? (emailStatus || null) : null, contactEmail ? (emailReason || null) : null];
  let phoneSet = '';
  if (source.savePhone) { values.push(phone || null); phoneSet = `, phone = $${values.length}`; }
  values.push(id);
  await query(
    `UPDATE ${source.table}
     SET website = $1, contact_email = $2, places_formatted_address = $3, places_matched_name = $4,
         google_rating = $5, google_review_count = $6, email_check_status = $7, email_check_reason = $8,
         email_checked_at = ${contactEmail ? 'now()' : 'NULL'}${phoneSet}, contact_checked_at = now()
     WHERE id = $${values.length}`,
    values
  );
}

module.exports = { SOURCES, USABLE_EMAIL, greetSql, emailNote, SORTS, METRO_CITIES, getCatalog, listDirectory, getFacets, getRowForLookup, saveContact, formatPhone };
