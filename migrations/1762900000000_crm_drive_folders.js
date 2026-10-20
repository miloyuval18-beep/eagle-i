/* Eagle I CRM: project files in folders, plan versions, and Google Drive.

   1. Every file sits in a folder (plans, permits, contracts, photos,
      selections, receipts, warranties, other). Existing files are sorted
      once by what they are.
   2. Plan versions: a new revision of a sheet replaces the old one, which is
      kept as an older version.
   3. Google Drive: a file can live in the company's Drive (big files only
      there; files up to 8 MB keep a copy here too). Each deal remembers its
      Drive folder and subfolders, and the company connection remembers its
      Drive and how far changes have been read.
   4. More kinds of files (Word, Excel, CAD, video…), so `data` may be empty
      for a file kept only in Drive. */
exports.up = (pgm) => {
  pgm.alterColumn('crm_files', 'data', { notNull: false });
  pgm.alterColumn('crm_files', 'size', { type: 'bigint' });
  pgm.addColumns('crm_files', {
    folder: { type: 'varchar(16)', notNull: true, default: 'other' },
    version_group: { type: 'uuid' },
    version: { type: 'integer', notNull: true, default: 1 },
    superseded_at: { type: 'timestamptz' },
    drive_id: { type: 'text' },
    drive_link: { type: 'text' },
    drive_modified_at: { type: 'timestamptz' },
    drive_tried_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.createIndex('crm_files', 'drive_id', { name: 'crm_files_drive_id_unique', unique: true, where: 'drive_id IS NOT NULL', ifNotExists: true });
  pgm.createIndex('crm_files', ['deal_id', 'folder'], { ifNotExists: true });
  pgm.sql(`UPDATE crm_files SET folder = CASE
    WHEN caption = 'Receipt' THEN 'receipts'
    WHEN content_type LIKE 'image/%' THEN 'photos'
    WHEN filename ~* 'permit' THEN 'permits'
    WHEN filename ~* '(contract|agreement|signed)' THEN 'contracts'
    WHEN filename ~* '(warrant|manual)' THEN 'warranties'
    WHEN filename ~* '(plan|sheet|elevation|drawing|blueprint|^a[0-9]|^s[0-9]|^e[0-9]|^m[0-9]|^p[0-9])' THEN 'plans'
    ELSE 'other' END WHERE folder = 'other'`);

  pgm.addColumns('crm_deals', {
    drive_folder_id: { type: 'text' },
    drive_folders: { type: 'jsonb' }
  }, { ifNotExists: true });

  pgm.addColumns('crm_google_connections', {
    drive_on: { type: 'boolean', notNull: true, default: false },
    drive_root_id: { type: 'text' },
    drive_shared_id: { type: 'text' },
    drive_page_token: { type: 'text' },
    drive_error: { type: 'text' },
    drive_synced_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_google_connections', ['drive_on', 'drive_root_id', 'drive_shared_id', 'drive_page_token', 'drive_error', 'drive_synced_at'], { ifExists: true });
  pgm.dropColumns('crm_deals', ['drive_folder_id', 'drive_folders'], { ifExists: true });
  pgm.dropIndex('crm_files', 'drive_id', { name: 'crm_files_drive_id_unique', ifExists: true });
  pgm.dropColumns('crm_files', ['folder', 'version_group', 'version', 'superseded_at', 'drive_id', 'drive_link', 'drive_modified_at', 'drive_tried_at'], { ifExists: true });
};
