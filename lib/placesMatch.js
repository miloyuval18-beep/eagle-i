// Guards the government-record -> Google-listing bridge. Places text search
// always returns its best guess, even when that is a different business
// ("1st Crown Insurance, Spring" -> "Crown Insurance Agency, Houston"), and
// a legal suffix like "INC." can make it miss a listing it would otherwise
// find. So: search with the suffix-stripped name, and only accept a result
// whose name AND location agree with the record. Failing closed costs a
// missed lead; failing open risks emailing the wrong business.

const LEGAL_SUFFIX_RE = /[,.\s]+(l\.?\s?l\.?\s?c\.?|inc\.?|incorporated|corp\.?|corporation|co\.?|ltd\.?|l\.?\s?p\.?|p\.?\s?l\.?\s?l\.?\s?c\.?|pllc|llp)\s*$/i;

// Words that describe the trade or entity type rather than identify the
// business — a match on these alone proves nothing.
const GENERIC_TOKENS = new Set([
  'the', 'and', 'of', 'a', 'an', 'at', 'in', 'for', 'to',
  'inc', 'llc', 'corp', 'co', 'ltd', 'lp', 'llp', 'pllc', 'company', 'corporation', 'incorporated',
  'services', 'service', 'group', 'associates', 'association', 'solutions', 'enterprises', 'enterprise',
  'insurance', 'agency', 'agencies', 'general', 'financial', 'brokers', 'broker', 'adjusters', 'adjusting', 'claims',
  'construction', 'contractors', 'contractor', 'contracting', 'roofing', 'roof', 'roofs', 'painting', 'paint', 'flooring',
  'floors', 'floor', 'drywall', 'concrete', 'masonry', 'framing', 'tile', 'glass', 'siding', 'excavation', 'fence', 'fencing',
  'pools', 'pool', 'decks', 'deck', 'remodeling', 'renovations', 'renovation', 'building', 'builders', 'homes', 'home',
  'houston', 'texas', 'tx'
]);

function stripLegalSuffix(name) {
  let out = String(name || '').trim();
  // Repeat: "FOO CO., INC." carries two.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEGAL_SUFFIX_RE, '').trim();
    if (next === out) break;
    out = next;
  }
  return out.replace(/[,.\s]+$/, '');
}

function tokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function distinctiveTokens(name) {
  return tokens(name).filter(t => !GENERIC_TOKENS.has(t));
}

// True when the Google listing plausibly IS the registered business:
//  - at least 60% of the record's distinctive name tokens appear in the
//    listing's name (a record with no distinctive tokens can't be verified
//    by name, so it is rejected), and
//  - the listing's address is in the record's city or zip. Sources that
//    only give a county (no city/zip) pass `allowedCities` instead: the
//    listing must be in one of those (the Houston metro), since a bare
//    person's name like "John Smith" matches plenty of people elsewhere.
function isLikelySameBusiness({ recordName, recordCity, recordZip, matchedName, matchedAddress, allowedCities }) {
  const want = distinctiveTokens(stripLegalSuffix(recordName));
  if (!want.length || !matchedName) return false;
  const have = new Set(tokens(matchedName));
  const hits = want.filter(t => have.has(t)).length;
  if (hits / want.length < 0.6) return false;

  const addr = String(matchedAddress || '').toLowerCase();
  if (recordZip && addr.includes(String(recordZip).slice(0, 5))) return true;
  if (recordCity && addr.includes(String(recordCity).toLowerCase())) return true;
  if (!recordCity && !recordZip && Array.isArray(allowedCities)) {
    return allowedCities.some(c => addr.includes(String(c).toLowerCase()));
  }
  return false;
}

module.exports = { stripLegalSuffix, distinctiveTokens, isLikelySameBusiness };
