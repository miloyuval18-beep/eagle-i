/* Eagle I CRM: Levi Construction Group's portfolio (/crm) links into each
   company's CRM by a short name in the address (/crm/c/levi-homes). */
exports.up = (pgm) => {
  pgm.addColumns('tenants', { slug: { type: 'text' } }, { ifNotExists: true });
  pgm.createIndex('tenants', 'slug', { name: 'tenants_slug', unique: true, where: 'slug IS NOT NULL', ifNotExists: true });
  // The group's companies on the live site (no rows match anywhere else).
  pgm.sql(`UPDATE tenants SET slug = 'levi-homes' WHERE id = '8106d764-50a4-4c70-a238-a0cf31322f54' AND slug IS NULL`);
  pgm.sql(`UPDATE tenants SET slug = 'levi-construction-group' WHERE id = '984a620f-b11b-4158-b466-4976be3fffc4' AND slug IS NULL`);
};
exports.down = (pgm) => {
  pgm.dropIndex('tenants', 'slug', { name: 'tenants_slug', ifExists: true });
  pgm.dropColumns('tenants', ['slug'], { ifExists: true });
};
