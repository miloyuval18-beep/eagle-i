// The outreach message every vendor email is built from. One template per
// relationship type, filled in from the tenant's own profile and the vendor
// category being emailed, so the same message works for any company and any
// kind of vendor:
//
//   capacity — vendors who would take on work for the tenant (architects,
//              designers, engineers, trades, pest control)
//   referral — partners who send or share clients (brokers, title/escrow,
//              insurance agencies)
//
// A tenant can save their own wording for either type (outreach_settings in
// business_profile). Variables are {curly} tokens; {name} is deliberately
// left in place here and filled per recipient at send time.
const { stripLegalSuffix } = require('./placesMatch');

const DEFAULT_TEMPLATES = {
  capacity: `Hi {name},

We have more work than we can take on alone, and we are looking for a few exceptional {plural} to grow with us.

{blurb} Our project load is outpacing our capacity, and we want to add firms to our team who can {execute} at the level we deliver.

We are reaching out to a small, selected group on purpose, because we would rather build a real relationship with the right partners than chase volume.

I would like to buy you lunch or set up a phone call so we can introduce ourselves properly and see where this could go. Reply to this email with {ask} and I will follow up to schedule.

LinkedIn: {linkedin}
{website}`,
  referral: `Hi {name},

We are looking to build relationships with a few exceptional {plural} in the Houston area, and we would like to introduce ourselves.

{blurb} Our clients often need a {singular} they can trust, and we would rather send them to someone we know than to a stranger.

We are reaching out to a small, selected group on purpose, because we would rather build a real relationship with the right partners than chase volume.

I would like to buy you lunch or set up a phone call so we can introduce ourselves properly and see where this could go. Reply to this email with {ask} and I will follow up to schedule.

LinkedIn: {linkedin}
{website}`
};

DEFAULT_TEMPLATES.supplier = `Hi {name},

We are always looking for a few dependable {plural} to build a long-term working relationship with, and I would like to introduce ourselves.

{blurb} We buy materials and services regularly, and we would rather give that business to a partner who is responsive, fair on price and easy to work with than keep shopping around.

We are reaching out to a small, selected group on purpose, because we would rather build a real relationship with the right partners than chase volume.

I would like to buy you lunch or set up a phone call so we can introduce ourselves properly and see where this could go. Reply to this email with {ask} and I will follow up to schedule.

LinkedIn: {linkedin}
{website}`;

// The single automatic follow-up. Deliberately short, gives an easy way to
// say no, and promises not to write again — which is also what happens.
const DEFAULT_FOLLOWUPS = {
  capacity: `Hi {name},

I wanted to follow up on my earlier note in case it got buried. We are still looking for a few exceptional {plural}, and I would still like to buy you lunch or set up a quick call.

If it is not a fit, no problem at all. Just let me know and I will not follow up again.

LinkedIn: {linkedin}
{website}`,
  referral: `Hi {name},

I wanted to follow up on my earlier note in case it got buried. We would still like to get to know a few exceptional {plural} in the Houston area, and I would still like to buy you lunch or set up a quick call.

If it is not a fit, no problem at all. Just let me know and I will not follow up again.

LinkedIn: {linkedin}
{website}`
};

DEFAULT_FOLLOWUPS.supplier = `Hi {name},

I wanted to follow up on my earlier note in case it got buried. We are still looking for a few dependable {plural} to work with regularly, and I would still like to buy you lunch or set up a quick call.

If it is not a fit, no problem at all. Just let me know and I will not follow up again.

LinkedIn: {linkedin}
{website}`;

// The optional second (and last) follow-up: shorter, no pressure, an easy exit.
const DEFAULT_FOLLOWUPS2 = {
  capacity: `Hi {name},

I do not want to crowd your inbox, so this is my last note. If the timing is ever right to talk about working together, just reply and I will make it easy: lunch on me or a quick phone call.

Thank you for your time either way.

LinkedIn: {linkedin}
{website}`,
  referral: `Hi {name},

I do not want to crowd your inbox, so this is my last note. If it ever makes sense to get to know each other, just reply and I will make it easy: lunch on me or a quick phone call.

Thank you for your time either way.

LinkedIn: {linkedin}
{website}`,
  supplier: `Hi {name},

I do not want to crowd your inbox, so this is my last note. If it ever makes sense to set up an account or talk about working together, just reply and I will make it easy: lunch on me or a quick phone call.

Thank you for your time either way.

LinkedIn: {linkedin}
{website}`
};

