/* Houston-area specialty-trade businesses that no Texas state board
   licenses (roofing, painting, flooring, drywall, concrete, masonry,
   framing, tile, glass, siding, excavation, fencing/pools/decks), sourced
   from the Texas Comptroller's public "Active Sales Tax Permit Holders"
   dataset on data.texas.gov (dataset jrea-zgmq — real, official,
   daily-updated Socrata data) by NAICS industry code.

   THIS IS NOT A LICENSE. Being on this list means a business holds an
   active state sales-tax permit under one of these NAICS codes (self-
   selected when the permit was issued) — a genuine, verifiable existence
   and good-standing signal with a real street address and start date, but
   no board has checked its competence, and it only covers contractors who
   hold a sales-tax permit (many lump-sum contractors don't), so counts
   are well below the real number of Houston tradespeople. Every place this
   is shown says so; quality signals offered instead are tenure (how long
   the permit has existed) and, once looked up, Google rating and review
   count.

   Unit of record is one business per (taxpayer_number, NAICS code) — the
   source has one row per sales-tax outlet, so a business with several
   locations is collapsed to its earliest permit. `active` is maintained by
   the importer: a business whose permit disappears from the active list
   is flagged inactive (never deleted, so already-found contact data is
   kept if it comes back). No phone in the source. */
exports.up = (pgm) => {
  pgm.createTable('comptroller_trades', {
    id: { type: 'bigserial', primaryKey: true },
    taxpayer_number: { type: 'varchar(20)', notNull: true },
    naics_code: { type: 'varchar(10)', notNull: true },
    taxpayer_name: { type: 'text' },
    outlet_name: { type: 'text' },
    outlet_address: { type: 'text' },
    outlet_city: { type: 'text' },
    outlet_zip: { type: 'varchar(10)' },
    outlet_county_code: { type: 'varchar(5)' },
    permit_issue_date: { type: 'date' },
    first_sales_date: { type: 'date' },
    active: { type: 'boolean', notNull: true, default: true },
    phone: { type: 'varchar(20)' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    places_matched_name: { type: 'text' },
    google_rating: { type: 'numeric(2,1)' },
    google_review_count: { type: 'integer' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('comptroller_trades', 'comptroller_trades_taxpayer_naics_unique', {
    unique: ['taxpayer_number', 'naics_code']
  });
  pgm.createIndex('comptroller_trades', ['naics_code', 'active']);

  pgm.createTable('comptroller_trades_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('comptroller_trades_import_state');
  pgm.dropTable('comptroller_trades');
};
