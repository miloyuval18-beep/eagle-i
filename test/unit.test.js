// Pure-logic unit tests — no DB, no network, no external service. These run
// in well under a second and should never be skipped/flaky.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseClaudeJson } = require('../lib/anthropic');
const { getHighValueZipInfo, HOUSTON_HIGH_VALUE_ZIPS } = require('../lib/houstonZipValues');
const { escapeHtml } = require('../lib/landingPageTemplate');
const { readXlsxFirstSheet } = require('../lib/xlsxReader');
const { detectPermitSpikes } = require('../lib/houstonPermits');
const { buildRealAcctHeaderIndex, parseRealAcctLine, aggregateZipValues } = require('../lib/hcadZipValues');
const { budgetError } = require('../routes/ads');
const { parseImageDataUrl } = require('../routes/images');

describe('parseClaudeJson (lib/anthropic.js)', () => {
  test('parses well-formed JSON embedded in surrounding text', () => {
    const raw = 'Here is the result:\n{"a": 1, "b": "two"}\nHope that helps!';
    assert.deepEqual(parseClaudeJson(raw), { a: 1, b: 'two' });
  });

  test('repairs a single-quoted property name without touching string values', () => {
    // Reproduces the exact bug found in production: a single-quoted key
    // right after a string value containing an apostrophe.
    const raw = `{"headline":"You're Constantly...", 'p':"Clutter and mess"}`;
    const parsed = parseClaudeJson(raw);
    assert.equal(parsed.headline, "You're Constantly...");
    assert.equal(parsed.p, 'Clutter and mess');
  });

  test('does not mangle an apostrophe inside a string value', () => {
    const raw = `{"quote":"that's a strong signal","title":"Your Home's Layout No Longer Fits Your Life"}`;
    const parsed = parseClaudeJson(raw);
    assert.equal(parsed.quote, "that's a strong signal");
    assert.equal(parsed.title, "Your Home's Layout No Longer Fits Your Life");
  });

  test('throws a clear error when no JSON object is present', () => {
    assert.throws(() => parseClaudeJson('no json here at all'), /No JSON in Claude response/);
  });
});

describe('getHighValueZipInfo (lib/houstonZipValues.js)', () => {
  test('returns neighborhood info for a known high-value zip', () => {
    const known = HOUSTON_HIGH_VALUE_ZIPS[0];
    const info = getHighValueZipInfo(known.zip);
    assert.equal(info.neighborhood, known.neighborhood);
    assert.equal(info.approxMedianValue, known.approxMedianValue);
  });

  test('returns null for a zip not in the curated list', () => {
    assert.equal(getHighValueZipInfo('00000'), null);
  });
});

