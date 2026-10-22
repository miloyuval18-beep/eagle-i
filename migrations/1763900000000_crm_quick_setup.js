/* Eagle I CRM: quicker setup.
   crm_signup_states: "Continue with Google" on the create-account page, held
   for the trip to Google and back (what they were making, and its details). */
exports.up = (pgm) => {
  pgm.createTable('crm_signup_states', {
    state: { type: 'varchar(64)', primaryKey: true },
    type: { type: 'varchar(12)', notNull: true }, // signin | company | join | homeowner | sub
    company_name: { type: 'text' },
    code: { type: 'text' },
    business_name: { type: 'text' },
    trade: { type: 'text' },
    phone: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
};
exports.down = (pgm) => { pgm.dropTable('crm_signup_states', { ifExists: true }); };
