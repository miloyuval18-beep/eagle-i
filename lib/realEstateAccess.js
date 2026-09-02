// Who gets to see the Permits tab. The signup industry dropdown's "Home
// Services / Contractor" and "Real Estate" options already cover most of
// this, but a real construction company can just as easily sign up under
// "Other" or "Professional Services" — so a tenant also qualifies when
// their own company name reads as construction-related, regardless of
// which industry they picked. Keep CONSTRUCTION_KEYWORDS's word list in
// sync with the copy in index.html's saveProfile() (client-side JS can't
// require() this file) if it ever changes.
const REAL_ESTATE_INDUSTRIES = new Set(['home_services', 'real_estate']);

const CONSTRUCTION_KEYWORDS = /\b(construction|contractor|contracting|builders?|remodel(?:ing|ers?)?|renovat(?:ion|ors?)|roofing|roofers?|masonry|concrete|excavat(?:ion|ors?)|demolition|framing|drywall|paving|home\s*builders?|custom\s*homes?|general\s*contract(?:or|ing))\b/i;

function qualifiesForPermits({ industry, companyName } = {}) {
  if (REAL_ESTATE_INDUSTRIES.has(industry)) return true;
  return CONSTRUCTION_KEYWORDS.test(String(companyName || ''));
}

module.exports = { REAL_ESTATE_INDUSTRIES, CONSTRUCTION_KEYWORDS, qualifiesForPermits };
