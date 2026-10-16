/* Eagle I CRM, step 20: subs confirm their dates.

   Each phase with a sub on it remembers whether the sub was asked, and what
   they said, so a phase is never a surprise to the crew. */
exports.up = (pgm) => {
  pgm.addColumns('crm_job_items', {
    confirm_token: { type: 'varchar(48)', unique: true },
    confirm_status: { type: 'varchar(10)' }, // sent | confirmed | conflict
    confirm_sent_at: { type: 'timestamptz' },
    confirm_note: { type: 'text' },
    confirm_answered_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_job_items', ['confirm_token', 'confirm_status', 'confirm_sent_at', 'confirm_note', 'confirm_answered_at'], { ifExists: true });
};
