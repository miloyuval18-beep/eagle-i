/* 1. Email verification results, on every vendor source table.

      email_check_status: verified | invalid | mismatch | wrong_business |
                          unreachable | unknown  (NULL = never checked)
      email_check_reason: short human-readable explanation shown in the panel
      email_checked_at:   when it was last checked

   Verification can honestly prove three things — the address is well-formed,
   its domain can receive mail (MX/A records), and (for the older rows whose
   Google match was never validated) that the business's own website is for
   this business and the address lives on it. It cannot prove a specific
   mailbox exists; only sending can. That's why the status is a flag the
   panel acts on, not a guarantee.

   2. business_profile.outreach_settings: per-tenant outreach message
      settings — saved templates (one per relationship type), the company
      blurb, and the sender's LinkedIn link — so the same outreach email
      works for any company, not just one. */
const TABLES = [
  'tbae_registrants', 'tdlr_registrants', 'tsbpe_registrants', 'tbpels_registrants',
  'trec_registrants', 'tdi_registrants', 'tda_registrants', 'tdi_agencies', 'comptroller_trades'
];

exports.up = (pgm) => {
  for (const t of TABLES) {
    pgm.addColumns(t, {
      email_check_status: { type: 'varchar(20)' },
      email_check_reason: { type: 'text' },
      email_checked_at: { type: 'timestamptz' }
    }, { ifNotExists: true });
  }
  pgm.addColumns('business_profile', {
    outreach_settings: { type: 'jsonb', notNull: true, default: '{}' }
  }, { ifNotExists: true });
};
