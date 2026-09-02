// Deterministic (no AI call) personalized direct-mail letter text for one
// specific building permit — used by the Permits tab's "select permits ->
// generate mailer PDF" flow (see routes/permits.js's
// POST /api/permits/mailer-letters). Deliberately not AI-generated: a batch
// can be up to 200 letters, which would blow through /api/claude's per-IP
// rate limit (see RATE_LIMIT_MAX in server.js) and cost real money for
// something a template can do well. Each letter is built from the permit's
// own real fields (address, permit type, date, area) plus the tenant's own
// business profile, with several phrasing variants rotated in by a hash of
// the permit itself — so a batch of letters reads as individually written,
// not the same paragraph copy-pasted at every address.

// Maps common permit "type" text (as published in the city's own reports,
// see lib/houstonPermits.js) to a plain-English description of the work and
// a matching angle a relevant local business could speak to. Matched by
// substring, case-insensitive, first match wins.
const WORK_TYPE_RULES = [
  { match: /roof/i, label: 'roof work', angle: 'roofing, storm and hail damage, or gutter work' },
  { match: /pool|spa/i, label: 'a pool or spa project', angle: 'pool decking, fencing, or backyard landscaping' },
  { match: /solar/i, label: 'a solar installation', angle: 'electrical, roofing tie-in, or backup power' },
  { match: /fence/i, label: 'a fence project', angle: 'fencing, gates, or landscaping' },
  { match: /driveway|pav(e|ing)|concrete/i, label: 'driveway or concrete work', angle: 'concrete, drainage, or landscaping' },
  { match: /demo(lition)?/i, label: 'a demolition', angle: 'what comes next after a teardown — rebuilding, landscaping, or site cleanup' },
  { match: /new (single.?family|residential)|new construction/i, label: 'new home construction', angle: 'the finishing work a freshly built home still needs' },
  { match: /addition/i, label: 'a home addition', angle: 'the finishing and detail work additions usually still need' },
  { match: /remodel|renovat/i, label: 'a remodel', angle: 'the kind of finishing and detail work remodels call for' },
  { match: /electric/i, label: 'electrical work', angle: 'electrical, lighting, or backup power' },
  { match: /mechanical|hvac|a\/?c\b/i, label: 'HVAC/mechanical work', angle: 'heating, cooling, or indoor air quality' },
  { match: /plumb/i, label: 'plumbing work', angle: 'plumbing, fixtures, or water systems' },
  { match: /foundation/i, label: 'foundation work', angle: 'foundation, drainage, or structural work' },
  { match: /deck|patio|pergola/i, label: 'an outdoor living project', angle: 'decking, patios, or outdoor living spaces' },
  { match: /garage|carport/i, label: 'a garage project', angle: 'garages, driveways, or storage space' },
  { match: /window|siding/i, label: 'exterior/window work', angle: 'windows, siding, or exterior upgrades' }
];

function describeWorkType(permitType) {
  const t = String(permitType || '');
  for (const rule of WORK_TYPE_RULES) {
    if (rule.match.test(t)) return { label: rule.label, angle: rule.angle };
  }
  return { label: 'a recent building permit', angle: 'the kind of work your permit points to' };
}

// Small deterministic string hash so the same permit always gets the same
// phrasing variant on re-generation (stable), while different permits in
// the same batch spread across the variant pool instead of all landing on
// variant 0 — a 32-bit FNV-1a-style rolling hash is plenty for this;
// nothing here is security-sensitive.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pickVariant(list, seed) {
  return list[seed % list.length];
}

const OPENERS = [
  ({ workLabel, address }) => `I noticed a permit filed for ${workLabel} at ${address} — congratulations on getting it moving.`,
  ({ workLabel, neighborhood }) => `I came across your permit for ${workLabel}${neighborhood ? ' in ' + neighborhood : ''} in this week's city filings.`,
  ({ workLabel, permitDate }) => `Your permit for ${workLabel}${permitDate ? ', filed ' + permitDate : ''}, caught my eye in the city's public permit records.`,
  ({ workLabel, address }) => `We do a lot of work near ${address} and saw your permit for ${workLabel} come through the city's records.`
];

// Lowercases the first letter and drops a trailing period so a tenant's own
// free-text profile field (which usually reads as a standalone sentence,
// e.g. "We specialize in premium materials.") can be dropped mid-sentence
// into a template without an odd capital letter or a double period.
function asFragment(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.charAt(0).toLowerCase() + t.slice(1).replace(/\.$/, '');
}

const BODIES = [
  ({ companyName, angle, services }) => `We're ${companyName}, and we work with homeowners on ${asFragment(services) || angle} — often right around a project like yours.`,
  ({ companyName, angle }) => `At ${companyName}, ${angle} is exactly the kind of work we handle regularly for homeowners in the area.`,
  ({ companyName, angle, unique }) => `${companyName} focuses on ${angle}${unique ? ', and ' + asFragment(unique) : ''}.`
];

const CLOSERS = [
  ({ founder, contact }) => `No pressure and no sales pitch — if a second set of eyes on the project would help, I'm at ${contact} whenever it's useful.${founder ? ' — ' + founder : ''}`,
  ({ founder, contact }) => `Happy to answer any questions about the project, no obligation. You can reach me directly at ${contact}.${founder ? ' — ' + founder : ''}`,
  ({ founder, contact }) => `If it's ever useful to talk through the project, I'm easy to reach at ${contact}.${founder ? ' — ' + founder : ''}`
];

// permit: {address, permitType, permitDate, projectNo, comments}
// area:   {zip, region} — region is the general area label from
//         lib/houstonZipRegions.js (falls back to the zip itself upstream)
// tenant: {name, founder, phone, email, services, unique} — the tenant's
//         own business_profile fields, same shape as the frontend's `C`
//         object, but read from the DB server-side so this always reflects
//         the tenant's real saved profile, not whatever the browser has in
//         memory at the moment.
function buildPermitLetter({ permit, area, tenant }) {
  const address = (permit && permit.address) || 'your property';
  const permitType = (permit && permit.permitType) || '';
  const permitDate = (permit && permit.permitDate) || '';
  const neighborhood = (area && area.region) || '';
  const { label: workLabel, angle } = describeWorkType(permitType);

  const companyName = (tenant && tenant.name) || 'our team';
  const founder = (tenant && tenant.founder) || '';
  const phone = (tenant && tenant.phone) || '';
  const email = (tenant && tenant.email) || '';
  const services = (tenant && tenant.services) || '';
  const unique = (tenant && tenant.unique) || '';
  const contact = phone || email || 'the number below';

  const seed = hashString(`${(permit && permit.projectNo) || ''}|${address}|${permitDate}|${permitType}`);

  const opener = pickVariant(OPENERS, seed)({ workLabel, address, neighborhood, permitDate });
  const body = pickVariant(BODIES, seed + 7)({ companyName, angle, services, unique });
  const closer = pickVariant(CLOSERS, seed + 13)({ founder, contact });

  const bodyText = `${opener} ${body}\n\n${closer}`;

  return {
    recipientAddress: address,
    zip: (area && area.zip) || (permit && permit.zip) || '',
    workLabel,
    bodyText
  };
}

module.exports = { describeWorkType, buildPermitLetter };
