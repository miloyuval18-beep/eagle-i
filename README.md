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
   Profile, Resend, and `GOOGLE_SERVICE_ACCOUNT_JSON` for Eagle I CRM's Google Workspace email) are each optional — every route that needs one is gated behind a clean
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

## Real search rankings (Google Search Console)

`routes/searchConsole.js` shows a tenant's actual Google ranking positions,
impressions and clicks per keyword — real numbers, not the AI-estimated
"Hottest Keywords" table it sits next to. Unlike Google Ads or Business
Profile, there's **no developer-token or manual-review gate** — it's a
plain OAuth connection, same setup effort as Business Profile.

Needs `GOOGLE_SC_CLIENT_ID`, `GOOGLE_SC_CLIENT_SECRET`, `GOOGLE_SC_REDIRECT_URI`
(a Google Cloud OAuth client with the `webmasters.readonly` scope — can reuse
the same Cloud project as Places/Ads/GBP, with its own OAuth client and
redirect URI, e.g. `https://<your-domain>/api/search-console/callback`).
The tenant's Google login also needs to already have **verified ownership
of their site in Search Console** (search.google.com/search-console) — a
separate, one-time step on Google's own site, not something this app can
do on their behalf. A brand-new or very low-traffic site may show no rows
at all — Search Console only reports on keywords it's actually recorded
real search impressions for, which is an honest limit of the data, not a
bug here.

## San Diego market

A company picks its metro in Profile ("Area for the vendor lists"). **San Diego**
is the first California market; the Texas ones are unchanged. Every Texas source
(TBAE, TDLR, TREC and so on) only appears for a Texas market, and a California
market gets its own (`lib/markets.js` carries a `state` per market; each source in
`lib/vendorDirectories.js` says which states it serves).

What San Diego uses, all of it real public data:

- **Contractors (CSLB)** -- `lib/cslbContractors.js`. The Contractors State License
  Board's free master list (cslb.ca.gov/onlineservices/dataportal): every general
  contractor and trade, with phone, classifications, expiry and workers' comp status.
  No email (state law), so email still comes from the Google lookup. The portal's
  firewall rejects Node's built-in `fetch`, so the download uses the plain `https`
  module; the 75MB file is streamed (`lib/csvStream.js`) and only San Diego County
  rows are kept.
- **Real estate brokers (DRE)** -- `lib/dreRegistrants.js`. The Department of Real
  Estate's public licensee list; brokers and brokerages only. Broker street addresses
  are not offered for letters (an address of record is sometimes a home address).
- **Banks (FDIC)** -- the same importer as Houston, now state-aware
  (`node scripts/importFdicBanks.js`). The FDIC moved its API to `api.fdic.gov`; if its
  TLS certificate is still wrong the import fails with a certificate-name error. That is
  on their side. Do not turn certificate checking off to get around it.
- **Permits** -- `lib/sdPermits.js`. The City of San Diego's open data, refreshed daily
  (City only: Chula Vista, Oceanside, Escondido, Carlsbad and the county publish
  separately). The file has no ZIP column and many no-plan permits carry only a parcel
  number, so ZIP and street address are filled in from the public SANDAG parcel layer.
  The permit holder is often a contractor, so letters stay addressed to "Property Owner".
- **Area values** -- `data/sd_zip_values.json`, built by `scripts/importSdZipValues.js`
  from the public SANDAG parcel layers (no owner names): per ZIP, the median county
  assessed value of single-family homes whose last transfer was recorded since 2022.
  California reassesses a home to its purchase price when it sells, so that approximates
  recent sale prices; it is not an appraisal. ZIPs with under 30 recent transfers get no
  value. Re-run the script to refresh (a few minutes, ~600 requests).
- **Weather** -- the National Weather Service at the San Diego point, with Red Flag /
  Fire Weather alerts added to the storm triggers.

**Not built, on purpose: aging systems.** The county's "effective year" is two digits
("08"), which can mean 1908 or 2008. Guessing the century would tell the owner of a
100-year-old house that its roof is 18 years old, so that section says it is not
available for San Diego yet.

**Do not use the county's internal parcel service** (`gis-public.sandiegocounty.gov`,
"for use of the SanGIS JPA member users only", and it carries owner names). Only the
public SANDAG release (`geo.sandag.org`) is used.

Importers run monthly on the server (`lib/cslbRosterWorker.js`, `lib/dreRosterWorker.js`)
and by hand: `node scripts/importCslbContractors.js`, `node scripts/importDreRegistrants.js`
(both take `--dry-run`).

## Reddit lead-listening

