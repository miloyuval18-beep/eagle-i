// Pure-logic unit tests — no DB, no network, no external service. These run
// in well under a second and should never be skipped/flaky.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseClaudeJson } = require('../lib/anthropic');
const { getHighValueZipInfo, HOUSTON_HIGH_VALUE_ZIPS } = require('../lib/houstonZipValues');
const { escapeHtml } = require('../lib/landingPageTemplate');
const { readXlsxFirstSheet } = require('../lib/xlsxReader');
const { detectPermitSpikes } = require('../lib/houstonPermits');

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
