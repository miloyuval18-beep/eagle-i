// Reddit lead-listening — searches public Reddit posts (via Reddit's
// official read-only OAuth API, app-only client_credentials grant) for
// tenant-chosen keywords in tenant-chosen subreddits, and surfaces matches
// as leads. Never auto-posts or auto-replies on Reddit — a human always
// does the actual outreach, logged into their own account. See
// lib/redditPollWorker.js for the poll cadence and lib/redditSignals.js
// for the API calls.
exports.up = (pgm) => {
  pgm.addColumns('tenants', {
    monthly_reddit_search_cap: { type: 'integer', notNull: true, default: 7 } // one search cycle/day
  });
  pgm.addColumns('usage_counters', {
    reddit_search_count: { type: 'integer', notNull: true, default: 0 }
  });
  pgm.addColumns('business_profile', {
    // Comma-separated, tenant-edited — never guessed/auto-filled, since a
    // wrong guess is how false "leads" happen.
    reddit_search_keywords: { type: 'text' },
    reddit_subreddits: { type: 'text' },
    next_reddit_check_at: { type: 'timestamptz' } // null = eligible immediately
  });

  pgm.createTable('reddit_leads', {
    id: 'id',
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    reddit_post_id: { type: 'text', notNull: true },
    subreddit: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    snippet: { type: 'text' },
    permalink: { type: 'text', notNull: true },
    author: { type: 'text' },
    matched_keyword: { type: 'text', notNull: true },
    posted_at: { type: 'timestamptz' },
    status: { type: 'text', notNull: true, default: 'new' }, // new | dismissed
    found_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('reddit_leads', 'reddit_leads_tenant_post_unique', 'UNIQUE (tenant_id, reddit_post_id)');
  pgm.createIndex('reddit_leads', ['tenant_id', 'found_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('reddit_leads');
  pgm.dropColumns('business_profile', ['reddit_search_keywords', 'reddit_subreddits', 'next_reddit_check_at']);
  pgm.dropColumns('usage_counters', ['reddit_search_count']);
  pgm.dropColumns('tenants', ['monthly_reddit_search_cap']);
};
