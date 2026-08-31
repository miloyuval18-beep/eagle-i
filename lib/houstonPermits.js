// Real, current Houston building-permit data — pulled directly from the
// weekly "Permit Activity Report" .xlsx files the Houston Permitting Center
// publishes at houstonpermittingcenter.org/sold-permits-search (a live,
// weekly-updated feed the Planning Department's own page stopped linking to
// in Dec 2025, but which the Permitting Center still hosts directly).
// Columns confirmed by actually downloading and parsing a real report:
// Zip Code | Permit Date | Permit Type | Project No | Address | Comments.
// No owner/applicant name field exists in this data — see the honesty note
// in routes/permits.js about why that's fine for direct mail specifically.
const { readXlsxFirstSheet } = require('./xlsxReader');

const REPORT_LIST_URL = 'https://www.houstonpermittingcenter.org/sold-permits-search';
const ZIP_RE = /^\d{5}$/;

let cache = { records: [], fetchedAt: null };
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours — these reports only update weekly

async function fetchReportFileUrls() {
  const r = await fetch(REPORT_LIST_URL);
  if (!r.ok) throw new Error(`Failed to load report list (${r.status})`);
  const html = await r.text();
  const urls = [];
  const linkRe = /href="([^"]*\.xlsx?[^"]*)"/g;
  let m;
  while ((m = linkRe.exec(html))) {
    let url = m[1].replace(/&amp;/g, '&');
    // Some older entries link through an Office Online viewer wrapper
    // instead of the file directly — unwrap it to the real source URL.
    if (url.includes('view.officeapps.live.com')) {
      const srcMatch = url.match(/[?&]src=([^&]+)/);
      if (srcMatch) url = decodeURIComponent(srcMatch[1]);
    }
    if (!urls.includes(url)) urls.push(url);
  }
  return urls; // page lists them oldest-to-newest
}

async function downloadAndParseReport(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download ${url} (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const rows = readXlsxFirstSheet(buf);
  return rows
    .filter(row => row[0] && ZIP_RE.test(String(row[0]).trim()))
    .map(row => ({
      zip: String(row[0]).trim(),
      permitDate: row[1] || null,
      permitType: row[2] || null,
      projectNo: row[3] || null,
      address: row[4] || null,
      comments: row[5] || null
    }));
}

// Fetches and parses the most recent `weeksBack` weekly reports, caching
// the combined result in-process since this is shared, city-wide data (not
// tenant-specific) and the source only updates weekly.
async function getRecentPermits({ weeksBack = 4, forceRefresh = false } = {}) {
  if (!forceRefresh && cache.fetchedAt && (Date.now() - cache.fetchedAt) < CACHE_MAX_AGE_MS) {
    return cache;
  }

  const allUrls = await fetchReportFileUrls();
  const recentUrls = allUrls.slice(-weeksBack);

  const results = await Promise.allSettled(recentUrls.map(downloadAndParseReport));
  const records = [];
  const failures = [];
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') records.push(...res.value);
    else failures.push({ url: recentUrls[i], error: res.reason.message });
  });

  cache = { records, fetchedAt: Date.now(), failures };
  return cache;
}

// ISO week key (Mon-Sun) for a permit's date, used to build a per-zip
// weekly time series purely from records already in hand — no separate
// history table needed, since getRecentPermits() already holds several
// weeks of individually-dated records.
function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - day);
  return monday.toISOString().slice(0, 10);
}

// Flags a zip as spiking when its most recent week's permit count is at
// least 40% above the average of the prior weeks (the spec's own
// threshold), with a minimum-volume floor so a zip going from 1 permit to
// 2 doesn't register as a "spike."
function detectPermitSpikes(records, { minRecentCount = 3, spikeRatio = 1.4 } = {}) {
  const byZipWeek = new Map(); // zip -> Map(weekKey -> count)
  for (const rec of records) {
    const week = isoWeekKey(rec.permitDate);
    if (!week || !rec.zip) continue;
    if (!byZipWeek.has(rec.zip)) byZipWeek.set(rec.zip, new Map());
    const weeks = byZipWeek.get(rec.zip);
    weeks.set(week, (weeks.get(week) || 0) + 1);
  }

  const spikes = [];
  for (const [zip, weeks] of byZipWeek.entries()) {
    const sortedWeeks = [...weeks.keys()].sort();
    if (sortedWeeks.length < 2) continue; // need at least one prior week to compare against
    const recentWeek = sortedWeeks[sortedWeeks.length - 1];
    const priorWeeks = sortedWeeks.slice(0, -1);
    const recentCount = weeks.get(recentWeek);
    const priorAvg = priorWeeks.reduce((sum, w) => sum + weeks.get(w), 0) / priorWeeks.length;
    if (recentCount < minRecentCount || priorAvg <= 0) continue;
    const ratio = recentCount / priorAvg;
    if (ratio >= spikeRatio) {
      spikes.push({
        zip,
        recentWeek,
        recentCount,
        priorAvgCount: Math.round(priorAvg * 10) / 10,
        percentAboveAverage: Math.round((ratio - 1) * 100)
      });
    }
  }
  return spikes.sort((a, b) => b.percentAboveAverage - a.percentAboveAverage);
}

module.exports = { getRecentPermits, detectPermitSpikes };
