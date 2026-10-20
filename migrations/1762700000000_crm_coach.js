/* Eagle I CRM, step 25: the AI helping day to day.

   1. Each new lead's three-line summary, and the suggested next move on a deal.
   2. A drafted reply waiting on a customer's email.
   3. Reminders drafted for overdue invoices, waiting for one tap. */
exports.up = (pgm) => {
  pgm.addColumns('crm_deals', {
    lead_summary: { type: 'text' },
    lead_summary_at: { type: 'timestamptz' },
    next_move: { type: 'jsonb' }, // { advice, why, draft: { subject, message } | null }
    next_move_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.addColumns('crm_emails', { draft_reply: { type: 'jsonb' } }, { ifNotExists: true });
  pgm.createTable('crm_invoice_nudges', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    invoice_id: { type: 'uuid', notNull: true, references: 'crm_invoices', onDelete: 'cascade' },
    subject: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    days_overdue: { type: 'integer', notNull: true },
    status: { type: 'varchar(10)', notNull: true, default: 'draft' }, // draft | sent | skipped
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.createIndex('crm_invoice_nudges', ['invoice_id', 'created_at'], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_invoice_nudges', { ifExists: true });
  pgm.dropColumns('crm_emails', ['draft_reply'], { ifExists: true });
  pgm.dropColumns('crm_deals', ['lead_summary', 'lead_summary_at', 'next_move', 'next_move_at'], { ifExists: true });
};
