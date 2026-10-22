/* Eagle I CRM: more roles and who reports to whom (lib/crmTeam.js).

   Besides owner, admin and member, a company can have project managers,
   superintendents, sales and office staff. Each person can report to someone
   above them; schedules are visible up and down that line. The owner can
   instead let everyone see everyone's schedule. */
exports.up = (pgm) => {
  pgm.alterColumn('users', 'role', { type: 'varchar(20)' });
  pgm.alterColumn('crm_invites', 'role', { type: 'varchar(20)' });
  pgm.addColumns('users', { reports_to: { type: 'uuid', references: 'users', onDelete: 'set null' } }, { ifNotExists: true });
  pgm.addColumns('crm_invites', { reports_to: { type: 'uuid', references: 'users', onDelete: 'set null' } }, { ifNotExists: true });
  pgm.addColumns('tenants', { team_visibility: { type: 'varchar(10)', notNull: true, default: 'chain' } }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('tenants', ['team_visibility'], { ifExists: true });
  pgm.dropColumns('crm_invites', ['reports_to'], { ifExists: true });
  pgm.dropColumns('users', ['reports_to'], { ifExists: true });
};
