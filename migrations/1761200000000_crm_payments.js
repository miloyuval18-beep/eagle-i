/* Eagle I CRM, step 9: getting paid.

   1. Each company's own Stripe account (Stripe Connect), so payments go
      straight to the company, never through Eagle I.
   2. Invoices on a deal (deposit, progress, final): an amount, a due date and
      a private pay page (/i/<token>) where the homeowner pays by card or bank
      transfer. Checks and cash can be recorded by hand.
   3. Playbooks can remind a homeowner about an invoice before or after its
      due date (the send rows remember which invoice). */
exports.up = (pgm) => {
  pgm.addColumns('tenants', {
    stripe_connect_account_id: { type: 'text' },
    stripe_connect_ready: { type: 'boolean', notNull: true, default: false }
  }, { ifNotExists: true });

  pgm.createTable('crm_invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    estimate_id: { type: 'uuid', references: 'crm_estimates', onDelete: 'set null' },
    number: { type: 'integer', notNull: true },
    kind: { type: 'varchar(12)', notNull: true, default: 'progress' }, // deposit | progress | final | other
    title: { type: 'text', notNull: true },
    note: { type: 'text' },
    amount: { type: 'numeric(14,2)', notNull: true },
    status: { type: 'varchar(10)', notNull: true, default: 'draft' }, // draft | sent | paid | void
    due_date: { type: 'date' },
    public_token: { type: 'varchar(48)', notNull: true, unique: true },
    sent_at: { type: 'timestamptz' },
    sent_to: { type: 'text' },
    paid_at: { type: 'timestamptz' },
    paid_amount: { type: 'numeric(14,2)' },
    paid_via: { type: 'varchar(20)' }, // card | bank | check | cash | other
    stripe_session_id: { type: 'text' },
    stripe_payment_intent: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_invoices', 'crm_invoices_tenant_number_unique', { unique: ['tenant_id', 'number'] });
  pgm.createIndex('crm_invoices', 'deal_id');
  pgm.createIndex('crm_invoices', 'estimate_id', { name: 'crm_invoices_deposit_once', unique: true, where: "kind = 'deposit' AND estimate_id IS NOT NULL" });

  pgm.addColumns('crm_playbook_sends', {
    invoice_id: { type: 'uuid', references: 'crm_invoices', onDelete: 'cascade' }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_playbook_sends', ['invoice_id'], { ifExists: true });
  pgm.dropTable('crm_invoices');
  pgm.dropColumns('tenants', ['stripe_connect_account_id', 'stripe_connect_ready'], { ifExists: true });
};
