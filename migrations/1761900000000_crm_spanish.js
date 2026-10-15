/* Eagle I CRM, step 16: Spanish for homeowners.

   The language each contact reads (null = English), and each playbook's
   Spanish wording (same steps and timing as the English). */
exports.up = (pgm) => {
  pgm.addColumns('crm_contacts', { language: { type: 'varchar(2)' } }, { ifNotExists: true });
  pgm.addColumns('crm_playbooks', { steps_es: { type: 'jsonb' } }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_playbooks', ['steps_es'], { ifExists: true });
  pgm.dropColumns('crm_contacts', ['language'], { ifExists: true });
};
