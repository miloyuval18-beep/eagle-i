// Lets a tenant see their OWN real Google reviews (not just competitors')
// and get an AI-drafted reply suggestion per review — they copy/paste it
// into their actual Google Business Profile themselves; this app has no
// write access to Google Business Profile (a separate, harder-to-get OAuth
// scope from the read-only Places key already in use).
exports.up = (pgm) => {
  pgm.addColumns('business_profile', {
    own_place_id: { type: 'text' },
    own_place_name: { type: 'text' },
    own_place_address: { type: 'text' },
    own_place_confirmed_at: { type: 'timestamptz' }
  });

  pgm.createTable('own_reviews', {
    id: 'id',
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    review_ref: { type: 'text', notNull: true }, // Places' own stable "places/{id}/reviews/{id}" resource name
    author_name: { type: 'text' },
    rating: { type: 'integer' },
    text: { type: 'text' },
    published_at: { type: 'text' }, // Places gives a relative description ("2 weeks ago"), not a real timestamp
    reply_draft: { type: 'text' },
    reply_draft_generated_at: { type: 'timestamptz' },
    fetched_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('own_reviews', 'own_reviews_tenant_ref_unique', 'UNIQUE(tenant_id, review_ref)');
  pgm.createIndex('own_reviews', ['tenant_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('own_reviews');
  pgm.dropColumns('business_profile', ['own_place_id', 'own_place_name', 'own_place_address', 'own_place_confirmed_at']);
};
