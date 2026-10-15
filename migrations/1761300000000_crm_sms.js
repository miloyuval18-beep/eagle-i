/* Eagle I CRM, step 10: texting and calls (Twilio).

   1. Each company's own phone number (bought through Eagle I's Twilio
      account), which forwards calls to the company's real phone.
   2. Whether each contact agreed to automatic texts, and whether they texted
      STOP.
   3. Every text sent or received, and every call to the number (answered or
      missed), on the contact's deal. */
exports.up = (pgm) => {
  pgm.addColumns('tenants', {
    sms_number: { type: 'varchar(20)', unique: true }, // E.164, e.g. +17135550100
    sms_number_sid: { type: 'text' }
  }, { ifNotExists: true });

  pgm.addColumns('crm_contacts', {
    sms_consent: { type: 'boolean', notNull: true, default: false },
    sms_opt_out: { type: 'boolean', notNull: true, default: false }
  }, { ifNotExists: true });

  pgm.createTable('crm_messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    contact_id: { type: 'uuid', references: 'crm_contacts', onDelete: 'cascade' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'set null' },
    direction: { type: 'varchar(3)', notNull: true }, // in | out
    body: { type: 'text', notNull: true },
    from_number: { type: 'varchar(20)' },
    to_number: { type: 'varchar(20)' },
    twilio_sid: { type: 'text' },
    status: { type: 'varchar(16)' },
    automated: { type: 'boolean', notNull: true, default: false },
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_messages', ['tenant_id', 'contact_id', 'created_at']);
  pgm.createIndex('crm_messages', 'twilio_sid', { name: 'crm_messages_sid_unique', unique: true, where: 'twilio_sid IS NOT NULL' });

  pgm.createTable('crm_calls', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    contact_id: { type: 'uuid', references: 'crm_contacts', onDelete: 'set null' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'set null' },
    from_number: { type: 'varchar(20)' },
    call_sid: { type: 'text', unique: true },
    status: { type: 'varchar(12)', notNull: true, default: 'ringing' }, // ringing | answered | missed
    duration_seconds: { type: 'integer' },
    texted_back: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_calls', ['tenant_id', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('crm_calls');
  pgm.dropTable('crm_messages');
  pgm.dropColumns('crm_contacts', ['sms_consent', 'sms_opt_out'], { ifExists: true });
  pgm.dropColumns('tenants', ['sms_number', 'sms_number_sid'], { ifExists: true });
};
