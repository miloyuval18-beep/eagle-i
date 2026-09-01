# Eagle I — AI Marketing Command Center

Levi Homes' marketing dashboard. Static frontend (`index.html`) served by a small
Express proxy (`server.js`) that keeps the Anthropic API key server-side.

## Run locally

```bash
npm install
cp .env.example .env   # then edit .env and add your real ANTHROPIC_API_KEY
npm start
```

Open http://localhost:3000

## Deploy (Render)

1. Push this repo to GitHub.
2. On [render.com](https://render.com), New → Blueprint → pick this repo (uses `render.yaml`).
   Or: New → Web Service → pick this repo, Build Command `npm install`, Start Command `npm start`.
3. In the service's Environment tab, add `ANTHROPIC_API_KEY` with your real key.
4. Deploy. Render gives you a `https://<name>.onrender.com` URL — that's your live site.
5. (Optional) Settings → Custom Domain to point your own domain at it.

## Password-protect the site

Set both `SITE_USER` and `SITE_PASSWORD` (locally in `.env`, or in Render's Environment tab)
and the whole site requires an HTTP login before anything loads — the browser shows its
built-in username/password prompt. Leave either one unset and the site stays open (this is
the default, so local dev needs no config). No new dependency, no database.

## Tests

```bash
npm test
```

Runs `test/unit.test.js` (pure logic, no DB/network) and `test/integration.test.js`
(spins up a real local server against the real `DATABASE_URL` from `.env`, exercises
auth/tenant-isolation/usage-caps/permits/error-handling over real HTTP, then deletes
every tenant it created). There's no separate test database — `ANTHROPIC_API_KEY`,
`GOOGLE_PLACES_API_KEY`, `RESEND_API_KEY`, and `STRIPE_SECRET_KEY` are deliberately
unset for the test run so the "service not configured" fallback paths are what gets
asserted; those same routes behave differently once real keys are present. See
`test/helpers.js` for details.

## HCAD real home-value data

```bash
node scripts/importHcadZipValues.js            # downloads HCAD's public export, writes hcad_zip_stats
node scripts/importHcadZipValues.js --dry-run   # same, but prints a summary instead of writing to the DB
```

Populates real, county-appraiser-sourced average/median home values per Houston-area
zip (used by the Permits and Signals pages) from Harris Central Appraisal District's
own public bulk export. This is a manual/periodic script, not something the live app
runs — HCAD's export is a single ~200MB county-wide file (no per-address or per-zip
API), refreshed by HCAD roughly annually, so re-running this a few times a year is
plenty. Run it from a machine with `DATABASE_URL` set to the real database (same as
`npm test` and `node-pg-migrate`) — it writes real rows into production. See
`lib/hcadZipValues.js` and `scripts/importHcadZipValues.js` for what it does and does
not do (it does not store parcel-level owner names or addresses — only per-zip
aggregates).

## Real ad campaigns (Meta Ads + Google Ads)

`routes/ads.js` creates real (always PAUSED) campaigns via each platform's own API —
see that file's header comment for the full picture, including why neither has been
exercised against a live account yet. Both are gated behind server config and return
a clean 503 until it's supplied:

- **Meta Ads**: `META_APP_ID`, `META_APP_SECRET` (same app as organic Facebook/Instagram
  posting), plus its own `META_ADS_REDIRECT_URI` — a *second*, separately-registered
  OAuth redirect URI in the Meta App dashboard (distinct from `META_REDIRECT_URI`),
  because reconnecting for ads requests the additional `ads_management` permission.
  A tenant also needs their own funded ad account (entered as `act_...` in Social HQ →
  Ads) — Eagle I can't create or fund one for them.
- **Google Ads**: `GOOGLE_ADS_DEVELOPER_TOKEN` (applied for separately at
  [ads.google.com/aw/apicenter](https://ads.google.com/aw/apicenter) — this approval is
  its own process, not something this app can obtain), `GOOGLE_ADS_CLIENT_ID`,
  `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REDIRECT_URI` (a Google Cloud OAuth client
  with the `adwords` scope enabled — can be the same Cloud project already used for
  Places, with a new OAuth client).

Every campaign created is left **PAUSED** — activating it (spending real money) is a
manual step the tenant takes in Meta Ads Manager / Google Ads. A daily-budget safety
ceiling ($1,000/day, see `MAX_DAILY_BUDGET_CENTS` in `routes/ads.js`) is enforced
server-side and isn't exposed as a setting.

## Google Business Profile posting

`routes/gbp.js` posts real updates to a Business Profile listing via Google's
"local posts" API — unlike Yelp/Houzz/Nextdoor (which have no public posting API at
all, see the readiness report's "Can't be fully run through AI" section), this one is
real and buildable, just gated behind Google's own manual review. A local post is
organic content, not ad spend, so — unlike `routes/ads.js` — it publishes immediately,
nothing is created "paused."

Needs `GOOGLE_GBP_CLIENT_ID`, `GOOGLE_GBP_CLIENT_SECRET`, `GOOGLE_GBP_REDIRECT_URI` (a
Google Cloud OAuth client with the `business.manage` scope — can reuse the same Cloud
project as Places/Google Ads, with its own OAuth client and redirect URI). The tenant's
Google login also needs **Business Profile API access approved by Google** — a separate
manual request at [Google's Basic API Access form](https://support.google.com/business/contact/api_default)
(their own listing must be 60+ days old and verified; Google's stated review window is
7–10 business days, reported as ranging up to several weeks) — not something this app
can obtain on a tenant's behalf.

## Scheduled posts

The Social HQ composer can queue a post for a future time instead of publishing
immediately — `routes/scheduledPosts.js` persists it (`scheduled_posts` table),
and `lib/scheduledPostsWorker.js` polls every 60s for due rows and fires them
through the exact same `publishToMeta`/`publishToGbp` functions the live
"Post Now" button uses (no separate/duplicated posting logic). Only
Facebook, Instagram, and Google are schedulable — the other composer platforms
have no real posting API at all (see above) and stay immediate-DEMO-only.

A claimed row is atomically flipped `pending` → `sending` before it's published,
so two overlapping ticks can't double-post. No auto-retry: a failed send stays
visible as `failed` with the real error from the platform's API, and the tenant
can just try again from the composer.

**Known limitation, not solved here**: `render.yaml` runs on Render's free
tier, which spins the instance down after ~15 min idle. A scheduled post due
while the instance is asleep fires late on next wake rather than being
dropped (the query is "still pending," not "due exactly now") — exact-time
firing needs a paid always-on instance, which is a hosting decision for later.

## Instagram image hosting

`routes/images.js` stores uploaded post images in Postgres (`post_images`, bytea) and
serves them publicly at `/img/:id` — no new external account, no new dependency. This
is what lets Instagram posting actually work: Instagram's Graph API requires a publicly
reachable image URL, which Eagle I previously had no way to provide. Wired into the
composer's existing drop-zone in `index.html` — dropping/selecting an image uploads it
immediately and the resulting URL is used automatically when publishing to Instagram.

## Notes

- `ANTHROPIC_API_KEY`, `SITE_USER`, `SITE_PASSWORD` must never be committed. `.env` is gitignored; only `.env.example` (no real values) is tracked.
- The Anthropic API key is billed per request. `/api/claude` is protected by a per-IP rate limit (30 requests/hour/visitor, see `RATE_LIMIT_MAX` in `server.js`) in addition to whatever site-wide password you set above.
