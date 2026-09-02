// Deterministic (no AI call) personalized direct-mail letter text for one
// specific building permit — used by the Permits tab's "select permits ->
// generate mailer PDF" flow (see routes/permits.js's
// POST /api/permits/mailer-letters). Deliberately not AI-generated: a batch
// can be up to 200 letters, which would blow through /api/claude's per-IP
// rate limit (see RATE_LIMIT_MAX in server.js) and cost real money for
// something a template can do well. Each letter is built from the permit's
// own real fields — including, whenever possible, a cleaned-up version of
// the city's own free-text description of the actual work (see
// humanizeComments below), which is what makes each letter read as
// genuinely about THIS permit rather than a generic one — plus the
// tenant's own business profile, with several phrasing variants rotated in
// by a hash of the permit so a batch reads as individually written, not
// the same paragraph copy-pasted at every address. When a real property
// owner name is confidently resolved (routes/permits.js, via
// lib/hcadZipValues.js's findConfidentOwners — see lib/hcadOwnerNames.js
// for the "only if fully confident" rules), the letter is addressed to
// that name; otherwise it addresses "Property Owner", same as before that
// existed.

// Maps common permit "type" text (as published in the city's own reports,
// see lib/houstonPermits.js) to a plain-English description of the work and
// a matching angle a relevant local business could speak to. Matched by
// substring, case-insensitive, first match wins. This is the fallback used
// when the permit's own `comments` field doesn't clean up into something
// usable (see humanizeComments) — in practice most Houston permits are
// typed generically ("Building Pmt") with the real specifics only in
// comments, so humanizeComments is what actually personalizes most
// letters; this is the safety net for when it can't.
const WORK_TYPE_RULES = [
  { match: /roof/i, label: 'the roof work', angle: 'roofing, storm and hail damage, or gutter work' },
  { match: /pool|spa/i, label: 'the pool or spa project', angle: 'pool decking, fencing, or backyard landscaping' },
  { match: /solar/i, label: 'the solar installation', angle: 'electrical, roofing tie-in, or backup power' },
  { match: /fence/i, label: 'the fencing project', angle: 'fencing, gates, or landscaping' },
  { match: /driveway|pav(e|ing)|concrete/i, label: 'the driveway or concrete work', angle: 'concrete, drainage, or landscaping' },
  { match: /demo(lition)?/i, label: 'the demolition', angle: 'what comes next after a teardown — rebuilding, landscaping, or site cleanup' },
  { match: /new (single.?family|residential)|new construction/i, label: 'the new construction', angle: 'the finishing work a freshly built home still needs' },
  { match: /addition|addtn/i, label: 'the addition', angle: 'the finishing and detail work additions usually still need' },
  { match: /remodel|renovat/i, label: 'the remodel', angle: 'the kind of finishing and detail work remodels call for' },
  { match: /convert|cvt/i, label: 'the property conversion', angle: 'property conversions and the renovation work they call for' },
  { match: /electric/i, label: 'the electrical work', angle: 'electrical, lighting, or backup power' },
  { match: /mechanical|hvac|a\/?c\b/i, label: 'the HVAC work', angle: 'heating, cooling, or indoor air quality' },
  { match: /plumb/i, label: 'the plumbing work', angle: 'plumbing, fixtures, or water systems' },
  { match: /foundation/i, label: 'the foundation work', angle: 'foundation, drainage, or structural work' },
  { match: /deck|patio|pergola/i, label: 'the outdoor living project', angle: 'decking, patios, or outdoor living spaces' },
  { match: /garage|carport/i, label: 'the garage project', angle: 'garages, driveways, or storage space' },
  { match: /window|siding/i, label: 'the exterior work', angle: 'windows, siding, or exterior upgrades' },
  { match: /repair/i, label: 'the repair work', angle: 'repairs and restoration' }
];

function describeWorkType(permitTypeAndComments) {
  const t = String(permitTypeAndComments || '');
  for (const rule of WORK_TYPE_RULES) {
    if (rule.match.test(t)) return { label: rule.label, angle: rule.angle };
  }
  return { label: 'the recent work at your property', angle: 'a wide range of home improvement and construction projects' };
}