`routes/redditLeads.js` + `lib/redditPollWorker.js` search Reddit once a
day, per tenant, for real public posts matching keywords/subreddits the
tenant sets themselves (Social HQ → Market Intelligence → "Reddit Leads").
No AI relevance filtering — what's shown is exactly what Reddit's own
search returned for the tenant's own keywords, honestly labeled as
"posts matching your keywords," not "confirmed leads." Eagle I never
posts or replies on Reddit on a tenant's behalf; every card links to the
real post so the tenant replies manually, from their own Reddit account.

Needs `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` — register one app (script
or web app type) at reddit.com/prefs/apps; this is a single app-level
credential for the whole product, not per-tenant, since it only ever reads
public posts (OAuth2 client_credentials grant, no Reddit login involved).
Without these two vars the feature silently no-ops — the poller never
starts and the settings box just shows "not configured yet"; nothing else
in the app is affected.

**Commercial-use note**: Reddit's free API tier is licensed for
non-commercial use; a paid product using it is technically "commercial
use," which normally needs Reddit's separate paid approval. This is
running on the free tier at deliberately small scale (one search cycle
per tenant per day, `tenants.monthly_reddit_search_cap`) as an accepted
risk rather than a resolved one — worth revisiting if usage grows or
Reddit objects.

## Eagle I CRM (separate product, Phase 1)

**Eagle I CRM** is its own product: a self-standing construction CRM for
builders and remodelers (see `EagleI_Construction_CRM_Deep_Dive.pdf` for the
plan). It shares this server and login system but nothing in the marketing UI:

- App at `/crm` (`crm.html`), its own sign-in/sign-up at `/crm/login`
  (`public/crm-login.html`). A CRM signup gets `tenants.products = {crm}`; a
  CRM-only company visiting `/` is sent to `/crm`.
- A marketing company can switch the CRM on from `/crm` (adds `crm` to its
  products); its existing landing-page leads are then brought in. Landing-page
  leads only create deals for companies that have the CRM.
- Every `/api/crm/*` route except `/api/crm/me` and `/api/crm/activate`
  answers 403 (`code: no_crm`) for companies without it.

**Team (step 2).** A company can have many logins. Roles: `owner` (signed up),
`admin` and `member`. Owners/admins invite people from the CRM's Team screen
(`lib/crmTeam.js`): a one-time link to `/crm/join` that expires in 7 days (only
its hash is stored); if the email can't be sent, the inviter gets the link to
pass on. Members work deals; only owners/admins change the team, company
details, playbooks and automation settings. Invited people use the CRM only:
`/` sends them to `/crm` and every `/api/*` route outside `/api/crm` and
`/api/auth` answers 403 for them. Each deal can have an owner, new leads can be
handed to a chosen person automatically, and the timeline records who did what.

**Estimates (step 3).** `lib/crmEstimates.js`, `routes/crmEstimates.js`. A cost
catalog (owners/admins edit it) and line-item estimates on a deal: quantity ×
cost × (1 + markup), worked out on the server in cents. Two kinds: design
agreement and construction estimate. Sending emails the homeowner a private
link, `/e/<48-hex token>` (`public/estimate.html`), where they see prices only
(never costs or markups), download a PDF (jsPDF, in the browser) and accept by
typing their name, or decline. Sending moves the deal to "Design agreement
sent" / "Proposal sent" (so those follow-ups start); accepting moves it to "In
design" / "Contract signed", adds a "Needs you" item and emails the deal owner.
The homeowner's API is `/api/crm-public/*` (no login; rate-limited). Editing a
sent estimate puts it back to draft until it's resent; accepted ones are locked.

**Automated communications (step 4).**
- *Lead intake* (`lib/crmIntake.js`, `routes/crmIntake.js`): each company has a
  private intake key (`tenants.crm_intake_key`) for a website inquiry form at
  `/crm/f/<key>` (link or embed via iframe; honeypot + per-IP and per-company
  limits) and a forwarding address `lead-<key>@$RESEND_INBOUND_DOMAIN`.
  Forwarded Houzz/Angi/Thumbtack emails are read by AI (plain regex fallback
  without `ANTHROPIC_API_KEY`); non-leads are ignored. New leads go to the
  "give new leads to" person, get the instant reply and email the team.
- *Playbook triggers*: `stage` (as before), `meeting` (days before a deal's
  `site_visit_at`) and `estimate_expiry` (days before a sent estimate's
  valid-until day ends, Central). Reminders send 8am–8pm Central any day and
  never after the event; a reply stops only the stage follow-ups. Starter
  playbooks added: instant reply to new leads, site-visit reminder, estimate
  about to expire. Setting a site visit moves the deal to "Site visit set".

