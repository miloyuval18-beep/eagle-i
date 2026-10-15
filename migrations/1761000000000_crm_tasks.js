/* Eagle I CRM, step 7: tasks.

   A task is one thing a person has to do, usually on a deal: who, what and
   by when. Some are created by Eagle I itself at key moments (a signed
   contract needs a kickoff and a deposit), some come from a voice note, the
   rest are added by hand. */
exports.up = (pgm) => {
  pgm.createTable('crm_tasks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'cascade' },
    title: { type: 'text', notNull: true },
    due_at: { type: 'timestamptz' },
    assignee_user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    source: { type: 'varchar(10)', notNull: true, default: 'manual' }, // manual | auto | voice
    auto_key: { type: 'text' }, // for automatic tasks: never create the same one twice
    done_at: { type: 'timestamptz' },
    done_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_tasks', ['tenant_id', 'done_at', 'due_at']);
  pgm.createIndex('crm_tasks', 'deal_id');
  pgm.createIndex('crm_tasks', ['tenant_id', 'auto_key'], { name: 'crm_tasks_auto_unique', unique: true, where: 'auto_key IS NOT NULL' });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_tasks');
};
