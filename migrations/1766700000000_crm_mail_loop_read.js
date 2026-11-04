// "Mark as read" on an email kept for your information: it leaves the lists (Home, the
// project, the 4pm email). A newer email in the same conversation brings it back.
exports.up = (pgm) => { pgm.addColumns('crm_mail_loop', { read_at: { type: 'timestamptz' } }, { ifNotExists: true }); };
exports.down = (pgm) => { pgm.dropColumns('crm_mail_loop', ['read_at'], { ifExists: true }); };
