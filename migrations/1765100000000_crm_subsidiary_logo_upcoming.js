/* Eagle I CRM, companies in a group: a logo for each, and "upcoming" for ones not
   open yet (the portfolio lists them under Upcoming, below Our companies).
   At Levi Construction Group: Levi Homes gets its lion logo and "Project
   management", every other company is upcoming, and Levi SH Properties is
   renamed Levish Properties. */
const LCG = '984a620f-b11b-4158-b466-4976be3fffc4';
exports.up = (pgm) => {
  pgm.addColumns('crm_subsidiaries', {
    logo: { type: 'text' },
    upcoming: { type: 'boolean', notNull: true, default: false }
  }, { ifNotExists: true });
  pgm.sql(`
UPDATE crm_subsidiaries SET logo = '/brand/levi-homes.png',
  services = CASE WHEN 'Project management' = ANY(services) THEN services ELSE services || ARRAY['Project management'] END
  WHERE tenant_id = '${LCG}' AND slug = 'levi-homes';
UPDATE crm_subsidiaries SET upcoming = true WHERE tenant_id = '${LCG}' AND slug <> 'levi-homes';
UPDATE crm_subsidiaries SET name = 'Levish Properties', slug = 'levish-properties'
  WHERE tenant_id = '${LCG}' AND slug = 'levi-sh-properties'
    AND NOT EXISTS (SELECT 1 FROM crm_subsidiaries WHERE tenant_id = '${LCG}' AND slug = 'levish-properties');`);
};
exports.down = (pgm) => {
  pgm.dropColumns('crm_subsidiaries', ['logo', 'upcoming'], { ifExists: true });
};
