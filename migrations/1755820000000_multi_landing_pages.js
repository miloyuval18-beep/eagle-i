/* Landing Pages was one-row-per-tenant (tenant_id as primary key), which
   only ever let a tenant publish a single page. Real local-SEO value comes
   from multiple ZIP/service-specific pages, so this switches to a normal
   id-keyed table with tenant_id as a plain (non-unique) foreign key, plus a
   target_label field so the owner can tell pages apart in a list. */

exports.up = (pgm) => {
  pgm.addColumns('landing_pages', {
    id: { type: 'uuid', default: pgm.func('gen_random_uuid()') },
    target_label: { type: 'text' } // e.g. "Kitchen Remodel — 77024"
  });
  // Backfill id for any existing single-page-per-tenant rows before it's
  // made the primary key.
  pgm.sql('UPDATE landing_pages SET id = gen_random_uuid() WHERE id IS NULL');
  pgm.alterColumn('landing_pages', 'id', { notNull: true });

  pgm.dropConstraint('landing_pages', 'landing_pages_pkey');
  pgm.addConstraint('landing_pages', 'landing_pages_pkey', { primaryKey: 'id' });
  pgm.createIndex('landing_pages', 'tenant_id');
};

exports.down = (pgm) => {
  pgm.dropIndex('landing_pages', 'tenant_id');
  pgm.dropConstraint('landing_pages', 'landing_pages_pkey');
  // Down-migration assumes at most one row per tenant existed before losing
  // the extra ones would be needed to restore tenant_id as primary key —
  // acceptable for a reversibility check on a fresh/test DB, not intended
  // to be run against real multi-page production data.
  pgm.addConstraint('landing_pages', 'landing_pages_pkey', { primaryKey: 'tenant_id' });
  pgm.dropColumns('landing_pages', ['id', 'target_label']);
};