describe('escapeHtml (lib/landingPageTemplate.js)', () => {
  test('escapes all five HTML-significant characters', () => {
    assert.equal(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
  });

  test('leaves a plain string untouched', () => {
    assert.equal(escapeHtml('Acme Roofing Co.'), 'Acme Roofing Co.');
  });

  test('handles null/undefined without throwing', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('readXlsxFirstSheet (lib/xlsxReader.js)', () => {
  test('throws a clear error on a buffer that is not a zip at all', () => {
    assert.throws(() => readXlsxFirstSheet(Buffer.from('not a zip file')));
  });
});

describe('HCAD real_acct.txt parsing (lib/hcadZipValues.js)', () => {
  test('buildRealAcctHeaderIndex maps column names to positions', () => {
    const idx = buildRealAcctHeaderIndex('acct\tyr\tsite_addr_3\ttot_mkt_val');
    assert.equal(idx.acct, 0);
    assert.equal(idx.site_addr_3, 2);
    assert.equal(idx.tot_mkt_val, 3);
  });

  test('parseRealAcctLine extracts zip + market value from a real-shaped row', () => {
    const idx = { site_addr_3: 2, tot_mkt_val: 3 };
    const row = parseRealAcctLine(idx, 'X\tY\t77019\t450000');
    assert.deepEqual(row, { zip: '77019', marketValue: 450000 });
  });

  test('parseRealAcctLine trims a zip+4 down to 5 digits', () => {
    const idx = { site_addr_3: 0, tot_mkt_val: 1 };
    const row = parseRealAcctLine(idx, '77019-1234\t450000');
    assert.equal(row.zip, '77019');
  });

  test('parseRealAcctLine returns null for a blank/malformed row rather than throwing', () => {
    const idx = { site_addr_3: 0, tot_mkt_val: 1 };
    assert.equal(parseRealAcctLine(idx, ''), null);
    assert.equal(parseRealAcctLine(idx, '\t'), null);
    assert.equal(parseRealAcctLine(idx, 'notazip\t450000'), null);
    assert.equal(parseRealAcctLine(idx, '77019\t0'), null);
  });

  test('aggregateZipValues computes avg/median/count per zip', () => {
    const rows = [
      { zip: '77019', marketValue: 100 },
      { zip: '77019', marketValue: 200 },
      { zip: '77019', marketValue: 300 },
      { zip: '77002', marketValue: 50 }
    ];
    const stats = aggregateZipValues(rows);
    const z19 = stats.find(s => s.zip === '77019');
    assert.equal(z19.avgMarketValue, 200);
    assert.equal(z19.medianMarketValue, 200);
    assert.equal(z19.parcelCount, 3);
    const z02 = stats.find(s => s.zip === '77002');
    assert.equal(z02.avgMarketValue, 50);
    assert.equal(z02.parcelCount, 1);
  });

  test('aggregateZipValues sorts by parcel count descending', () => {
    const rows = [
      { zip: 'A', marketValue: 1 },
      { zip: 'B', marketValue: 1 }, { zip: 'B', marketValue: 1 }, { zip: 'B', marketValue: 1 }
    ];
    const stats = aggregateZipValues(rows);
    assert.equal(stats[0].zip, 'B');
    assert.equal(stats[1].zip, 'A');
  });
});

describe('budgetError (routes/ads.js)', () => {
  test('rejects non-positive or non-numeric budgets', () => {
    assert.match(budgetError(0), /positive number/);
    assert.match(budgetError(-500), /positive number/);
    assert.match(budgetError(NaN), /positive number/);
    assert.match(budgetError(undefined), /positive number/);
  });

  test('rejects a budget below the $1/day floor', () => {
    assert.match(budgetError(50), /at least \$1/);
  });

  test('rejects a budget above the $1,000/day safety ceiling', () => {
    assert.match(budgetError(100001), /safety ceiling/);
  });

  test('accepts a budget within range', () => {
    assert.equal(budgetError(5000), null);
    assert.equal(budgetError(100), null); // exactly at the $1/day floor
    assert.equal(budgetError(100000), null); // exactly at the $1,000/day ceiling
  });
});

describe('parseImageDataUrl (routes/images.js)', () => {
  const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  test('accepts a well-formed PNG data URL', () => {
    const result = parseImageDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
    assert.equal(result.ok, true);
    assert.equal(result.mimeType, 'image/png');
    assert.ok(Buffer.isBuffer(result.buf));
    assert.ok(result.buf.length > 0);
  });

  test('normalizes image/jpg to image/jpeg', () => {
    const result = parseImageDataUrl(`data:image/jpg;base64,${TINY_PNG_BASE64}`);
    assert.equal(result.ok, true);
    assert.equal(result.mimeType, 'image/jpeg');
  });

  test('rejects a non-data-URL string', () => {
    const result = parseImageDataUrl('https://example.com/image.png');
    assert.equal(result.ok, false);
  });

  test('rejects an unsupported image type', () => {
    const result = parseImageDataUrl(`data:image/gif;base64,${TINY_PNG_BASE64}`);
    assert.equal(result.ok, false);
  });

  test('rejects an oversized image', () => {
    const bigBase64 = Buffer.alloc(9 * 1024 * 1024).toString('base64'); // 9MB raw > 8MB cap
    const result = parseImageDataUrl(`data:image/png;base64,${bigBase64}`);
    assert.equal(result.ok, false);
    assert.match(result.error, /too large/);
  });
});

describe('detectPermitSpikes (lib/houstonPermits.js)', () => {
  test('flags a zip whose most recent week is 40%+ above its prior weekly average', () => {
    const records = [
      ...['2026-08-03', '2026-08-04'].map(d => ({ zip: '77001', permitDate: d })),
      ...['2026-08-10', '2026-08-11'].map(d => ({ zip: '77001', permitDate: d })),
      ...['2026-08-17', '2026-08-18'].map(d => ({ zip: '77001', permitDate: d })),
      ...['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'].map(d => ({ zip: '77001', permitDate: d }))
    ];
    const spikes = detectPermitSpikes(records);
    assert.equal(spikes.length, 1);
    assert.equal(spikes[0].zip, '77001');
    assert.equal(spikes[0].recentCount, 6);
    assert.equal(spikes[0].priorAvgCount, 2);
  });

  test('does not flag a flat, non-spiking zip', () => {
    const records = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'].map(d => ({ zip: '77002', permitDate: d }));
    assert.deepEqual(detectPermitSpikes(records), []);
  });

  test('ignores a zip with only one week of data (nothing to compare against)', () => {
    const records = [{ zip: '77003', permitDate: '2026-08-24' }, { zip: '77003', permitDate: '2026-08-25' }];
    assert.deepEqual(detectPermitSpikes(records), []);
  });

  test('ignores tiny-volume "spikes" below the minimum-count floor', () => {
    // Prior week: 1 permit. Recent week: 2 permits — a 100% increase by
    // ratio (well above the 40% threshold), but recentCount (2) is still
    // below the default floor of 3, so this should NOT register as a spike.
    const records = [
      { zip: '77004', permitDate: '2026-08-03' }, // week 1: 1 permit
      { zip: '77004', permitDate: '2026-08-10' }, // week 2 (recent): 2 permits
      { zip: '77004', permitDate: '2026-08-11' }
    ];
    assert.deepEqual(detectPermitSpikes(records, { minRecentCount: 3 }), []);
  });
});
