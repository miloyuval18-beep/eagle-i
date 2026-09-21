/* The sender's LinkedIn link belongs on the company profile (edited in
   Account Settings alongside the website and phone), not in the outreach
   dialog. Outreach messages read it from here.

   Any LinkedIn link already saved in outreach_settings by the previous
   version is carried over so nothing is lost. */
exports.up = (pgm) => {
  pgm.addColumns('business_profile', { linkedin_url: { type: 'text' } }, { ifNotExists: true });
  pgm.sql(`
    UPDATE business_profile
    SET linkedin_url = outreach_settings->>'linkedin'
    WHERE linkedin_url IS NULL AND COALESCE(outreach_settings->>'linkedin', '') <> ''
  `);
  pgm.sql(`UPDATE business_profile SET outreach_settings = outreach_settings - 'linkedin' WHERE outreach_settings ? 'linkedin'`);
};
