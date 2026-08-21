/* Real (cached, usage-capped) nearby-competitor data via Google Places API. */

exports.up = (pgm) => {
  pgm.addColumns('tenants', {
    monthly_places_lookup_cap: { type: 'integer', notNull: true, default: 10 }
  });
  pgm.addColumns('usage_counters', {
    places_lookup_count: { type: 'integer', notNull: true, default: 0 }
  });
  pgm.addColumns('business_profile', {
    places_competitors: { type: 'jsonb', notNull: true, default: '[]' },
    places_competitors_fetched_at: { type: 'timestamptz' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('business_profile', ['places_competitors', 'places_competitors_fetched_at']);
  pgm.dropColumns('usage_counters', ['places_lookup_count']);
  pgm.dropColumns('tenants', ['monthly_places_lookup_cap']);
};
