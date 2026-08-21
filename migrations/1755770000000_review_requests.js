/* Review request automation (email only) — tenant's review-page URLs + a log of sent requests. */

exports.up = (pgm) => {
  pgm.addColumns('business_profile', {
    google_review_url: { type: 'text' },
    yelp_review_url: { type: 'text' }
  });

  pgm.createTable('review_requests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    sent_by: {
      type: 'uuid',
      references: 'users',
      onDelete: 'set null'
    },
    customer_name: { type: 'text', notNull: true },
    customer_email: { type: 'text', notNull: true },
    included_platforms: { type: 'jsonb', notNull: true, default: '[]' }, // e.g. ["google","yelp"]
    status: { type: 'text', notNull: true, default: 'sent' }, // sent | failed
    error: { type: 'text' },
    resend_email_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('review_requests');
  pgm.dropColumns('business_profile', ['google_review_url', 'yelp_review_url']);
};
