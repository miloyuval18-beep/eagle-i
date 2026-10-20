/* Eagle I CRM, step 23: plans and billing.

   Each company's CRM plan, trial and Stripe subscription (separate from the
   marketing product's own plan columns). Companies already on the CRM start
   a fresh 14-day trial from today. */
exports.up = (pgm) => {
  pgm.addColumns('tenants', {
    crm_plan: { type: 'varchar(20)' },
    crm_billing_status: { type: 'varchar(12)', notNull: true, default: 'trialing' }, // trialing | active | past_due | canceled
    crm_trial_ends_at: { type: 'timestamptz' },
    crm_period_end: { type: 'timestamptz' },
    crm_stripe_customer_id: { type: 'text' },
    crm_stripe_subscription_id: { type: 'text' },
    crm_past_due_since: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.sql(`UPDATE tenants SET crm_trial_ends_at = now() + interval '14 days' WHERE crm_trial_ends_at IS NULL AND 'crm' = ANY(products)`);
};

exports.down = (pgm) => {
  pgm.dropColumns('tenants', ['crm_plan', 'crm_billing_status', 'crm_trial_ends_at', 'crm_period_end', 'crm_stripe_customer_id', 'crm_stripe_subscription_id', 'crm_past_due_since'], { ifExists: true });
};
