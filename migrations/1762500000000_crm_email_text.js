/* Eagle I CRM, step 22: what customer emails actually said.

   The text of each email with a customer (not attachments, not the quoted
   history underneath), so the team and the assistant can search what was
   said, not just who wrote when. */
exports.up = (pgm) => {
  pgm.addColumns('crm_emails', {
    body_text: { type: 'text' },
    gmail_id: { type: 'text' },
    body_tried_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.sql(`CREATE INDEX IF NOT EXISTS crm_emails_search_idx ON crm_emails USING gin (to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(body_text, '')))`);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS crm_emails_search_idx');
  pgm.dropColumns('crm_emails', ['body_text', 'gmail_id', 'body_tried_at'], { ifExists: true });
};