**Google Workspace email (step 5).** `lib/crmGoogle.js`, `routes/crmGoogle.js`.
Uses domain-wide delegation: Eagle I's service account (env
`GOOGLE_SERVICE_ACCOUNT_JSON`, the key file JSON or base64 of it) is allowed by
the company's Workspace admin for two read-only scopes
(`admin.directory.user.readonly`, `gmail.readonly`) in their Admin console. The
CRM's Company screen shows the client ID and scopes to paste, then checks access
before saving. Every included mailbox is read every ~10 minutes (first run: last
30 days), headers only. Only emails with a CRM contact are stored
(`crm_emails`, once per Message-ID, with Gmail's short preview); everything else
is never kept. A customer's email stops that deal's stage follow-ups; a team
email to a new lead sets its first-response time. If access is revoked in
Google, the connection shows the error.

*Server setup needed once:* create a Google Cloud project, enable the Gmail API
and Admin SDK API, create a service account with a JSON key, and set
`GOOGLE_SERVICE_ACCOUNT_JSON` on Render. No Google app verification is needed
for domain-wide delegation.

**Weekly reports (step 6).** `lib/crmReports.js`, `routes/crmReports.js`. Every
Monday from 8am Central, for the week just ended: facts counted from the
records (new leads by source, pickup time, signed/lost with reasons, estimates
sent/accepted/declined, stalled deals, waiting leads, and per team member: leads,
pickup time, deals moved, notes, customer emails, estimates, signed, stalled)
and a written summary (successes, challenges, the team, focus). AI writes it
from the facts only (told never to rank or judge people); plain rules write it
without `ANTHROPIC_API_KEY` or if AI fails. Saved in `crm_weekly_reports`,
emailed to owners and admins (the "weekly summary" switch), readable under
Account → Weekly reports; "This week so far" writes an unsaved one on demand
(5/day). This replaces the Phase 1 counts-only email.

**Tasks, Today, stages, voice (step 7).** `lib/crmTasks.js`. Tasks on deals (due
date, assignee); Eagle I adds some itself on stage changes (`AUTO_TASKS`: kickoff
and deposit when signed, visit prep, final walkthrough), once per deal. The
"Today" tab combines "Needs you", your open tasks (owners/admins can see the
whole team's) and this week's site visits; its badge counts flagged items plus
overdue tasks. Companies can rename stages and hide ones they don't use
(`crm_settings.stageLabels` / `hiddenStages`; New, Contract signed, Complete and
Lost always stay). Notes can be dictated (the browser's own speech-to-text);
with "pick out" on, AI reads the note for the job value (only if none is set),
the next step (becomes a task) and a site-visit time (only if none is set).

**Files and the homeowner portal (step 8).** `lib/crmPortal.js`,
`routes/crmPortal.js`, `public/portal.html`. Photos (JPEG/PNG/WebP) and PDFs on a
deal, up to 8 MB each, type checked from the bytes, stored in Postgres
(`crm_files`), each shared with the homeowner or kept to the team. Each deal has
a private portal at `/p/<48-hex token>`: plain-words status, next visit,
estimates, shared photos/documents and team updates; the homeowner can send a
message (logged as a reply, stops follow-ups, lands in "Needs you", emails the
deal owner) or add photos. Team updates can be emailed with the link. Playbooks
can include `{portal_link}` (the starter welcome email does).

**Payments (step 9).** `lib/crmPayments.js`, `routes/crmPayments.js`,
`public/invoice.html`. Each company connects its own Stripe account (Connect,
Express); money goes straight to them, with an optional Eagle I fee
(`CRM_PAYMENT_FEE_BPS`, basis points, default 0). Invoices (deposit, progress,
final) have a pay page at `/i/<token>` with Stripe Checkout on the company's
account (card or ACH). Accepting an estimate with money due at signing creates
the deposit invoice once and the estimate page offers to pay it. A payment is
confirmed with Stripe on the homeowner's return and by the Connect webhook
(`POST /api/stripe/connect-webhook`, secret `STRIPE_CONNECT_WEBHOOK_SECRET`; only
the invoice's own account can mark it paid), then logged, "Collect the deposit"
ticks off, the team is told. "Invoice reminders" is a playbook trigger
(`invoice_due`, days from the due date). Without Stripe, invoices still work and
checks/cash are recorded by hand.

*Setup needed once:* turn on Connect in the Stripe dashboard (Express accounts),
and add a Connect webhook for `checkout.session.completed` and
`checkout.session.async_payment_succeeded` pointing at
`/api/stripe/connect-webhook`; put its signing secret in
`STRIPE_CONNECT_WEBHOOK_SECRET`.

**Project files and Google Drive.** `lib/crmPortal.js` (files), `lib/crmDrive.js`.
Every deal's files sit in folders (Plans, Permits, Contracts, Photos,
Selections, Receipts, Warranties, Other), sorted automatically by name and kind
and movable by hand. Photos, PDFs, video, Word/Excel/PowerPoint, CSV/text and
CAD (DWG/DXF) are accepted, checked by their bytes; HTML/SVG never. A plan with
the same sheet as an earlier one ("A1 Floor Plan rev3") becomes its next
version; older versions stay one tap away, homeowners only see the current one,
and bid requests always open the newest. Up to 8 MB per file, or 50 MB with
Drive (big uploads go as raw bytes to `/api/crm/deals/:id/files/raw`).

Google Drive uses the Workspace connection: the admin adds the Drive scope
(`https://www.googleapis.com/auth/drive`) to Eagle I's domain-wide delegation,
then switches Drive on in Company details. Eagle I makes a Shared Drive
"Eagle I Projects" (or a folder, where shared drives aren't allowed), a folder
per job with the subfolders above, and keeps both sides in step every few
minutes (Drive's changes feed): uploads go up, files dropped or moved in Drive
come down, deletes go to Drive's trash. Files up to 8 MB keep a copy in Eagle I;
bigger ones live only in Drive and are fetched when opened.

**Sign in with Google (personal Gmail).** `lib/crmGoogle.js`. For companies
without Google Workspace, each person taps "Sign in with Google" (Company
details, or their own settings) and allows Eagle I to read their email; the
owner can also allow Drive, and that account's Drive then holds the "Eagle I
Projects" folder. Refresh tokens are kept per mailbox, encrypted with
`SOCIAL_CREDENTIALS_KEY`. With no company domain, "the company" is everyone who
signed in, so a customer on gmail.com is still the customer.

*Setup needed once:* a Google Cloud OAuth client (Web application) in
`GOOGLE_CRM_CLIENT_ID` / `GOOGLE_CRM_CLIENT_SECRET` (the marketing side's
`GOOGLE_GBP_*` client is used if these aren't set), with the redirect URI
`https://<host>/api/crm/google/oauth/callback` (or set `GOOGLE_CRM_REDIRECT_URI`),
the Gmail and Drive APIs enabled, and the `gmail.readonly` and `drive` scopes
on the consent screen. Both are Google "restricted" scopes: until Google
verifies the app, sign-in shows an "unverified app" warning and is limited to
100 users (and test users must be listed while the app is in Testing).

**Email only (step 10).** Eagle I CRM doesn't text. Everything that reaches a
homeowner or a sub goes by email: playbook steps (old text steps saved before
this change go out as emails with the same approved words), the assistant's
messages, and the "Write them an email" box on each deal. Twilio isn't needed.

**Running the job (step 11).** `lib/crmJobs.js`, `routes/crmJobs.js`, Jobs tab.
A signed contract gets a schedule laid out on working days from the company's
template (or the built-in remodel one; "Save as my template" on any job). Daily
logs (shared ones become portal updates); subs & vendors with license and
insurance expiry (expiring within 30 days → "Needs you"); purchase orders
emailed to the vendor (feed job costing); change orders the homeowner approves
in the portal by typed name (approved ones add to the deal value); selections
with allowances the homeowner picks in the portal (over the allowance drafts a
change order for the difference for the team to send). All phases done →
"Needs you" suggests moving the deal to Complete. The tab bar is now Pipeline,
Today, Jobs, Money; Automations moved to the Account menu.

**Job costing (step 12).** `lib/crmCosts.js`, `routes/crmCosts.js`. Budget =
the accepted construction estimate's cost plus approved change orders' cost;
contract = the deal value; actual = `crm_costs` (receipts read by AI from a
photo via `generateJSON(..., { images })`, received purchase orders added once,
labor as hours × rate, manual entries). Spending more than 15 points ahead of
schedule progress → "Needs you". Owners/admins export invoices or costs as CSV
(`/api/crm/export`, formula-safe) for the accountant.

**Qualifying and booking (step 13).** `lib/crmQualify.js`,
`routes/crmQualify.js`. Every deal gets a fit score (0–100, grade A ≥65 / B ≥45
/ C) with a plain reason for every point: budget against the company's
smallest job, the ZIP's median home value, timeline, referral source,
decision-makers, questionnaire answered. It rescores when value, address,
source, email or phone change. The homeowner's questionnaire (`/q/<portal
token>`, also `{qualify_link}` in playbooks; the starter new-lead reply
includes it) fills in the deal; A/B moves New → Qualified on its own. Site
visits are self-booked from `/b/<portal token>` (`{booking_link}`) or the
company's public page `/book/<intake key>` (makes a lead first): slots come
from the company's days/hours, visit length, travel buffer, minimum notice and
horizon (Central time), minus visits already booked. Booking sets the visit
(→ "Site visit set", reminders start) and writes a pre-visit brief (AI when
`ANTHROPIC_API_KEY` is set, else from the facts) emailed to whoever is going.

**The customer for life (step 14).** `lib/crmLifetime.js`,
`routes/crmLifetime.js`, Account → Referrals & partners. Every contact and
every trade partner (`crm_partners`) has a 10-hex code; `/r/<code>` redirects to
the company's inquiry form with `?ref=`, and a lead from it gets source
referral/partner and `referred_by_contact_id`/`partner_id` (never yourself).
Signing a referred deal adds a `crm_referral_rewards` row (the company's reward
amount) and a "Thank them" item in Needs you, cleared when marked done. The
scoreboard shows leads, signed jobs and signed value per partner and per
referring client. New starter playbooks (13 in all): "Ask for a review" (7 days
after Complete, `{review_link}`; cancelled when the company has no review link),
"Home care reminders" (trigger `home_care`) and "Warranty check-in" (trigger
`warranty_end`, 30 days before); the Job-complete email now carries the
client's `{referral_link}`. The home file (`crm_home_items`) starts itself when a
job completes (workmanship warranty for the company's warranty months, plus
every chosen selection); the team adds appliances and systems with a care
interval. The 5-minute tick queues care reminders as they come due and warranty
check-ins 60 days out (plus a walkthrough task for the workmanship warranty).
The portal shows the home file and, once the job is underway, the homeowner's
own referral link.

**Marketing & backlog (step 15).** `lib/crmMarketing.js`,
`routes/crmMarketing.js`, Account → Marketing & backlog. The inquiry form and
public booking page send the page's `gclid`/`fbclid`/`utm_*` tags and referrer
(the embed snippet passes the host page's query into the iframe); they're
stored on `crm_deals.utm` and pick the source (new sources: Google Ads, Google
Local Services, Facebook & Instagram, Nextdoor, home show, yard signs).
Owners/admins enter monthly spend per channel (`crm_marketing_spend`, one row
per channel per month), with a "Needs you" nudge on the 2nd for companies that
track spend. Per channel over 3–24 months: spend, leads, good fits (A/B), site
visits, signed jobs and value, cost per lead, cost per signed job, signed
value per $1. Backlog = signed jobs + the unfinished share of jobs underway
(by schedule phases), against monthly capacity (set, or the last year's
completed work) → "booked N weeks out", plus the pipeline weighted by win rate
per stage (from two years of closed deals, defaults under 5). Below the low
mark it says which channel signs jobs cheapest; above the high mark, which to
cut first. The weekly report carries it. CRM API responses are now
`Cache-Control: no-store` and the CRM page `no-cache`.

**Spanish for homeowners (step 16).** `lib/crmSpanish.js`. Each contact has a
`language` (null = English, `es`), set by filling the inquiry form, booking page
or questionnaire in Spanish, or on the deal sheet ("Reads"). Playbooks carry an
optional `steps_es` (same messages and timing; only the words differ) that is
approved together with the English: `playbookHash` includes it only when
present, so existing approvals stay valid. Every starter has a Spanish version;
"Add a Spanish version" in Automations fills in the starter's Spanish or, for
reworded playbooks, an AI translation to read over (`POST
/api/crm/playbooks/:id/spanish`; nothing is saved or sent). Spanish readers get
the Spanish wording with dates in Spanish; changing the English message count
drops the old Spanish and says so. The estimate, invoice, change-order and
project-update emails use a phrasebook (`say(lang, key)`). The inquiry form,
questionnaire, booking page, portal, estimate and invoice pages have an
Español/English switch, starting from the contact's language, else the
browser's.

**Import, setup and AI helpers (step 17).** `lib/crmAssist.js`,
`routes/crmAssist.js`, Account → Import & setup.
- *Import:* CSV/TSV or .xlsx (up to 8 MB, 3,000 rows) from Buildertrend,
  JobTread, another CRM or a sheet. Columns are guessed from the headers and
  can be changed; stages, sources and dates (Excel serials too) are read from
  the old tool's words. Rows come in as history: no automatic emails, no
  waiting-lead alerts, matching people joined up, same person + project
  skipped. Each import is a `crm_imports` row and its deals carry `import_id`,
  so Undo removes them (and contacts left with nothing).
- *Setup interview:* eight questions set the minimum job, visit days and hours,
  design stages, the waiting-lead nudge, warranty, review link and monthly
  capacity; with AI, the unapproved first emails are rewritten in the owner's
  voice (placeholders checked; approved playbooks never touched). Owners and
  admins see a "Set up" banner until it's done.
- *Estimate drafts:* "Draft lines from a description" in the estimate editor;
  catalog items are used with their own cost and markup, anything else is an
  AI cost guess marked "check your cost". Nothing saves until Save.
- *Weekly job updates:* Fridays from 10am Central, every job in production
  gets a draft built from the week's shared logs, finished and upcoming phases
  and new photos (never private logs), in the homeowner's language, plus a
  "Read & send" item in Needs you. It waits in the deal's portal section;
  posting clears it. "Draft this week's update" makes one any time. Without
  `ANTHROPIC_API_KEY` the update is written plainly from the schedule, and the
  estimate drafts and voice rewrite say they're off.

**Draws and homeowner check-ins (step 18).** `lib/crmDraws.js`,
`lib/crmPulse.js`, `routes/crmDrawsPulse.js`.
- *Payment schedule:* `crm_draws` per job: a share of the contract (or "the
  rest"), tied to a schedule phase, to the job being Complete, or by hand.
  Signing lays the company's standard (or the built-in 30% at rough-in, 30% at
  cabinets, the rest at completion) against the schedule by phase name.
  Marking that phase done makes the invoice for the contract as it stands then,
  due in a week; with "send milestone invoices on their own" it goes straight
  out, otherwise it waits in Needs you. Claimed atomically, so a phase saved
  twice bills once. "Make this my standard" saves a job's draws.
- *Check-ins:* switched on in Automations (approving the fixed wording). Every
  14 days during construction, weekdays 9–5 Central, the homeowner gets a
  one-tap 1–5 email in their language (`/pulse/<token>?s=N`), never after an
  unsubscribe. 3 or lower → Needs you ("unhappy") plus an email to the deal
  owner; answers show on the deal and in the weekly report.
- `crm.saveSettings` and the first-load backfill now keep settings other parts
  of the CRM store alongside (they used to drop them).

**The CRM in the team's day (step 19).** `lib/crmDaily.js`, `routes/crmDaily.js`.
- *Calendar link:* Account → My calendar & morning email. A private
  `/cal/<token>.ics` (RFC 5545, escaped and folded) with the person's site
  visits (address, phone, brief), their job phases and their dated tasks;
  owners and admins get every visit and phase. One-tap Google/Apple add; a new
  link retires the old.
- *Morning email:* 7–11am Central, Monday–Saturday, once a day per person:
  today's visits with briefs, phases starting, tasks due or overdue, and their
  Needs-you count. Empty days send nothing; anyone can switch theirs off.
- *Rain:* once a morning, outdoor phases (roofing, framing, concrete, decks...)
  in the next three days are checked against the National Weather Service
  forecast for the house (geocoded once via the Census geocoder, cached on the
  property). 60%+ daytime rain → Needs you, once per phase per day.
- *Duplicates:* Import & setup lists people sharing an email, a phone, or a
  name and address; merging moves every row that points at the merged contacts
  (found from the database's own foreign keys) in one transaction.
- *Home-screen app:* `crm-manifest.webmanifest`, icons and `crm-sw.js` (pages
  always from the network, the last good copy offline, `/api` never cached).
- Security: the server no longer serves the project folder itself (source,
  migrations and config were downloadable); a test keeps it that way.

**Subs confirm their dates, and cash flow (step 20).** `lib/crmSubs.js`,
`routes/crmSubs.js`.
- *Sub confirmations:* switched on in Automations. Three days before a phase
  with a sub on it (weekdays 9–5 Central), the sub gets the job, address and
  dates with "I'll be there" / "Can't make it" (`/sub/<token>`). Can't make it,
  or no answer by the day before → Needs you ("sub_conflict"). New dates or a
  different sub retire the link and ask again. The schedule shows ✓ / ✕ / … per
  phase.
- *Cash flow:* Money → next 8 weeks by week: sent invoices by due date (overdue
  ones totalled up front), milestone payments not yet invoiced (a week after
  their phase ends; "the rest" net of what's billed and the other pending
  draws), and sent purchase orders by their needed-by date.

**Ask Eagle I: the assistant (step 21).** `lib/crmAssistant.js`,
`lib/crmBids.js`, `lib/crmCheckins.js`, `routes/crmAssistant.js`.
- *The chat:* the ✦ button on every CRM screen (or ⌘/Ctrl-K) opens a
  conversation, full screen on phones and a side panel on desktop. Typed or by
  voice, with PDFs/photos attached (`crm_ai_files`, sniffed by content, 8 MB).
  Progress streams back as newline-delimited JSON. Conversations are per person
  (`crm_ai_threads`/`crm_ai_messages`, the API content stored as-is so thinking
  blocks go back unchanged; files shown to the model are replaced by a note in
  stored history).
- *Tools over the one database* (Claude tool use, `createMessage` in
  `lib/anthropic.js`, model `CRM_AI_MODEL`, default `claude-sonnet-5-5`):
  search, deals, pipeline, team, **team_activity** (what a person did, from
  notes, stage moves, Gmail-synced emails, texts, tasks, site logs, files,
  costs, estimates and check-ins; members only their own), Needs you, what's
  coming up, money, subs, reading plans (PDF/image straight to the model),
  bids and the weekly numbers. Internal changes happen at once: tasks, notes,
  **log_work** (site log plus phases started or finished, which can bill a
  milestone), visits, stages, new deals, draft estimates from a scope, saving
  attachments to a deal.
- *Anything outside the company* (bid requests, emails and texts to the
  homeowner, portal updates, sending an estimate) becomes a card
  (`crm_ai_actions`) the person taps to send. Only that person can confirm it.
  If nothing goes out, the card stays to retry.
- *Bid requests:* "send these plans to all the framers" matches subs by trade.
  Each gets a private `/bid/<token>` page with only the chosen files and the
  area (street address once awarded) to send a price and a note. Bids land on
  the deal ("Bids from subs", pick one) and in Needs you.
- *End-of-day check-in:* weekdays 5–8pm Central, "what did you get done
  today?" with a `reply+day-<id>@` address. A reply from the person's own
  address is stored, and with AI on it's filed as them (internal tools only,
  in their "End-of-day updates" conversation). Switch: Account → My calendar &
  morning email.
- Without `ANTHROPIC_API_KEY` the chat says so; everything else works.
  `ANTHROPIC_BASE_URL` can point at a proxy (or a local stand-in for testing).
- Scenarios now live in `test/scenarios/` (`npm run test:scenarios`, local
  database only).

**Email search, more actions, sturdier AI (step 22).**
- Gmail sync now keeps the text of each customer email (no attachments, quoted
  history trimmed), searchable with a full-text index; emails logged earlier
  get their text backfilled a few at a time (`backfillBodies`, by
  `rfc822msgid:`). The assistant's `search_emails` / `read_email` answer
  "what did Maria say about the tile?", and get_deal lists recent emails.
- The assistant can now update schedule phases (dates, status, sub, who),
  add phases, log costs, add vendors, draft change orders, purchase orders and
  invoices, and record payments; sending a change order, PO or invoice is a
  card like the other outside sends.
- `lib/anthropic.js` sends every call through one `post()` that tries
  `AI_MODEL`/`CRM_AI_MODEL`, then `claude-sonnet-5-5`, `claude-opus-5-5`,
  `claude-sonnet-5` when the API says a model doesn't exist, and remembers the
  one that answers. Owners get "Test the AI connection" in the assistant.

**Plans and billing (step 23).** `lib/crmBilling.js`, `routes/crmBilling.js`,
Account → Plan & billing.
- Plans (placeholders, change with env vars, no code change): Builder $199/mo
  (3 people), Team $399/mo (10 people), Company $699/mo (everyone); yearly = 10
  months. Names, prices and seats: `CRM_PLAN_{BUILDER,TEAM,COMPANY}_{NAME,PRICE,SEATS}`.
  Every plan has every feature; the assistant has a monthly message allowance.
- Every company gets a 14-day trial (`tenants.crm_trial_ends_at`; companies
  already on the CRM got one from the day this shipped).
- Stripe: products and prices are created on first checkout (lookup key
  `eaglei_crm_<plan>_<interval>_<price>`), so there is nothing to set up in the
  dashboard. Checkout carries the remaining trial over; the Stripe billing
  portal handles cards, invoices, plan changes and cancelling. The existing
  `/api/stripe/webhook` routes CRM events (metadata `product: crm`) to
  `handleEvent`: add `customer.subscription.created/updated/deleted` to that
  webhook in Stripe.
- Nothing locks unless `STRIPE_SECRET_KEY` is set **and** `CRM_BILLING_ENFORCE=true`.
  Then an ended trial, a cancelled plan, or a payment 7+ days past due makes
  the CRM read-only (changes return 402 with the reason; billing still works;
  automatic emails keep going), with a banner. Seat limits apply to new
  invites, and the assistant stops at the month's allowance.

**Loose ends tied (step 24).**
- *Phone photos:* every upload (deal files, receipts, the assistant, the
  homeowner's portal) runs through `prepFile` in the browser: iPhone HEIC
  becomes JPEG where the browser can open it (else a plain explanation), and
  photos over 4 MB are shrunk to 2560 px JPEG instead of being turned away.
- *Old Excel:* `lib/xlsReader.js` reads .xls (Excel 97–2003) with no
  dependency: the compound-file container (FAT, DIFAT, mini stream) and BIFF8
  records (shared strings across CONTINUE records, labels, numbers, RK/MULRK,
  formulas' last values). The importer takes .xls like .xlsx and .csv.
  Fixtures in `test/fixtures/` were written with the xlwt library.
- *Spanish, the rest of the way:* homeowner pages send `X-Lang: es` and
  `/api/crm-public` answers with Spanish error messages (`ERRORS_ES`); Spanish
  automatic emails and check-ins carry a Spanish footer and link to a Spanish
  unsubscribe page (`?lang=es`, outside the signature).

**The AI helping day to day (step 25).** `lib/crmCoach.js`, `routes/crmCoach.js`,
a ✨ Coach section on every deal.
- *Lead summary:* leads that come in from outside get three lines (Wants /
  Budget / Next) the moment they arrive, written once and shared by the deal
  and the team's "New lead" email (which waits up to 12 s for it).
- *Next move:* "What should I do next?" on any deal: the advice, why, and a
  drafted message; deals flagged as quiet get it added to their Needs-you item
  (a few per tick).
- *Reply drafts:* a customer email synced from Gmail gets a reply drafted
  (`crm_emails.draft_reply`), in the company's voice from its past emails and
  the homeowner's language; "Draft a reply" works on demand too. Review it and
  send from the deal (`POST /api/crm/deals/:id/email`).
- *Collections:* invoices 7+ days overdue get a reminder drafted
  (`crm_invoice_nudges`; up to three, a week apart, firmer each time, aware of
  how they've paid before; an AI draft that drops the pay link is replaced by
  the plain one) and a "Review & send" item in Needs you.
- *Voice job log:* 🎤 Talk and "✨ File it for me" on the job screen: a clean
  site log, phases moved, follow-up tasks, and site issues flagged.
- *Spoken briefing:* ▶ Listen on the weekly report (the browser's own voice).
- *Business questions:* new assistant tools: sub_prices, job_margins,
  win_rates, lead_sources, plus next_move and draft_reply.
- Everything has a plain version when AI is off, and nothing here sends by
  itself.

Code: `lib/crm.js` (records, stages, "Needs you", weekly summary),
`lib/crmPlaybooks.js` (automatic emails), `routes/crm.js`, migration
`1760400000000_crm_core.js`.

- **Records:** contact (person), property (house, with the HCAD median value for
  its ZIP when known) and deal (stage, value, source), plus a timeline per deal.
- **Design-build stages:** New → Qualified → Site visit → Design agreement sent →
  In design → Proposal sent → Contract signed → In production → Complete, or Lost.
- **Automatic intake:** every landing-page lead becomes a contact + deal, matched to
  an existing contact by email or phone. Older leads are brought in the first time
  the pipeline opens. Moving a deal updates the Leads inbox status (and stops the
  new-lead emails), and the other way round.
- **Playbooks (approve once, run forever):** six starter playbooks tied to stages,
  all off until the owner approves the exact wording. Editing the wording withdraws
  the approval. Sends stop when the deal leaves the stage, when the person replies
  (reply kind `crm`, via the same inbound webhook), unsubscribes or bounces; later
  steps go out weekdays 9–5 Central; 60 a day per company; one switch pauses all.
  Approving a playbook never emails deals already sitting in that stage.
- **Needs you:** only exceptions: a new lead untouched for 30 minutes (adjustable),
  a deal with no activity past its stage's limit, a reply, or a failed send.
- **Weekly report:** Monday from 8am Central (see step 6 below).

The background work runs on the existing 5-minute tick in `lib/followUpWorker.js`.

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

### Reply sorting, results, sending domains, customers (outreach measurement)

- **Replies are sorted** by `lib/replyClassifier.js` (plain rules, no AI): interested, not now,
  unsubscribe, automatic reply, or "needs a look". An unsubscribe reply opts the address out at
  once; an automatic out-of-office reply is stored but is not counted as a reply and does not stop
  follow-ups. Owners can re-sort a reply by hand.
- **Results** (`lib/outreachReport.js`): reply rate by category, city and subject line, and
  two-version tests. Only first emails count. Winners are only named when a two-proportion test
  says the gap is unlikely to be chance.
- **Monthly report** (`lib/monthlyReport.js`) is viewable in the app, saved as a PDF, emailed on
  request, and emailed automatically in the first week of each month (from 9am Central) to
  companies that have it switched on and had activity.
- **Sending domain** (`lib/sendingDomain.js`): a company can verify its own domain through Resend's
  Domains API so mail goes out from hello@theirdomain.com. **`RESEND_API_KEY` must be a full-access
  key** (a "sending access" key cannot create domains). Until Resend reports the domain verified,
  mail keeps using the shared address.
- **Past customers** (`lib/customers.js`): imported lists require a stored confirmation; every
  email has an unsubscribe link and honours the same opt-out list; daily limit
  `CUSTOMER_EMAIL_DAILY_CAP` (default 200). Bounces and spam complaints on these emails come through
  the same Resend webhook as vendor outreach.
- **Lead emails and landing-page tests**: `lib/leadSequence.js` (off until the owner switches it
  on), `lib/landingStats.js` (one visitor cookie per browser; robots are not counted).
- **Work with us** page (`lib/workWithUs.js`): public uploads are limited to PDF/JPG/PNG (checked by
  file signature), 2.5 MB each, rate-limited, and only ever served back to the owner as downloads.
- Distance ranking uses ZIP-code centres from the US Census (`scripts/importZipCentroids.js`).

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
