// Parsing + confidence rules for HCAD's `mailto` field (the name-on-file
// for a parcel, from the same real_acct.txt already used by
// lib/hcadZipValues.js — see that file and scripts/importHcadZipValues.js
// for where this data comes from). This field is genuinely messy free text
// covering individuals, married couples, trusts, LLCs, government bodies,
// and HCAD's own "CURRENT OWNER" placeholder when no name is on file — so
// this module's only job is deciding, conservatively, when it's SAFE to
// treat it as one real person's name. When in doubt, it returns null and
// the caller falls back to "Property Owner" — a wrong name on a mailer is
// worse than a generic one, so every rule here is written to fail closed.

const PLACEHOLDER_NAMES = new Set(['CURRENT OWNER', 'OWNER OF RECORD', 'UNKNOWN', 'UNKNOWN OWNER', '']);

// Keywords that show up in HCAD owner-of-record names for anything that
// isn't a single natural person: businesses, trusts, government bodies,
// religious/nonprofit orgs, financial institutions. Not exhaustive — see
// the token-shape check below for a second, independent line of defense.
const BUSINESS_KEYWORDS = /\b(LLC|LLLP|LLP|LP|LTD|INC|CORP|CO|COMPANY|TRUST|ESTATE|PARTNERSHIP|PTNSH|BANK|CHURCH|CONGREGATION|MINISTR(Y|IES)|ASSN|ASSOCIATION|FOUNDATION|AUTHORITY|DISTRICT|COUNTY|CITY OF|STATE OF|HOA|MGMT|MANAGEMENT|PROPERT(Y|IES)|HOLDINGS|GROUP|TRUSTEE|VENTURES?|CAPITAL|INVESTMENTS?|REALTY|DEVELOPMENTS?|ENTERPRISES?|SERVICES|BUILDERS|CONSTRUCTION|SAVINGS|LOAN|MORTGAGE|FINANCIAL|NATIONAL|FEDERAL|TITLE|ESCROW|INSURANCE|ISD|SCHOOL|HOSPITAL|UNIVERSITY|COLLEGE|MINISTRY)\b/i;

function looksLikeBusinessOrPlaceholder(mailto) {
  const name = String(mailto || '').trim().toUpperCase();
  if (!name) return true;
  if (PLACEHOLDER_NAMES.has(name)) return true;
  if (name.includes('%') || name.includes('/')) return true; // c/o, or a slash-joined entity name — never a plain individual
  return BUSINESS_KEYWORDS.test(name);
}

function toTitleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Extracts {firstName, lastName} for the first-listed owner ONLY when the
// name unambiguously reads as "LASTNAME FIRSTNAME [MIDDLE-INITIAL]" — the
// real HCAD convention for an individual (e.g. "STEPHENSON MELINDA",
// "BRANDT SCOTT M"). A joint-owner name ("MILSTEIN JEFFREY J & LAUREN K")
// is parsed from the portion before "&" only — the second owner's name is
// never reliably distinguishable from a shared-vs-different surname in
// plain text, so it's simply not used. Returns null for anything that
// isn't exactly a 2-or-3-token name (the token-count itself is a strong
// signal: real business/institution names in this data are almost never
// exactly 2-3 tokens shaped like "LAST FIRST [MI]" — see
// looksLikeBusinessOrPlaceholder for the keyword-based check that catches
// most of them directly, and this shape check as a second, independent
// filter for names that slip past the keyword list, e.g. "HOME SAVING OF
// AMERICA").
function parseOwnerPersonName(mailto) {
  const raw = String(mailto || '').trim();
  if (!raw || looksLikeBusinessOrPlaceholder(raw)) return null;

  const primary = raw.split('&')[0].trim();
  const tokens = primary.split(/\s+/).filter(Boolean);

  const shapeOk = tokens.length === 2 || (tokens.length === 3 && /^[A-Z]\.?$/i.test(tokens[2]));
  if (!shapeOk) return null;

  const [lastNameRaw, firstNameRaw] = tokens;
  const NAME_RE = /^[A-Za-z'-]{2,}$/;
  if (!NAME_RE.test(lastNameRaw) || !NAME_RE.test(firstNameRaw)) return null;

  return { firstName: toTitleCase(firstNameRaw), lastName: toTitleCase(lastNameRaw) };
}

// Minimal, conservative address normalization shared between import
// (HCAD's own site_addr_1) and lookup (a permit's address string) — exact
// string equality after this is the whole matching bar. Deliberately no
// fuzzy suffix expansion (ST/STREET, DR/DRIVE, etc.) or abbreviation
// guessing: a false match here puts a real person's name on a letter meant
// for someone else's address, which is worse than the generic fallback, so
// a miss is the safe failure mode, not a guess.
function normalizeAddress(addr) {
  return String(addr || '')
    .toUpperCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { looksLikeBusinessOrPlaceholder, parseOwnerPersonName, normalizeAddress };
