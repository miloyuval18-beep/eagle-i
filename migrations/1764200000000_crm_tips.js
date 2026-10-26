/* Eagle I CRM: the step-by-step tips that pop up the first time someone opens
   each screen. What they've seen (and whether they turned tips off) is kept
   with their login, so it follows them from phone to computer. */
exports.up = (pgm) => {
  pgm.addColumns('users', { tips: { type: 'jsonb', notNull: true, default: '{}' } }, { ifNotExists: true });
  pgm.addColumns('crm_accounts', { tips: { type: 'jsonb', notNull: true, default: '{}' } }, { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropColumns('users', ['tips'], { ifExists: true });
  pgm.dropColumns('crm_accounts', ['tips'], { ifExists: true });
};
