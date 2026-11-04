// The kind of project (kitchen, addition, new home…), shown on every project card.
// Keys are in lib/crm.js PROJECT_TYPES; empty means nobody has said yet.
exports.up = (pgm) => { pgm.addColumns('crm_deals', { project_type: { type: 'varchar(30)' } }, { ifNotExists: true }); };
exports.down = (pgm) => { pgm.dropColumns('crm_deals', ['project_type'], { ifExists: true }); };
