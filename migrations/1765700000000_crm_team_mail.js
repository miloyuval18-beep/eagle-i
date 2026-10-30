// One email a day per person (lib/crmTeamMail.js): the update emails a person would have
// had one by one wait here and go out together at the end of the day, to them only.
exports.up = (pgm) => {
  pgm.createTable('crm_team_mail', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    to_email: { type: 'text', notNull: true },
    kind: { type: 'varchar(20)', notNull: true, default: 'other' }, // lead | customer | job | pricing | checkins | other
    urgent: { type: 'boolean', notNull: true, default: false },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'set null' },
    subject: { type: 'text', notNull: true },
    body: { type: 'text' },        // plain text
    section_html: { type: 'text' }, // a ready-made section (the check-in summary)
    link: { type: 'text' },
    reply_to: { type: 'text' },    // a customer's reply: "Reply to them" goes straight back
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' }
  });
  pgm.createIndex('crm_team_mail', ['sent_at', 'tenant_id', 'to_email']);
};
exports.down = (pgm) => { pgm.dropTable('crm_team_mail'); };
