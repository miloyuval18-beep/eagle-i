/* Real Texas real estate brokers, sourced from TREC's own public
   "Broker and Sales Agent License Holder Information" dataset on
   data.texas.gov (a real, official, same-day-updated Socrata dataset —
   confirmed live). Scoped to Broker Company and Broker Individual license
   types only — the business-level licenses (the ones who run/own a
   brokerage), not Sales Agent, which is an employee-level credential
   working under a broker and isn't a business of its own to reach out to.

   TREC's dataset has no phone or street address at all for any license
   type (confirmed live) — same situation as TBAE's roster, so contact
   info here comes entirely from the same Places-lookup bridge
   (routes/trecRegistrants.js's find-contact) as the architect/designer
   feature, not directly from the source like TDLR/TSBPE/TBPELS. */
exports.up = (pgm) => {
  pgm.createTable('trec_registrants', {
    id: { type: 'bigserial', primaryKey: true },
    license_type: { type: 'varchar(30)', notNull: true }, // 'Broker Company' | 'Broker Individual'
    license_number: { type: 'varchar(20)', notNull: true },
    full_name: { type: 'text' },
    status: { type: 'varchar(20)' },
    original_license_date: { type: 'date' },
    expiration_date: { type: 'date' },
    county: { type: 'text' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('trec_registrants', 'trec_registrants_type_license_no_unique', {
    unique: ['license_type', 'license_number']
  });
  pgm.createIndex('trec_registrants', ['license_type', 'county']);

  pgm.createTable('trec_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    counts_by_type: { type: 'jsonb' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('trec_import_state');
  pgm.dropTable('trec_registrants');
};