// A short phone script per relationship type — filled in like the emails.
const DEFAULT_CALL_SCRIPTS = {
  capacity: `OPENING: "Hi, may I speak with {name}? This is {founder} with {company}."
PITCH: "{blurb} We have more work than we can take on alone, and I am looking for a few exceptional {plural} to work with. Do you have two minutes?"
IF INTERESTED: "I would like to buy you lunch or set up a call to introduce ourselves. Could you send me {ask}? What is the best email?"
IF NOT NOW: "No problem at all. May I check back in a few months?"
VOICEMAIL: "Hi, this is {founder} with {company}. I am looking for a few exceptional {plural} to work with and would like to introduce myself. My number is {phone}. Thank you."`,
  referral: `OPENING: "Hi, may I speak with {name}? This is {founder} with {company}."
PITCH: "{blurb} I am looking to get to know a few exceptional {plural} in the Houston area, since our clients often need someone they can trust. Do you have two minutes?"
IF INTERESTED: "I would like to buy you lunch or set up a call to introduce ourselves. Could you send me {ask}? What is the best email?"
IF NOT NOW: "No problem at all. May I check back in a few months?"
VOICEMAIL: "Hi, this is {founder} with {company}. I would like to introduce myself and get to know your business. My number is {phone}. Thank you."`,
  supplier: `OPENING: "Hi, may I speak with {name}? This is {founder} with {company}."
PITCH: "{blurb} We buy materials and services regularly and I am looking for a few dependable {plural} to build a long-term relationship with. Do you have two minutes?"
IF INTERESTED: "I would like to buy you lunch or set up a call. Could you send me {ask}? What is the best email?"
IF NOT NOW: "No problem at all. May I check back in a few months?"
VOICEMAIL: "Hi, this is {founder} with {company}. I am looking for a few dependable {plural} to work with regularly. My number is {phone}. Thank you."`
};

// LinkedIn connection notes are capped at 300 characters, so these are short.
const DEFAULT_LINKEDIN_NOTES = {
  capacity: 'Hi {name}, this is {founder} with {company}. We have more work than we can take on alone and are looking to add a few exceptional {plural}. I would love to connect and buy you lunch to introduce ourselves.',
  referral: 'Hi {name}, this is {founder} with {company}. I am looking to get to know a few exceptional {plural} in the Houston area, since our clients often need someone they can trust. I would love to connect.',
  supplier: 'Hi {name}, this is {founder} with {company}. We buy regularly and are looking for a few dependable {plural} to work with long term. I would love to connect and introduce ourselves.'
};

const INTENTS = Object.keys(DEFAULT_TEMPLATES);
const MAX_TEMPLATE_CHARS = 4000;

