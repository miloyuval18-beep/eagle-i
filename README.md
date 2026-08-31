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

## Notes

- `ANTHROPIC_API_KEY`, `SITE_USER`, `SITE_PASSWORD` must never be committed. `.env` is gitignored; only `.env.example` (no real values) is tracked.
- The Anthropic API key is billed per request. `/api/claude` is protected by a per-IP rate limit (30 requests/hour/visitor, see `RATE_LIMIT_MAX` in `server.js`) in addition to whatever site-wide password you set above.