// Best-effort cleanup of the city's own free-text permit description (e.g.
// "PARKING GARAGE REMODEL 1-14-1-S2-A 2021 IBC") into a short, natural
// phrase usable inside a sentence (e.g. "parking garage remodel") — this is
// what actually makes a letter feel personal to THIS permit, since the
// `permitType` field is almost always a generic bucket ("Building Pmt")
// while the real specifics live here. Strips known code/citation jargon
// (building-code years, occupancy classification codes, sprinkler/fire-
// alarm shorthand, internal report-type prefixes) and expands a few common
// abbreviations. Returns null — never a partially-garbled string — when
// what's left doesn't look like a trustworthy natural-language phrase, so
// the caller falls back to describeWorkType's generic-but-still-honest
// label instead of printing something that reads as broken.
const JARGON_PATTERNS = [
  /\(\s*M\s*#\s*\d+\s*\)/gi,                              // (M#26049788), (M# 22003033), (M # 26019186)
  /\([^()]*\bOF\b[^()]*\)/gi,                             // (2 OF 2), (MST OF 8), (M OF 5) — sheet/master-permit pagination notes
  /\([^()]*\/[^()]*\d[^()]*\)/g,                          // (13/15), (M/4), (53 /86) — other slash-separated sheet references
  /'\d{2,4}\s*I[BR]C(\s*\/\s*\d{2,4}\s*IECC)?\b/gi,       // 2021 IBC, 21 IRC/21 IECC, '21IBC, '15IBC (leading ')
  /\b\d{2,4}'\s*I[BR]C(\s*\/\s*\d{2,4}\s*IECC)?\b/gi,     // 21'IBC (trailing ')
  /\b\d{2,4}\s*I[BR]C(\s*\/\s*\d{2,4}\s*IECC)?\b/gi,
  /\b(?:\d+%?\s*)?S[PR]{0,2}K[\s/-]*FA\b/gi,               // SPRK / FA, SPK/FA, SPK-FA, 100% SPK/FA
  /\bS[PR]{0,2}K\b/gi,                                     // a bare "SPK"/"SPRK" (sprinkler) with nothing following it
  /#\s*\d+/g,                                              // #26049788, # 91018189 — bare project/reference numbers
  /\b\d[\dA-Z]*([-/][\dA-Z]+){2,}\b/gi,                   // 1-14-1-S2-A, 1-1-2-A2/M-B style occupancy/construction codes
  /\bS\.?\/?F\.?\b/gi                                     // SF, S.F., S/F (square feet)
];

function humanizeComments(comments) {
  let text = String(comments || '').trim();
  if (!text) return null;

  for (const re of JARGON_PATTERNS) text = text.replace(re, ' ');
  text = text
    .replace(/^PPR\b/i, ' ')
    .replace(/\bREM\.?\b/gi, ' remodel ')
    .replace(/\bMF\b/gi, ' multi-family ')
    .replace(/\bBLDG\b/gi, ' building ')
    .replace(/\bWHSE\b/gi, ' warehouse ')
    .replace(/\bSTWK\b/gi, ' sitework ')
    .replace(/\bGAR\b/gi, ' garage ')
    .replace(/\bOCC\b/gi, ' occupancy ')
    .replace(/\bREPT\b/gi, ' report ')
    .replace(/\bREQ'?D\b/gi, ' required ')
    .replace(/\bW\//gi, ' with ')
    // ATT./RES. can end up glued to the next word with no space (e.g.
    // "RES.W/ATT."), so the period is matched explicitly rather than via
    // \bATT\.?\b (which fails to consume a period sitting right before
    // another word — a \W-to-\W position isn't a \b). The plain \bATT\b /
    // \bRES\b alternative only ever matches a clean standalone word, so
    // this does NOT also match inside "RESIDENTIAL" or "ATTIC" — a real
    // bug an earlier, looser version of this had.
    .replace(/\bATT\.|\bATT\b/gi, ' attached ')
    .replace(/\bRES\.|\bRES\b/gi, ' residential ')
    .replace(/\bADDTN\b/gi, ' addition ')
    .replace(/\bCVT\b/gi, ' convert ')
    .replace(/[&/]/g, ' and ')
    .replace(/[()]/g, ' ')             // strip stray parens themselves — their contents (if any) already ran through the rules above
    .replace(/\b\d+\b/g, ' ')          // any leftover bare numbers (square footage, etc.)
    .split(' ')
    .map(w => w.replace(/^[-'"#]+|[-'"#]+$/g, ''))  // trim stray leading/trailing punctuation off each word (e.g. "REPEAT-", "REPT#")
    .filter(w => w && w.length > 1)    // drop empties and lone leftover letters (sheet-reference artifacts like a stray "M" or "A")
    .join(' ')
    .trim();

  if (!text) return null;

  const words = text.split(' ').filter(Boolean);
  const substantiveWords = words.filter(w => /^[A-Za-z][A-Za-z'-]*$/.test(w) && w.length >= 3);
  if (substantiveWords.length < 2) return null;   // not enough real content left
  if (text.length < 6 || text.length > 90) return null;
  if (/\d/.test(text)) return null;               // still code-contaminated — don't print it

  return text.toLowerCase();
}

// Small deterministic string hash so the same permit always gets the same
// phrasing variant on re-generation (stable), while different permits in
// the same batch spread across the variant pool instead of all landing on
// variant 0 — a 32-bit rolling hash is plenty for this; nothing here is
// security-sensitive.
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

// Lowercases the first letter and drops a trailing period so a tenant's own
// free-text profile field (which usually reads as a standalone sentence,
// e.g. "We specialize in premium materials.") can be dropped mid-sentence
// into a template without an odd capital letter or a double period.
function asFragment(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.charAt(0).toLowerCase() + t.slice(1).replace(/\.$/, '');
}

const OPENERS = [
  ({ workLabel, address, permitDate }) => `I hope this note finds you well. I recently came across your permit for ${workLabel} at ${address}, filed ${permitDate || 'recently'}, and wanted to reach out directly rather than send a form letter.`,
  ({ workLabel, address, permitDate }) => `Congratulations on ${workLabel} at ${address}. I noticed the permit, filed ${permitDate || 'recently'}, in the city's public records and wanted to introduce myself.`,
  ({ workLabel, address, permitDate }) => `Your permit for ${workLabel} at ${address}, filed ${permitDate || 'recently'}, caught my attention in the city's public records, and I wanted to reach out personally.`,
  ({ workLabel, address, neighborhood }) => `As a business that works throughout ${neighborhood || 'the Houston area'}, I keep an eye on local permit activity — which is how I came across ${workLabel} at ${address}.`
];

const RELEVANCE_AND_CTA = [
  ({ companyName, angle, services, contact }) => `I'm with ${companyName}, where we focus on ${asFragment(services) || angle} for homeowners throughout the area. If it would be helpful to have a second opinion or a brief conversation about the project, I'd welcome the chance — no cost and no obligation. You can reach me directly at ${contact}.`,
  ({ companyName, angle, contact }) => `At ${companyName}, ${angle} is a core part of what we do, and projects like yours are exactly where we're able to be most useful. Please don't hesitate to reach out if any questions come up as the work moves forward — I can be reached directly at ${contact}.`,
  ({ companyName, angle, unique, contact }) => `${companyName} has built its reputation on ${angle}${unique ? ', and ' + asFragment(unique) : ''}. I'd welcome the opportunity to speak with you about the project whenever it's convenient — you can reach me directly at ${contact}.`
];

// permit: {address, permitType, permitDate, projectNo, comments}
// area:   {zip, region} — region is the general area label from
//         lib/houstonZipRegions.js (falls back to the zip itself upstream)
// tenant: {name, founder, phone, email, services, unique} — the tenant's
//         own business_profile fields, read fresh from the database
//         server-side, not trusted from the client.
// owner:  optional {firstName, lastName} — only ever passed in when
//         routes/permits.js has confidently resolved a real property
//         owner name (see lib/hcadZipValues.js's findConfidentOwners).
//         Omitted/undefined means "Property Owner", never a guess.
function buildPermitLetter({ permit, area, tenant, owner }) {
  const address = (permit && permit.address) || 'your property';
  const permitType = (permit && permit.permitType) || '';
  const comments = (permit && permit.comments) || '';
  const permitDate = (permit && permit.permitDate) || '';
  const neighborhood = (area && area.region) || '';

  const humanized = humanizeComments(comments);
  const { label: fallbackLabel, angle } = describeWorkType(`${permitType} ${comments}`);
  const workLabel = humanized ? `the ${humanized}` : fallbackLabel;

  const companyName = (tenant && tenant.name) || 'our team';
  const founder = (tenant && tenant.founder) || '';
  const phone = (tenant && tenant.phone) || '';
  const email = (tenant && tenant.email) || '';
  const services = (tenant && tenant.services) || '';
  const unique = (tenant && tenant.unique) || '';
  const contact = phone || email || 'the number below';

  const recipientName = owner ? `${owner.firstName} ${owner.lastName}` : 'Property Owner';
  const greeting = owner ? `Dear ${owner.firstName},` : 'Dear Property Owner,';

  const seed = hashString(`${(permit && permit.projectNo) || ''}|${address}|${permitDate}|${permitType}|${comments}`);
  const opener = pickVariant(OPENERS, seed)({ workLabel, address, neighborhood, permitDate });
  const relevanceAndCta = pickVariant(RELEVANCE_AND_CTA, seed + 7)({ companyName, angle, services, unique, contact });

  return {
    recipientName,
    recipientAddress: address,
    zip: (area && area.zip) || (permit && permit.zip) || '',
    workLabel,
    greeting,
    bodyParagraphs: [opener, relevanceAndCta],
    signOff: 'Sincerely,',
    signatureLines: [founder, companyName, [phone, email].filter(Boolean).join(' · ')].filter(Boolean)
  };
}

module.exports = { describeWorkType, humanizeComments, buildPermitLetter };
