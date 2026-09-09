/* Competitor rating-drop tracking — a background worker
   (lib/competitorRatingWorker.js) periodically re-checks a tenant's
   already-cached real competitors' Google ratings and actively emails
   the tenant when one drops meaningfully, rather than only showing it if
   they happen to open the Competitors tab (see lib/competitorRatingAlerts.js
   and the discussion this feature came out of — "is this feature just
   hoping that person will see it").

   Sized as a small, conservative cap: one check CYCLE per week per
   tenant (not one Places call — a cycle re-checks every cached
   competitor, up to ~10, so the real per-cycle cost is up to ~10 Places
   Details calls). Kept deliberately small since, unlike every other
   capped feature in this app, this one spends money on a schedule
   independent of whether the tenant is even looking at the product that
   day. */

exports.up = (pgm) => {
  pgm.addColumns('tenants', {
    monthly_rating_check_cap: { type: 'integer', notNull: true, default: 1 }
  });
  pgm.addColumns('usage_counters', {
    rating_check_count: { type: 'integer', notNull: true, default: 0 }
  });
  pgm.addColumns('business_profile', {
    next_rating_check_at: { type: 'timestamptz' } // null = eligible for a check immediately
  });

  pgm.createTable('competitor_rating_history', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    place_id: { type: 'text', notNull: true },
    competitor_name: { type: 'text', notNull: true },
    rating: { type: 'numeric(2,1)' },
    review_count: { type: 'integer' },
    checked_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('competitor_rating_history', ['tenant_id', 'place_id', 'checked_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('competitor_rating_history');
  pgm.dropColumns('business_profile', ['next_rating_check_at']);
  pgm.dropColumns('usage_counters', ['rating_check_count']);
  pgm.dropColumns('tenants', ['monthly_rating_check_cap']);
};
