/* Banks and lenders with a branch in the Houston metro, from the FDIC's
   public BankFind API (banks.data.fdic.gov — official, free, no key). Every
   FDIC-insured bank and thrift branch in the nine counties, collapsed to one
   row per institution: its metro main office when it has one there,
   otherwise its first metro branch. `metro_branches` says how many it has in
   the area (a national bank can have 150).

   The FDIC gives no phone or email. Contact info comes from the same Google
   lookup as the other sources; the street address is usable for letters
   straight away. Institutions that stop appearing are flagged inactive, not
   deleted, so contact data already paid for is kept. */
exports.up = (pgm) => {
  pgm.createTable('fdic_banks', {
    id: { type: 'bigserial', primaryKey: true },
    cert: { type: 'varchar(12)', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    address: { type: 'text' },
    city: { type: 'text' },
    zip: { type: 'varchar(10)' },
    county: { type: 'text' },
    metro_branches: { type: 'integer', notNull: true, default: 1 },
    has_metro_main_office: { type: 'boolean', notNull: true, default: false },
    active: { type: 'boolean', notNull: true, default: true },
    phone: { type: 'varchar(20)' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    email_check_status: { type: 'varchar(20)' },
    email_check_reason: { type: 'text' },
    email_checked_at: { type: 'timestamptz' },
    places_formatted_address: { type: 'text' },
    places_matched_name: { type: 'text' },
    google_rating: { type: 'numeric(2,1)' },
    google_review_count: { type: 'integer' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('fdic_banks', ['active', 'city']);
  pgm.createTable('fdic_banks_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });
};
