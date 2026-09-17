/* Real Texas escrow officers (the licensed title-company professionals
   who actually close real estate transactions), sourced from TDI's own
   public "Insurance agents, adjusters, and people approved to manage
   insurance-related products or claims" dataset on data.texas.gov — a
   real, official Socrata dataset covering everyone TDI licenses
   nationwide (many licensees aren't Texas-based, since insurance/title
   licenses are often held multi-state), filtered here to Texas + Houston
   metro cities and the 'Escrow Officer' license type specifically — the
   one that actually maps to "title company referral partner."

   Honest limitation, worth stating plainly rather than hiding: TDI's
   dataset has no business/agency name and no phone number at all for any
   license type (confirmed live) — thinner than every other source this
   app uses. find-contact (routes/tdiRegistrants.js) can only search
   Places by the licensee's own personal name, which is meaningfully less
   reliable than searching a real business name — expect a lower match
   rate here than on the other verified-vendor panels. Still real,
   verified license data even when a website/email can't be found. */
exports.up = (pgm) => {
  pgm.createTable('tdi_registrants', {
    id: { type: 'bigserial', primaryKey: true },
    license_type: { type: 'varchar(40)', notNull: true }, // 'Escrow Officer'
    license_number: { type: 'varchar(20)', notNull: true },
    name: { type: 'text' },
    city: { type: 'text' },
    state: { type: 'varchar(2)' },
    postal_code: { type: 'varchar(10)' },
    expiration_date: { type: 'date' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('tdi_registrants', 'tdi_registrants_type_license_no_unique', {
    unique: ['license_type', 'license_number']
  });
  pgm.createIndex('tdi_registrants', ['license_type', 'city']);

  pgm.createTable('tdi_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tdi_import_state');
  pgm.dropTable('tdi_registrants');
};
