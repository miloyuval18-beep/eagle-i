// SOPs (standard operating procedures) for Eagle I CRM (lib/crmSops.js): by kind of
// work (kitchen, bath, whole house, additions, new construction, structural, or every
// kind), each one a full project SOP, a trade/vendor scope, a crew checklist or anything
// else, written in the company's own SOP style and printed like its paper SOPs.
exports.up = (pgm) => {
  pgm.createTable('crm_sops', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    category: { type: 'varchar(20)', notNull: true },     // kitchen | bath | whole_house | additions | new_construction | structural | all
    kind: { type: 'varchar(20)', notNull: true, default: 'project' }, // project | trade | crew | inspection | client | other
    title: { type: 'text', notNull: true },
    audience: { type: 'text' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'set null' },
    vendor_id: { type: 'uuid', references: 'crm_vendors', onDelete: 'set null' },
    request: { type: 'text' },                             // what they asked for, to remake it
    content: { type: 'jsonb', notNull: true },
    is_reference: { type: 'boolean', notNull: true, default: false }, // the company's own SOP, the house style
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_sops', ['tenant_id', 'category', 'updated_at']);
};
exports.down = (pgm) => { pgm.dropTable('crm_sops'); };
