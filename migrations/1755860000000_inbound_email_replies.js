/* Inbound email replies: a persisted vendor_outreach log (needed so a
   real vendor's Send has a row id to embed in the Reply-To address before
   sending — see routes/onboarding.js), plus reply columns on both
   vendor_outreach and the existing review_requests table so a real reply
   (captured via the Resend inbound webhook, lib/vendorContactFinder.js's
   sibling lib/inboundEmail.js) can be shown on the dashboard. */

exports.up = (pgm) => {
  pgm.createTable('vendor_outreach', {
    id: { type: 'uuid', primaryKey: true }, // generated in the route, not gen_random_uuid() — needed in the Reply-To address BEFORE the row exists
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    vendor_name: { type: 'text', notNull: true },
    to_email: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'sent' }, // sent | failed
    error: { type: 'text' },
    resend_email_id: { type: 'text' },
    reply_text: { type: 'text' },
    reply_html: { type: 'text' },
    replied_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('vendor_outreach', ['tenant_id', 'created_at']);

  pgm.addColumns('review_requests', {
    reply_text: { type: 'text' },
    reply_html: { type: 'text' },
    replied_at: { type: 'timestamptz' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('review_requests', ['reply_text', 'reply_html', 'replied_at']);
  pgm.dropTable('vendor_outreach');
};
