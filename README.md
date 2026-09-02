# Eagle I — AI Marketing Command Center

Multi-tenant AI marketing SaaS: real per-tenant login/signup (`auth.js`), a Postgres-backed
business profile + AI-generated content per tenant, and a dashboard (`index.html`) served by
an Express app (`server.js`) that keeps every third-party API key server-side.

## Run locally

```bash
npm install
cp .env.example .env   # then edit .env — DATABASE_URL and SESSION_SECRET are required,
                        # ANTHROPIC_API_KEY is needed for AI generation to work
npx node-pg-migrate up # creates the schema in that database
npm start
```

Open http://localhost:3000 — it redirects to `/login.html` (sign up to create the first tenant).

## Deploy (Render)

1. Push this repo to GitHub.
2. On [render.com](https://render.com), New → Blueprint → pick this repo (uses `render.yaml`).
   Or: New → Web Service → pick this repo, Build Command `npm install`, Start Command `npm start`.
3. Add a Postgres database (Render's managed Postgres, or any other host) and set `DATABASE_URL`
   to its connection string in the service's Environment tab, along with `SESSION_SECRET` and
   `ANTHROPIC_API_KEY`. The other vars in `render.yaml` (Stripe, Meta, Google Ads/Places/Business
   Profile, Resend) are each optional — every route that needs one is gated behind a clean
   "not configured yet" 503 until it's supplied, see the feature sections below.
4. Run the migrations against that database once (`DATABASE_URL=<...> npx node-pg-migrate up`,
   from your machine or a Render shell).
5. Deploy. Render gives you a `https://<name>.onrender.com` URL — that's your live site.
6. (Optional) Settings → Custom Domain to point your own domain at it.

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
`lib/hcadZipValues.js` and `scripts/importHcadZipValues.js` for what it does.

The same pass also populates `hcad_owner_parcels` — a per-parcel table of just the
site address and the owner-of-record's name, for every parcel where that name
confidently parses as one real individual (`lib/hcadOwnerNames.js`: businesses,
trusts, government owners, and HCAD's own "CURRENT OWNER" placeholder are all
filtered out — a real run of this keeps about 63% of Houston-area parcels). This is
what lets the Permits mailer (below) address a letter to a real name instead of
"Property Owner" — but only on an exact, unambiguous zip+address match; see
`findConfidentOwners()` in `lib/hcadZipValues.js` for the "only if fully confident"
rule. It's genuinely public county tax-roll data, so this is legal to use, but real
names on outbound mail carry a different weight than an anonymized value estimate —
worth being deliberate about, which is why this got a real conversation before being
built rather than just shipped quietly.

## Permits: area filtering + personalized mailer PDFs

The Permits tab is visible to real estate / home services tenants, and to any
other tenant whose own company name reads as construction-related (`lib/realEstateAccess.js`
— "ABC Construction LLC" or "Gulf Coast Roofing" qualifies regardless of which
industry they picked at signup). `routes/permits.js` enforces the same rule
server-side, not just in the UI. This is deliberately narrower than the
`showRealEstateFeatures` flag that gates the rest of the real-estate-only
bundle (Signals, Professional Partner Network, Houzz/Angi awards) — those
stay industry-only.

The tab groups every loaded permit's zip into a named Houston-area region
(`lib/houstonZipRegions.js` — a broader companion to the curated high-value
list above, covering every zip the weekly reports touch) so results can be
filtered down to just the areas a tenant cares about, with a running count
per area.

Any permit whose date falls in the **most recently published** weekly report
gets a real **🆕 NEW** tag (`mostRecentWeekKey`/`isNewestWeek` in
`lib/houstonPermits.js`) — deliberately relative to the data itself, not to
today's real calendar week: Houston Permitting Center's own publish lag runs
well over a week (confirmed directly against the live source — the newest
report was still only "Aug 17-23" as of Sept 2), so a permit dated in the
literal current week essentially never exists yet. Tagging against whatever
week the data itself is freshest for instead guarantees something is flagged
the moment a new report actually lands. Each area's header also shows a "N
NEW" count, and a **New Only** toggle next to the area filter narrows the
whole page down to just the newest batch (areas with nothing new drop out
entirely, same as the area filter).

From the filtered (or full) list, individual permits can be checked
directly, or picked automatically with **Select Top N by Value** (10 through
200) — ranked by each zip's best-available real value (HCAD average, falling
back to the curated estimate). That ranking always runs over whatever's
currently filtered, and only reaches across every loaded zip when no area
filter is active.

**Generate Mailer PDF** turns the selection into one real, professionally formatted
letter per permit — `POST /api/permits/mailer-letters` builds each letter's text
server-side (`lib/permitMailer.js`). Each letter references that specific permit's
own address, filing date, and the actual work involved: the city's `permitType`
field is almost always a generic bucket ("Building Pmt"), so `humanizeComments()`
does best-effort cleanup of the city's real free-text project description (e.g.
"PARKING GARAGE REMODEL 1-14-1-S2-A 2021 IBC" → "the parking garage remodel") —
stripping building-code citations, occupancy-classification codes, and permit-report
jargon, verified against a full week of real live permit comments (93% clean, the
rest fall back safely rather than risk printing something garbled). A keyword-based
`describeWorkType()` is the fallback when comments don't clean up well. Several
opening/body phrasings rotate in by a hash of the permit so a batch doesn't read as
one paragraph pasted at every address. Deliberately not AI-generated — a batch can
be up to 200 letters, which would blow through `/api/claude`'s per-IP rate limit and
cost real money for something a template handles well.

