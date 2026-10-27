/* Eagle I CRM: one company with several companies under it (Levi Construction
   Group → Levi Homes, …). Everyone is on the one team, with one role and one set
   of permissions; each company in the group has its own profile, and each
   project (deal or job, and so its files) belongs to one of them.

   On the live site this also folds the separate "Levi Homes" CRM company into
   Levi Construction Group: its people (Samantha as an admin), connected Gmail,
   email follow-ups, tasks, calendar, invitations, settings and automatic-email
   setup move over, and Levi Homes becomes the first company in the group. Those
   two ids exist only on the live site, so elsewhere this part does nothing. */
const LCG = '984a620f-b11b-4158-b466-4976be3fffc4';
const LH = '8106d764-50a4-4c70-a238-a0cf31322f54';

exports.up = (pgm) => {
  pgm.createTable('crm_subsidiaries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true },
    what: { type: 'text' },
    services: { type: 'text[]', notNull: true, default: '{}' },
    about: { type: 'text' },
    address: { type: 'text' },
    phone: { type: 'text' },
    email: { type: 'text' },
    website: { type: 'text' },
    drive_folder_id: { type: 'text' },
    position: { type: 'integer', notNull: true, default: 0 },
    archived_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.addConstraint('crm_subsidiaries', 'crm_subsidiaries_slug', { unique: ['tenant_id', 'slug'] });
  pgm.addColumns('crm_deals', { subsidiary_id: { type: 'uuid', references: 'crm_subsidiaries', onDelete: 'SET NULL' } }, { ifNotExists: true });
  pgm.createIndex('crm_deals', ['tenant_id', 'subsidiary_id'], { ifNotExists: true });

  pgm.sql(`
DO $$
DECLARE
  lcg uuid := '${LCG}';
  lh uuid := '${LH}';
  sub uuid;
  left_over text;
  tbl text;
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = lcg) OR NOT EXISTS (SELECT 1 FROM tenants WHERE id = lh) THEN RETURN; END IF;

  -- Levi Homes' profile, from the company details entered at its setup.
  INSERT INTO crm_subsidiaries (tenant_id, name, slug, what, services, address, phone, email, website, position)
  SELECT lcg, 'Levi Homes', 'levi-homes', 'Luxury home remodeling',
         ARRAY['Kitchens', 'Bathrooms', 'Room additions', 'Whole-home renovations', 'Garage conversions', 'Attics', 'Structural repairs', 'Plans & design'],
         bp.address, bp.phone, bp.email, 'https://www.levihomes.com', 0
  FROM business_profile bp WHERE bp.tenant_id = lh
  RETURNING id INTO sub;
  IF sub IS NULL THEN
    INSERT INTO crm_subsidiaries (tenant_id, name, slug, what, website) VALUES (lcg, 'Levi Homes', 'levi-homes', 'Luxury home remodeling', 'https://www.levihomes.com') RETURNING id INTO sub;
  END IF;

  -- The automatic-email setup and CRM settings Levi Homes made (none were switched on at the group).
  DELETE FROM crm_playbooks WHERE tenant_id = lcg;
  UPDATE business_profile SET crm_settings = (SELECT crm_settings FROM business_profile WHERE tenant_id = lh)
    WHERE tenant_id = lcg AND (SELECT crm_settings FROM business_profile WHERE tenant_id = lh) IS NOT NULL;
  UPDATE tenants SET setup_done_at = COALESCE(setup_done_at, (SELECT setup_done_at FROM tenants WHERE id = lh)) WHERE id = lcg;

  -- Its projects (none yet) and everything else, onto the group.
  UPDATE crm_deals SET subsidiary_id = sub WHERE tenant_id = lh;
  UPDATE users SET tenant_id = lcg, role = CASE WHEN role = 'owner' THEN 'admin' ELSE role END, permissions = CASE WHEN role = 'owner' THEN NULL ELSE permissions END WHERE tenant_id = lh;
  UPDATE crm_mailboxes SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_google_connections SET tenant_id = lcg WHERE tenant_id = lh AND NOT EXISTS (SELECT 1 FROM crm_google_connections WHERE tenant_id = lcg);
  UPDATE crm_mail_threads SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_mail_loop SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_inbox SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_tasks SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_events SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_invites SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_audit SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_playbooks SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_deals SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_contacts SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_properties SET tenant_id = lcg WHERE tenant_id = lh;
  UPDATE crm_activities SET tenant_id = lcg WHERE tenant_id = lh;
  DELETE FROM usage_counters WHERE tenant_id = lh;

  -- Nothing may be left behind: stop (and change nothing) if anything is.
  FOR tbl IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
             WHERE c.column_name = 'tenant_id' AND c.table_schema = 'public' AND c.table_name NOT IN ('business_profile', 'tenants') LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I WHERE tenant_id = $1', tbl) INTO n USING lh;
    IF n > 0 THEN left_over := concat_ws(', ', left_over, tbl); END IF;
  END LOOP;
  IF left_over IS NOT NULL THEN RAISE EXCEPTION 'Levi Homes still has rows in: %', left_over; END IF;

  -- Signed-in Levi Homes people stay signed in, now to the group.
  UPDATE session SET sess = jsonb_set(sess::jsonb, '{tenantId}', to_jsonb(lcg::text))::json WHERE sess->>'tenantId' = lh::text;
  DELETE FROM tenants WHERE id = lh;
END $$;`);
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_deals', ['subsidiary_id'], { ifExists: true });
  pgm.dropTable('crm_subsidiaries', { ifExists: true });
};
