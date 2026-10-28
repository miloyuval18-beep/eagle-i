/* Eagle I: talk or type for everyone with an assistant. Homeowners and subs often
   have no login, so their choice lives on their record (the customer and the sub),
   asked the first time they open their page. Logins use users.ai_mode. */
exports.up = (pgm) => {
  pgm.addColumns('crm_contacts', { ai_mode: { type: 'varchar(8)' } }, { ifNotExists: true });
  pgm.addColumns('crm_vendors', { ai_mode: { type: 'varchar(8)' } }, { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropColumns('crm_contacts', ['ai_mode'], { ifExists: true });
  pgm.dropColumns('crm_vendors', ['ai_mode'], { ifExists: true });
};
