// The Drive folder a project was brought in from (lib/crmDriveProjects.js): where its files
// really are. Eagle I may have made the project its own folder too (crm_deals.drive_folder_id),
// so both are read when looking for new files. Filled in for projects already brought in.
exports.up = (pgm) => {
  pgm.addColumns('crm_deals', { drive_source_folder_id: { type: 'text' } });
  pgm.sql(`UPDATE crm_deals d SET drive_source_folder_id = p->>'folderId'
    FROM app_flags f, jsonb_array_elements(COALESCE(f.value->'projects', '[]'::jsonb)) p
    WHERE f.key LIKE 'drive_projects:%' AND p->>'dealId' = d.id::text AND p->>'folderId' IS NOT NULL AND d.tenant_id::text = split_part(f.key, ':', 2)`);
};
exports.down = (pgm) => { pgm.dropColumns('crm_deals', ['drive_source_folder_id'], { ifExists: true }); };
