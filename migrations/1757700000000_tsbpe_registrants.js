/* Real Responsible Master Plumbers — the Texas plumbing license that
   actually means "licensed to offer and contract plumbing work to the
   general public" (i.e. run their own plumbing business), as opposed to
   Master/Journeyman/Tradesman/Apprentice Plumber, which are individual
   worker credentials usually held by someone employed under an RMP.
   Texas plumbers are NOT under TDLR — a separate board, TSBPE, regulates
   them — but TSBPE publishes its own free, real-time CSV licensee list
   (tsbpe.texas.gov/free-licensee-list, confirmed live) with real name,
   address, phone, county, status, and even current liability-insurance
   info, richer than either the TBAE or TDLR sources.

   plumb_company can be blank on a genuine record (a sole proprietor who
   never registered a separate company name) — those still have a real
   person's name to search/contact on, unlike a TBAE row with no
   published firm at all, so they aren't excluded the way a firmless TBAE
   row is; see lib/tsbpeRegistrants.js's getHoustonAreaRegistrants. */
exports.up = (pgm) => {
  pgm.createTable('tsbpe_registrants', {
    id: { type: 'bigserial', primaryKey: true },
    license_number: { type: 'varchar(20)', notNull: true, unique: true },
    lic_status: { type: 'varchar(30)' },
    license_date: { type: 'date' },
    expiration_date: { type: 'date' },
    last_name: { type: 'text' },
    first_name: { type: 'text' },
    middle_name: { type: 'text' },
    address_line1: { type: 'text' },
    city: { type: 'text' },
    state: { type: 'varchar(2)' },
    zip: { type: 'varchar(10)' },
    phone: { type: 'varchar(20)' },
    county: { type: 'text' },
    plumb_company: { type: 'text' },
    insurance_company: { type: 'text' },
    insurance_expiry_date: { type: 'date' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('tsbpe_registrants', ['county', 'lic_status']);

  pgm.createTable('tsbpe_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tsbpe_import_state');
  pgm.dropTable('tsbpe_registrants');
};
