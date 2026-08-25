/* Real (cached, usage-capped) vendor/referral-partner business lookups by
   category, via Google Places — same infra as places_competitors, but
   keyed by category since a tenant looks up several categories over time. */

exports.up = (pgm) => {
  pgm.addColumns('business_profile', {
    places_vendors: { type: 'jsonb', notNull: true, default: '{}' } // { [category]: { results: [...], fetchedAt } }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('business_profile', ['places_vendors']);
};