Each letter is addressed to a real property-owner name — resolved via the
`hcad_owner_parcels` table above — whenever the match is confident, and to
"Property Owner" otherwise; see the HCAD section above for what "confident" means
and why that bar exists. The browser lays out a real business-letter format with
jsPDF (loaded from cdnjs, same pattern as Chart.js above — no server-side PDF
dependency): letterhead, date, full recipient block, a personalized greeting, the
body, and a proper "Sincerely," signature block — then either downloads the file or
opens it print-ready.

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

## Vendor outreach + review requests, with reply capture

Two real, one-at-a-time email flows, both through Resend:

- **Vendor outreach** (Growth & Partners → Vendors): `lib/vendorContactFinder.js`
  reads a real vendor's own public website for a published contact email (SSRF-
  guarded — see that file's header comment), the tenant reviews/edits it, and a
  single **Find & Send** click sends the AI-drafted outreach message — always
  with a confirm popup showing the exact recipient + message first. Deliberately
  never a bulk/automatic blast: these are businesses with no relationship to the
  tenant, and no CAN-SPAM-compliant automated version of "email a stranger"
  exists. `routes/onboarding.js`'s `/api/vendors/outreach-email` sends it and
  logs it to `vendor_outreach`; `/api/vendors/outreach` lists the tenant's
  history, shown on the same page.
- **Review requests** (Social HQ): unchanged from before, still one customer at
  a time via `routes/reviews.js`, logged to `review_requests`.

**High-value-focus targeting** (real vendor lookups only): `lib/vendorTargeting.js`
does a deterministic keyword check (luxury, high-end, custom estate, etc. — no AI
call) on the tenant's own `services`/`differentiators` text. When it matches — e.g.
a bio like Levi Homes' luxury-home focus — the real Places search for that vendor
category is biased toward Houston's known high-value neighborhoods (from
`lib/houstonZipValues.js`) instead of a plain service-area search, and any result
whose own address falls in one of those zips gets tagged and sorted first. Shown
honestly on the page (an explicit banner + a "HIGH-VALUE AREA" tag per match), and
cached separately from a plain search for the same category (`category::hv`),
since it's genuinely a different query.

