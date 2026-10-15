/* Eagle I CRM, step 15: what marketing actually brings in.

   1. Where each lead really came from: the ad click and campaign tags on the
      page the homeowner filled the form in on.
   2. What the company spent on each channel each month, so every channel
      shows cost per lead, cost per signed job and the signed work it
      brought. */
exports.up = (pgm) => {
  pgm.addColumns('crm_deals', { utm: { type: 'jsonb' } }, { ifNotExists: true });
  pgm.createTable('crm_marketing_spend', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    source: { type: 'varchar(24)', notNull: true },
    month: { type: 'date', notNull: true }, // the 1st of the month
    amount: { type: 'numeric(12,2)', notNull: true },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.addConstraint('crm_marketing_spend', 'crm_marketing_spend_once', { unique: ['tenant_id', 'source', 'month'] });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_marketing_spend', { ifExists: true });
  pgm.dropColumns('crm_deals', ['utm'], { ifExists: true });
};
