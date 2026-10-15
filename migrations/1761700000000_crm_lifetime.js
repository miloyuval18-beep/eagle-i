/* Eagle I CRM, step 14: the customer for life.

   1. Referral links: every past client and every trade partner (realtors,
      designers, architects) has a code. A lead that comes in through it is
      credited to them, and a signed job earns them the company's reward.
   2. The home file: what went into the house (finishes, appliances,
      systems, the workmanship warranty), shown in the homeowner's portal,
      with care reminders and a "your warranty ends soon" check-in. */
exports.up = (pgm) => {
  pgm.addColumns('crm_contacts', { referral_code: { type: 'varchar(16)' } }, { ifNotExists: true });
  pgm.createIndex('crm_contacts', 'referral_code', { unique: true, where: 'referral_code IS NOT NULL', ifNotExists: true });

  pgm.createTable('crm_partners', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    name: { type: 'text', notNull: true },
    company: { type: 'text' },
    kind: { type: 'varchar(16)', notNull: true, default: 'other' }, // realtor | designer | architect | builder | other
    email: { type: 'text' },
    phone: { type: 'text' },
    code: { type: 'varchar(16)', notNull: true, unique: true },
    notes: { type: 'text' },
    archived: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_partners', ['tenant_id', 'archived'], { ifNotExists: true });

  pgm.addColumns('crm_deals', {
    referred_by_contact_id: { type: 'uuid', references: 'crm_contacts', onDelete: 'set null' },
    partner_id: { type: 'uuid', references: 'crm_partners', onDelete: 'set null' }
  }, { ifNotExists: true });

  pgm.createTable('crm_referral_rewards', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, unique: true, references: 'crm_deals', onDelete: 'cascade' },
    contact_id: { type: 'uuid', references: 'crm_contacts', onDelete: 'set null' },
    partner_id: { type: 'uuid', references: 'crm_partners', onDelete: 'set null' },
    amount: { type: 'numeric(12,2)' },
    status: { type: 'varchar(8)', notNull: true, default: 'owed' }, // owed | paid
    paid_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });

  pgm.createTable('crm_home_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    category: { type: 'varchar(16)', notNull: true, default: 'finish' }, // finish | appliance | system | warranty | other
    name: { type: 'text', notNull: true },
    details: { type: 'text' }, // brand, model, color, where it is
    installed_on: { type: 'date' },
    warranty_until: { type: 'date' },
    care_every_months: { type: 'smallint' },
    care_note: { type: 'text' },
    next_care_at: { type: 'date' },
    warranty_noticed: { type: 'boolean', notNull: true, default: false },
    source: { type: 'varchar(12)', notNull: true, default: 'manual' }, // manual | selection | warranty
    source_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_home_items', ['deal_id'], { ifNotExists: true });
  pgm.createIndex('crm_home_items', ['next_care_at'], { where: 'next_care_at IS NOT NULL', ifNotExists: true });
  pgm.createIndex('crm_home_items', ['deal_id', 'source', 'source_id'], { unique: true, where: 'source_id IS NOT NULL', name: 'crm_home_items_source_uniq', ifNotExists: true });

  pgm.addColumns('crm_playbook_sends', {
    home_item_id: { type: 'uuid', references: 'crm_home_items', onDelete: 'cascade' }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_playbook_sends', ['home_item_id'], { ifExists: true });
  pgm.dropTable('crm_home_items', { ifExists: true });
  pgm.dropTable('crm_referral_rewards', { ifExists: true });
  pgm.dropColumns('crm_deals', ['referred_by_contact_id', 'partner_id'], { ifExists: true });
  pgm.dropTable('crm_partners', { ifExists: true });
  pgm.dropIndex('crm_contacts', 'referral_code', { ifExists: true });
  pgm.dropColumns('crm_contacts', ['referral_code'], { ifExists: true });
};
