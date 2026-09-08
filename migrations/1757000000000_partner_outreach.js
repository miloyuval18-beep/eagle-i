/* Generic "AI-drafted message to one named human, sent on explicit click"
   log — the same shape as vendor_outreach (migration 1755860000000), but
   for outreach that isn't a Places-sourced vendor: referral-partner /
   complementary-business / past-customer / influencer messages from the
   Outreach Generator (Growth & Partners), and the real-signal-triggered
   drafts from Market Intel's Real Signals card (weather alert / permit
   spike). One shared table rather than a third near-duplicate, since both
   are the same action: a human reviews AI-drafted text, picks a recipient,
   clicks Send, and a reply should be capturable the same way vendor/review
   replies already are. */

exports.up = (pgm) => {
  pgm.createTable('partner_outreach', {
    id: { type: 'uuid', primaryKey: true }, // generated in the route, not gen_random_uuid() — needed in the Reply-To address BEFORE the row exists, same reason as vendor_outreach
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    sent_by: {
      type: 'uuid',
      references: 'users',
      onDelete: 'set null'
    },
    recipient_name: { type: 'text', notNull: true },
    to_email: { type: 'text', notNull: true },
    channel: { type: 'text', notNull: true, default: 'email' }, // email | event | signal_weather | signal_permit — where the draft came from, shown in history
    subject: { type: 'text' },
    message: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'sent' }, // sent | failed
    error: { type: 'text' },
    resend_email_id: { type: 'text' },
    reply_text: { type: 'text' },
    reply_html: { type: 'text' },
    replied_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('partner_outreach', ['tenant_id', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('partner_outreach');
};
