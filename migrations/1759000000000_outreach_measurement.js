/* Storage for measuring and organising outreach:

   1. vendor_outreach records what was actually sent (subject, which of two
      versions, the category and city it was aimed at, whether it was the first
      email or a follow-up) and how a reply was sorted, so results can be
      reported by category, city and version. The same columns ride along on
      outreach_queue so a scheduled email is recorded the same way when it goes.
   2. vendor_relationships: a stage, notes, a next follow-up date and an
      "already my vendor" flag for each business the user is working with.
   3. zip_centroids / city_centroids: real coordinates (US Census ZCTA
      gazetteer) so vendors can be ranked by distance to active job sites.
   4. business_profile monthly report switches. */
exports.up = (pgm) => {
  pgm.addColumns('vendor_outreach', {
    subject: { type: 'text' },
    kind: { type: 'varchar(12)', notNull: true, default: 'initial' }, // initial | followup1 | followup2
    variant: { type: 'varchar(1)' },                                  // A | B when a two-version test was run
    test_id: { type: 'uuid' },                                        // groups the A and B halves of one test
    category_key: { type: 'text' },                                   // "<source>:<category>"
    city: { type: 'text' },
    source: { type: 'varchar(20)' },
    source_id: { type: 'bigint' },
    reply_category: { type: 'varchar(20)' },                          // interested | not_now | unsubscribe | auto_reply | other
    reply_category_by: { type: 'varchar(10)' }                        // auto | user
  }, { ifNotExists: true });
  pgm.createIndex('vendor_outreach', ['tenant_id', 'kind', 'created_at'], { name: 'vendor_outreach_tenant_kind_idx', ifNotExists: true });
  pgm.createIndex('vendor_outreach', ['test_id'], { name: 'vendor_outreach_test_idx', ifNotExists: true, where: 'test_id IS NOT NULL' });

  pgm.addColumns('outreach_queue', {
    subject: { type: 'text' },
    variant: { type: 'varchar(1)' },
    test_id: { type: 'uuid' },
    category_key: { type: 'text' },
    city: { type: 'text' },
    source: { type: 'varchar(20)' },
    source_id: { type: 'bigint' }
  }, { ifNotExists: true });

  pgm.createTable('vendor_relationships', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    source: { type: 'varchar(20)', notNull: true },   // a directory source key, 'manual', or 'inbound'
    source_id: { type: 'bigint' },
    vendor_name: { type: 'text', notNull: true },
    email: { type: 'text' },
    phone: { type: 'text' },
    stage: { type: 'varchar(20)', notNull: true, default: 'new' }, // new | contacted | replied | meeting | working | passed
    notes: { type: 'text', notNull: true, default: '' },
    next_follow_up: { type: 'date' },
    is_my_vendor: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('vendor_relationships', ['tenant_id', 'source', 'source_id'], {
    name: 'vendor_relationships_unique_source', unique: true, where: 'source_id IS NOT NULL'
  });
  pgm.createIndex('vendor_relationships', ['tenant_id', 'stage']);

  pgm.createTable('zip_centroids', {
    czip: { type: 'varchar(5)', primaryKey: true },
    clat: { type: 'numeric(9,6)', notNull: true },
    clng: { type: 'numeric(9,6)', notNull: true }
  });
  pgm.createTable('city_centroids', {
    ccity: { type: 'text', primaryKey: true },
    clat: { type: 'numeric(9,6)', notNull: true },
    clng: { type: 'numeric(9,6)', notNull: true },
    zips_used: { type: 'integer', notNull: true }
  });

  pgm.addColumns('business_profile', {
    monthly_report_enabled: { type: 'boolean', notNull: true, default: true },
    last_monthly_report: { type: 'varchar(7)' } // "YYYY-MM" of the month last reported
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('business_profile', ['monthly_report_enabled', 'last_monthly_report']);
  pgm.dropTable('city_centroids');
  pgm.dropTable('zip_centroids');
  pgm.dropTable('vendor_relationships');
  pgm.dropColumns('outreach_queue', ['subject', 'variant', 'test_id', 'category_key', 'city', 'source', 'source_id']);
  pgm.dropColumns('vendor_outreach', ['subject', 'kind', 'variant', 'test_id', 'category_key', 'city', 'source', 'source_id', 'reply_category', 'reply_category_by']);
};
