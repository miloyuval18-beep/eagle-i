// Setup reminders (lib/crmSetupCheck.js): the items a person said their company
// doesn't need ("We don't need this"), so they stop being reminded of those.
exports.up = (pgm) => {
  pgm.addColumns('users', { setup_skips: { type: 'text[]', notNull: true, default: '{}' } });
};
exports.down = (pgm) => {
  pgm.dropColumns('users', ['setup_skips']);
};