const cleanSite = (site) => String(site || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();

// Only accept something that is genuinely a web link; the value ends up
// inside an email body, so nothing else is allowed through.
function normalizeLinkedin(url) {
  const v = String(url || '').trim();
  if (!v) return '';
  const withProto = /^https?:\/\//i.test(v) ? v : 'https://' + v;
  try {
    const u = new URL(withProto);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

// Everything the template can say about this tenant + this vendor category.
function buildVariables({ tenant, profile, settings, source, category }) {
  const company = tenant.company_name;
  const area = (profile.service_area || '').trim();
  const blurb = (settings.blurb || '').trim() || `${company} serves ${area || 'the Houston area'}.`;
  return {
    company,
    founder: profile.founder_name || '',
    phone: profile.phone || '',
    website: cleanSite(profile.site),
    linkedin: normalizeLinkedin(profile.linkedin_url) || '',
    blurb,
    plural: category.plural,
    singular: category.noun,
    ask: source.ask || 'a short note about your work',
    execute: source.execute || 'execute'
  };
}

// Fills {tokens}. A line whose token resolved to nothing (no LinkedIn link,
// no website) is dropped whole, so a missing optional field never leaves a
// dangling "LinkedIn:" label. Unknown tokens, and {name}, are left as-is.
function renderTemplate(template, vars) {
  const lines = String(template).split('\n');
  const out = [];
  for (const line of lines) {
    let emptyVar = false;
    const filled = line.replace(/\{([a-z_]+)\}/g, (whole, key) => {
      if (key === 'name' || !(key in vars)) return whole;
      if (!vars[key]) emptyVar = true;
      return vars[key];
    });
    if (!emptyVar) out.push(filled);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function followUpFor(settings, intent) {
  const saved = settings.followups && settings.followups[intent];
  return typeof saved === 'string' && saved.trim() ? saved : DEFAULT_FOLLOWUPS[intent];
}

function followUp2For(settings, intent) {
  const saved = settings.followups2 && settings.followups2[intent];
  return typeof saved === 'string' && saved.trim() ? saved : DEFAULT_FOLLOWUPS2[intent];
}

// Short text for a LinkedIn connection note: fill the tokens, then cut at a
// word boundary if it still runs past LinkedIn's 300-character limit.
function fitLinkedinNote(text, limit = 300) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,.;:\s]+$/, '') + '\u2026';
}

function templateFor(settings, intent) {
  const saved = settings.templates && settings.templates[intent];
  return typeof saved === 'string' && saved.trim() ? saved : DEFAULT_TEMPLATES[intent];
}

// Turns a message the tenant edited (already filled in for one category)
// back into a reusable template, by putting the category-specific values
// back as tokens — so saving "as my default" doesn't bake "architects" into
// the wording used for roofers.
function templatize(message, vars) {
  let t = String(message);
  // Longest values first, so "real estate brokerages" is replaced before "real estate".
  const swaps = ['blurb', 'plural', 'singular', 'ask', 'execute', 'linkedin', 'website']
    .filter(k => vars[k] && String(vars[k]).length >= 3)
    .sort((a, b) => String(vars[b]).length - String(vars[a]).length);
  for (const key of swaps) t = t.split(String(vars[key])).join(`{${key}}`);
  return t;
}

const titleCaseWord = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
// Re-case one ALL-CAPS word from a government record. Short letter groups with
// no vowels are almost always initials ("MCT", "HVAC" stays via length) and
// stay as they are; "TOP" or "PRO" are words. Hyphenated names case each part.
const KNOWN_ACRONYMS = new Set(['HVAC', 'AIA', 'USA', 'DFW', 'PVC', 'LED', 'ADA', 'TX', 'ABC', 'AAA']);
function caseCapsWord(word) {
  return word.split('-').map(seg => {
    const letters = seg.replace(/[^A-Za-z]/g, '');
    if (!letters) return seg;
    if (KNOWN_ACRONYMS.has(letters)) return seg;
    if (/^\d+(ST|ND|RD|TH)$/.test(seg)) return seg.toLowerCase(); // ordinals: 1ST -> 1st
    if (/^\d/.test(seg)) return seg; // 2G, 3D stay as written
    if (letters.length <= 2 || (letters.length === 3 && !/[AEIOUY]/i.test(letters))) return seg;
    return seg.charAt(0) + seg.slice(1).toLowerCase();
  }).join('-');
}

// "PETER" -> "Peter"; "MCT SHEET METAL, INC." -> "MCT Sheet Metal team";
// "Live To Build, LLC" -> "Live To Build team". A business name is only
// re-cased when it is entirely upper-case (a government-record artifact).
function friendlyGreeting(businessName, firstName) {
  const first = String(firstName || '').trim();
  if (first.length >= 2 && /^[A-Za-z][A-Za-z'’-]*\.?$/.test(first) && !/^[A-Z]\.$/.test(first)) {
    return titleCaseWord(first.replace(/\.$/, ''));
  }
  let name = stripLegalSuffix(String(businessName || '').trim());
  if (!name) return 'there';
  if (name === name.toUpperCase()) {
    name = name.split(/\s+/).map(caseCapsWord).join(' ');
  }
  return `${name} team`;
}

// Per-recipient fill of the one token left open. Greeting is untrusted text
// destined for an email body, so control characters and length are bounded.
function fillName(message, greeting) {
  const safe = String(greeting || 'there').replace(/[\r\n -]/g, ' ').trim().slice(0, 80) || 'there';
  return String(message).split('{name}').join(safe);
}

// ---- Mailed letters -----------------------------------------------------
// The same message, adapted for paper: "reply to this email" makes no sense on
// a letter, so it becomes a reply-to-me line with the sender's real contact.
function letterize(message, profile) {
  const contact = String((profile && (profile.email || profile.phone)) || '').trim();
  return String(message).replace(/Reply to this email with/g, contact ? `Please reply to me at ${contact} with` : 'Please reply with');
}

const LINK_LINE_RE = /^(linkedin:\s*\S+|https?:\/\/\S+|[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?)$/i;
// Trailing LinkedIn/website lines read fine at the end of an email but sit
// oddly above "Sincerely," — peel them off so the letter can print them under
// the signature instead.
function splitLetterLinks(text) {
  const lines = String(text).trim().split('\n');
  const links = [];
  while (lines.length && (!lines[lines.length - 1].trim() || LINK_LINE_RE.test(lines[lines.length - 1].trim()))) {
    const l = lines.pop().trim();
    if (l) links.unshift(l);
  }
  return { body: lines.join('\n').trim(), links };
}

const NAME_SUFFIX_CASE = { INC: 'Inc', CORP: 'Corp', LTD: 'Ltd', CO: 'Co', LLC: 'LLC', LLP: 'LLP', LP: 'LP', PLLC: 'PLLC', PC: 'PC' };
// Government records shout ("MCT SHEET METAL, INC."); a letter shouldn't.
function properName(name) {
  const n = String(name || '').trim();
  if (!n || n !== n.toUpperCase()) return n;
  return n.split(/(\s+)/).map(tok => {
    if (!/[A-Za-z]/.test(tok)) return tok;
    const trail = (/[.,]+$/.exec(tok) || [''])[0];
    const bare = tok.slice(0, tok.length - trail.length);
    const suffix = NAME_SUFFIX_CASE[bare.replace(/\./g, '')];
    return suffix ? suffix + trail : caseCapsWord(bare) + trail;
  }).join('');
}

// [street, "City, ST ZIP"] from either a government street address or the
// one-line address Google returns ("6633 Hillcroft Ave Ste 101, Houston, TX 77081, USA").
// A "street" that is only a suite designator ("Ste 501") can't be delivered to.
const SUITE_ONLY_RE = /^\s*(ste|suite|apt|unit|#|bldg|building|fl|floor|rm|room)\b[\s#.:-]*[\w-]*\s*$/i;
function addressLines({ street, city, zip, placesAddress }) {
  if (street && SUITE_ONLY_RE.test(street)) street = null;
  if (street) {
    const cityLine = [city ? properName(city) : '', zip ? 'TX ' + String(zip).slice(0, 10) : (city ? 'TX' : '')].filter(Boolean).join(city && zip ? ', ' : ' ');
    return [properName(street), cityLine].filter(Boolean);
  }
  const parts = String(placesAddress || '').replace(/,?\s*USA$/i, '').split(/,\s*/).filter(Boolean);
  if (parts.length >= 3) return [parts.slice(0, -2).join(', '), parts.slice(-2).join(', ')];
  return parts.length ? [parts.join(', ')] : [];
}

module.exports = {
  letterize, splitLetterLinks, properName, addressLines,
  DEFAULT_TEMPLATES, DEFAULT_FOLLOWUPS, DEFAULT_FOLLOWUPS2, DEFAULT_CALL_SCRIPTS, DEFAULT_LINKEDIN_NOTES, INTENTS, MAX_TEMPLATE_CHARS, followUpFor, followUp2For, fitLinkedinNote,
  cleanSite, normalizeLinkedin, buildVariables, renderTemplate, templateFor, templatize, friendlyGreeting, fillName
};
