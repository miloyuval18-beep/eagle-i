/* Real architects and Registered Interior Designers, sourced from the Texas
   Board of Architectural Examiners' own public roster download
   (indreg.tbae.texas.gov/Reports/RegistrantRosters — confirmed live: real
   Excel files, real-time data, no scrape of the search box) — see
   scripts/importTbaeRoster.js.

   firm_name/city are nullable because a meaningful share of registrants
   (roughly a third, confirmed against the live file) opt out of publishing
   them under a 2023 Public Information Act change (SB 510) — those rows
   stay in the table (they're still real, active registrants) but can't be
   geographically targeted or firm-matched via Places, so callers must
   treat a null firm_name/city as "can't be looked up," not filter it out
   silently upstream.

   website/phone/contact_email/places_formatted_address are populated
   on-demand (routes/tbaeRegistrants.js's find-contact endpoint), not by
   the import — they come from a paid Places API call per firm, so they're
   fetched once per registrant and cached here indefinitely (a firm's own
   listing doesn't change often) rather than on every page load. */
exports.up = (pgm) => {
  pgm.createTable('tbae_registrants', {
    id: { type: 'bigserial', primaryKey: true },
    profession: { type: 'varchar(30)', notNull: true }, // 'architect' | 'interior_designer'
    reg_no: { type: 'varchar(20)' },
    prefix: { type: 'varchar(10)' },
    first_name: { type: 'text' },
    last_name: { type: 'text' },
    middle_name: { type: 'text' },
    firm_name: { type: 'text' },
    city: { type: 'text' },
    state: { type: 'varchar(2)' },
    lic_status: { type: 'varchar(30)' },
    init_lic_date: { type: 'date' },
    lic_exp_date: { type: 'date' },
    website: { type: 'text' },
    phone: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('tbae_registrants', ['profession', 'city', 'lic_status']);
};

exports.down = (pgm) => {
  pgm.dropTable('tbae_registrants');
};
