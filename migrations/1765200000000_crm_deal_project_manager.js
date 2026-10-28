/* Eagle I CRM: each project's project manager (crm_deals.pm_user_id), next to who's
   handling it (owner_user_id). Project managers see the projects they manage or
   handle, or that someone under them does (the "See every project" permission,
   off by default for project managers; lib/crmTeam.js projectScope). */
exports.up = (pgm) => {
  pgm.addColumns('crm_deals', { pm_user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' } }, { ifNotExists: true });
  pgm.createIndex('crm_deals', ['tenant_id', 'pm_user_id'], { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropColumns('crm_deals', ['pm_user_id'], { ifExists: true });
};