**Reply capture** (optional, on top of both): normally a reply just lands in
whatever `RESEND_FROM_EMAIL` is, invisible to Eagle I. With `RESEND_INBOUND_DOMAIN`
and `RESEND_WEBHOOK_SECRET` set, each outbound email's Reply-To becomes a
`reply+vendor-<id>@…` / `reply+review-<id>@…` address Resend hands to
`routes/inboundEmail.js` via a webhook (`POST /api/webhooks/resend-inbound`,
signature-verified with `svix`). That handler fetches the full reply, saves it
to the matching row, and relays a copy to the tenant's own email — so the reply
shows up both on the dashboard (right under the message it answered) and in the
tenant's inbox. Setup is two steps in Resend's dashboard, neither of which this
code can do on the app's behalf:
1. Enable email receiving — the zero-DNS-setup option is a Resend-managed
   `<id>.resend.app` address; a custom domain needs an MX record added instead.
   That domain is `RESEND_INBOUND_DOMAIN`.
2. Add a webhook for the `email.received` event, pointed at
   `https://<your-app>/api/webhooks/resend-inbound`, and put its signing secret
   in `RESEND_WEBHOOK_SECRET`.

Without either var, both flows still work exactly as before — Reply-To just
falls back to the tenant's own business email directly, so a reply still
reaches them via plain email routing, just not captured/shown here.

## Instagram image hosting

`routes/images.js` stores uploaded post images in Postgres (`post_images`, bytea) and
serves them publicly at `/img/:id` — no new external account, no new dependency. This
is what lets Instagram posting actually work: Instagram's Graph API requires a publicly
reachable image URL, which Eagle I previously had no way to provide. Wired into the
composer's existing drop-zone in `index.html` — dropping/selecting an image uploads it
immediately and the resulting URL is used automatically when publishing to Instagram.

## Real platform analytics (no fabricated numbers)

Social HQ's analytics tiles (Instagram followers, Facebook followers, Google
reviews) used to fabricate all of these — a seeded pseudo-random generator
keyed off today's date, styled to look exactly like a real Insights dashboard,
for every platform including the two that are actually connected via real
OAuth. `GET /api/social/analytics` (`routes/social.js`) and
`GET /api/gbp/analytics` (`routes/gbp.js`) replace that with the real thing:
current follower/fan counts straight from the Graph API for Instagram/Facebook,
and real average rating + review count from the Business Profile Reviews API
for Google — using the same connection + decrypted token each route already
holds for posting, no new OAuth scope needed. Deliberately no "+N this week"
delta: that would need a stored time series this app doesn't keep, and a made
-up delta next to a real count would be exactly the kind of half-real UI this
project avoids elsewhere. Both are status/read endpoints (always 200,
`connected:false` when nothing's linked yet) rather than 503-on-unconfigured,
matching `/api/gbp/status`'s existing shape. Yelp/Houzz/LinkedIn/Website
analytics tiles were removed outright rather than left fabricated — same
platforms as the "In Progress" tab below, for the same reason.

## The "In Progress" tab

The composer only ever offers Facebook, Instagram, and Google Business Profile —
the only three platforms Eagle I actually posts to for real. LinkedIn, Yelp, Houzz,
Nextdoor, and posting to a tenant's own website used to sit in the composer as
look-alike options that quietly did nothing when picked, and the old Credentials
page asked for real Yelp/Houzz/Nextdoor/WordPress passwords and API keys that were
never actually used for anything (only checked client-side for "not empty," then
stored in `localStorage`) — both removed. The **🚧 In Progress** tab is the honest
replacement: a plain status list distinguishing "no public API exists at all"
(Yelp, Houzz, Nextdoor — true for any third-party app, not just Eagle I) from
"a real API exists, just hasn't been built here yet" (LinkedIn, needs their own
Marketing Developer Platform approval like Meta/GBP already went through; a
tenant's own website, needs per-CMS integration). It also carries the honest
explanation for why the "Social Mention Ideas" examples on Market Intel are
AI-simulated rather than a live feed — no free API exists for scanning organic
social chatter; a real version would need a paid third-party social-listening
API (e.g. Mention.com, Brandwatch) with the tenant's own account and key.

## Notes

- `ANTHROPIC_API_KEY`, `SITE_USER`, `SITE_PASSWORD` must never be committed. `.env` is gitignored; only `.env.example` (no real values) is tracked.
- The Anthropic API key is billed per request. `/api/claude` is protected by a per-IP rate limit (30 requests/hour/visitor, see `RATE_LIMIT_MAX` in `server.js`) in addition to whatever site-wide password you set above.
