/* Eagle I CRM, step 4: automated communications.

   1. Playbooks get a trigger: "stage" (as before: when a deal enters a stage),
      "meeting" (a set number of days before a site visit) or
      "estimate_expiry" (a set number of days before a sent estimate expires).
   2. Deals get a site-visit date and time.
   3. Each company gets a private intake key: it powers the website inquiry
      form (/crm/f/<key>) and the lead-forwarding email address
      (lead-<key>@<inbound domain>) for Houzz, Angi, Thumbtack and the like. */
exports.up = (pgm) => {
  pgm.addColumns('crm_playbooks', {
    trigger: { type: 'varchar(20)', notNull: true, default: 'stage' }
  }, { ifNotExists: true });
  pgm.alterColumn('crm_playbooks', 'stage', { allowNull: true });

  pgm.addColumns('crm_playbook_sends', {
    estimate_id: { type: 'uuid', references: 'crm_estimates', onDelete: 'cascade' }
  }, { ifNotExists: true });

  pgm.addColumns('crm_deals', {
    site_visit_at: { type: 'timestamptz' },
    site_visit_note: { type: 'text' }
  }, { ifNotExists: true });

  pgm.addColumns('tenants', {
    crm_intake_key: { type: 'varchar(24)', unique: true }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('tenants', ['crm_intake_key'], { ifExists: true });
  pgm.dropColumns('crm_deals', ['site_visit_at', 'site_visit_note'], { ifExists: true });
  pgm.dropColumns('crm_playbook_sends', ['estimate_id'], { ifExists: true });
  pgm.sql(`DELETE FROM crm_playbooks WHERE stage IS NULL`);
  pgm.alterColumn('crm_playbooks', 'stage', { allowNull: false });
  pgm.dropColumns('crm_playbooks', ['trigger'], { ifExists: true });
};
