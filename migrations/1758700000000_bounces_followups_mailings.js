/* Storage for three outreach features:

   1. Delivery events. Resend reports when an email hard-bounces or is
      marked as spam. vendor_outreach records what happened
      (delivery_status/detail/at), and outreach_suppressions gains a reason
      so an address that bounced or complained is never emailed again, and is
      labelled as such rather than as an unsubscribe.

   2. outreach_followups: at most one scheduled follow-up per initial email.
      The exact message was approved when the batch was confirmed; the worker
      only sends it if the person still hasn't replied, opted out, bounced or
      complained. Cancelled rows keep their reason for the panel.

   3. vendor_mailings: which businesses a letter has been prepared for, so the
      same business isn't lettered twice by accident. Letters are postal mail
      the user prints and sends themselves. */
exports.up = (pgm) => {
  pgm.addColumns('outreach_suppressions', {
    reason: { type: 'varchar(20)', notNull: true, default: 'unsubscribed' } // unsubscribed | bounced | complained
  }, { ifNotExists: true });

  pgm.addColumns('vendor_outreach', {
    delivery_status: { type: 'varchar(20)' }, // bounced | complained | soft_bounce
    delivery_detail: { type: 'text' },
    delivery_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.createIndex('vendor_outreach', 'resend_email_id', { name: 'vendor_outreach_resend_email_id_index', ifNotExists: true });

  pgm.createTable('outreach_followups', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    outreach_id: { type: 'uuid', notNull: true, references: 'vendor_outreach', onDelete: 'cascade', unique: true },
    to_email: { type: 'text', notNull: true },
    vendor_name: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    due_at: { type: 'timestamptz', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: 'pending' }, // pending | sending | sent | failed | cancelled
    cancel_reason: { type: 'varchar(20)' },
    sent_outreach_id: { type: 'uuid' },
    error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('outreach_followups', ['status', 'due_at']);
  pgm.createIndex('outreach_followups', ['tenant_id', pgm.func('lower(to_email)')], { name: 'outreach_followups_tenant_email_index' });

  pgm.createTable('vendor_mailings', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    source: { type: 'varchar(20)', notNull: true },
    source_id: { type: 'bigint', notNull: true },
    vendor_name: { type: 'text', notNull: true },
    address: { type: 'text', notNull: true },
    batch_id: { type: 'uuid', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('vendor_mailings', ['tenant_id', 'source', 'source_id']);
};
