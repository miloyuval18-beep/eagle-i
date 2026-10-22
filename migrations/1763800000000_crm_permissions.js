/* Eagle I CRM: a permissions checklist on each person (lib/crmTeam.js PERMS).
   users.permissions is null while someone has their role's defaults, or
   { key: true|false } once the owner or an admin has adjusted them.
   Changing someone's role puts them back on that role's defaults. */
exports.up = (pgm) => {
  pgm.addColumns('users', { permissions: { type: 'jsonb' } }, { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropColumns('users', ['permissions'], { ifExists: true });
};
