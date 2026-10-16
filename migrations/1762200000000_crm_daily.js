/* Eagle I CRM, step 19: the CRM in the team's day.

   1. Each person's private calendar link (site visits, their phases and
      tasks in Google or Apple Calendar), and their morning email.
   2. Where each house is on the map, for the rain forecast on outdoor work. */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    crm_calendar_token: { type: 'varchar(48)', unique: true },
    crm_digest_off: { type: 'boolean', notNull: true, default: false },
    crm_digest_sent_on: { type: 'date' }
  }, { ifNotExists: true });
  pgm.addColumns('crm_properties', {
    lat: { type: 'numeric(9,6)' },
    lon: { type: 'numeric(9,6)' },
    geocoded_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_properties', ['lat', 'lon', 'geocoded_at'], { ifExists: true });
  pgm.dropColumns('users', ['crm_calendar_token', 'crm_digest_off', 'crm_digest_sent_on'], { ifExists: true });
};
