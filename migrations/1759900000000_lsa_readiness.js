// Google Local Services Ads has no API to create or launch a campaign at
// all — Google requires its own manual verification per business (license
// check, insurance, background checks) done entirely on Google's own
// site. This isn't a campaign builder like routes/ads.js; it's a
// readiness tool: track the checklist, collect the documents Google will
// ask for, and draft the profile copy, so the real application (still
// done by the tenant, on Google's site) takes minutes instead of a
// scramble.
exports.up = (pgm) => {
  pgm.addColumns('business_profile', {
    lsa_has_insurance: { type: 'boolean' },
    lsa_years_in_business: { type: 'text' },
    lsa_service_categories: { type: 'text' },
    lsa_bio: { type: 'text' },
    lsa_bio_generated_at: { type: 'timestamptz' }
  });

  pgm.createTable('lsa_documents', {
    id: 'id',
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    kind: { type: 'text', notNull: true }, // license | insurance
    filename: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true },
    size: { type: 'integer', notNull: true },
    data: { type: 'bytea', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('lsa_documents', ['tenant_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('lsa_documents');
  pgm.dropColumns('business_profile', ['lsa_has_insurance', 'lsa_years_in_business', 'lsa_service_categories', 'lsa_bio', 'lsa_bio_generated_at']);
};
