// Pure-logic unit tests — no DB, no network, no external service. These run
// in well under a second and should never be skipped/flaky.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseClaudeJson } = require('../lib/anthropic');
const { getHighValueZipInfo, HOUSTON_HIGH_VALUE_ZIPS } = require('../lib/houstonZipValues');
const { escapeHtml } = require('../lib/landingPageTemplate');
const { readXlsxFirstSheet } = require('../lib/xlsxReader');
const { detectPermitSpikes, mostRecentWeekKey, isNewestWeek } = require('../lib/houstonPermits');
const { buildRealAcctHeaderIndex, parseRealAcctLine, parseRealAcctOwnerLine, aggregateZipValues } = require('../lib/hcadZipValues');
const { looksLikeBusinessOrPlaceholder, parseOwnerPersonName, normalizeAddress } = require('../lib/hcadOwnerNames');
const { budgetError } = require('../routes/ads');
const { parseImageDataUrl } = require('../routes/images');
const { isPrivateOrReservedIp, extractEmails, findContactPageUrl } = require('../lib/vendorContactFinder');
const { buildReplyToAddress } = require('../lib/email');
const { REPLY_ADDRESS_RE } = require('../routes/inboundEmail');
const { detectsHighValueFocus, topHighValueNeighborhoods, addressInHighValueZip } = require('../lib/vendorTargeting');
const { getZipRegion, HOUSTON_ZIP_REGIONS } = require('../lib/houstonZipRegions');
const { describeWorkType, humanizeComments, buildPermitLetter } = require('../lib/permitMailer');
const { qualifiesForPermits } = require('../lib/realEstateAccess');

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

describe('mostRecentWeekKey (lib/houstonPermits.js)', () => {
  test('returns the Monday of the latest week present in the records', () => {
    const records = [
      { permitDate: '2026-08-03' }, // week of 2026-08-03 (Mon)
      { permitDate: '2026-08-17' }, // week of 2026-08-17 (Mon) — latest
      { permitDate: '2026-08-10' }
    ];
    assert.equal(mostRecentWeekKey(records), '2026-08-17');
  });

  test('ignores records with a missing/unparseable date', () => {
    const records = [{ permitDate: '2026-08-03' }, { permitDate: null }, { permitDate: 'not a date' }];
    assert.equal(mostRecentWeekKey(records), '2026-08-03');
  });

  test('returns null for an empty list or one with no usable dates', () => {
    assert.equal(mostRecentWeekKey([]), null);
    assert.equal(mostRecentWeekKey([{ permitDate: null }]), null);
  });
});

describe('isNewestWeek (lib/houstonPermits.js)', () => {
  // Deliberately NOT tied to the real current date — this is the whole
  // point of the redesign (see lib/houstonPermits.js's comment):
  // Houston Permitting Center's own publish lag means "the real current
  // calendar week" essentially never has data yet, so "new" means "in the
  // most recent week the data itself actually has" instead.
  const records = [
    { permitDate: '2026-08-03' },
    { permitDate: '2026-08-17' }, // latest week: 2026-08-17
    { permitDate: '2026-08-19' }
  ];

  test('true for a date in the most recent week present in the records', () => {
    assert.equal(isNewestWeek('2026-08-17', records), true);
    assert.equal(isNewestWeek('2026-08-19', records), true); // same week as the Monday above
  });

  test('false for a date in an older week', () => {
    assert.equal(isNewestWeek('2026-08-03', records), false);
  });

  test('false when the records list has no usable latest week', () => {
    assert.equal(isNewestWeek('2026-08-17', []), false);
  });

  test('accepts a precomputed latestWeekKey instead of the full records array, for reuse across many permits', () => {
    const latest = mostRecentWeekKey(records);
    assert.equal(isNewestWeek('2026-08-19', latest), true);
    assert.equal(isNewestWeek('2026-08-03', latest), false);
  });

  test('false for a missing/unparseable date', () => {
    assert.equal(isNewestWeek(null, records), false);
    assert.equal(isNewestWeek('not a date', records), false);
  });
});

describe('isPrivateOrReservedIp (lib/vendorContactFinder.js — SSRF guard)', () => {
  test('blocks loopback, private ranges, link-local/cloud-metadata, and CGNAT', () => {
    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('10.0.0.5'), true);
    assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
    assert.equal(isPrivateOrReservedIp('172.31.255.255'), true);
    assert.equal(isPrivateOrReservedIp('192.168.1.1'), true);
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true); // cloud metadata endpoint
    assert.equal(isPrivateOrReservedIp('100.64.0.1'), true); // CGNAT
    assert.equal(isPrivateOrReservedIp('0.0.0.0'), true);
  });

  test('allows ordinary public IPv4 addresses', () => {
    assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
    assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
    // A 172.x address just outside the 172.16.0.0/12 private block.
    assert.equal(isPrivateOrReservedIp('172.32.0.1'), false);
  });

  test('blocks IPv6 loopback, link-local, unique-local, and mapped-IPv4-private', () => {
    assert.equal(isPrivateOrReservedIp('::1'), true);
    assert.equal(isPrivateOrReservedIp('fe80::1'), true);
    assert.equal(isPrivateOrReservedIp('fd00::1'), true);
    assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  });

  test('fails closed on a non-IP string', () => {
    assert.equal(isPrivateOrReservedIp('not-an-ip'), true);
  });
});

describe('extractEmails (lib/vendorContactFinder.js)', () => {
  test('prefers a mailto: link over plain-text email matches', () => {
    const html = '<a href="mailto:info@example-vendor.com">Email us</a><p>fallback@other.com</p>';
    assert.deepEqual(extractEmails(html), ['info@example-vendor.com']);
  });

  test('falls back to a plain-text email when no mailto: link exists', () => {
    const html = '<p>Reach us at contact@example-vendor.com any time.</p>';
    assert.deepEqual(extractEmails(html), ['contact@example-vendor.com']);
  });

  test('filters out image-filename false positives and known junk/tracking domains', () => {
    const html = `
      <img src="team@2x.png">
      <script>ga('set', 'x', 'abc@wixpress.com')</script>
      <a href="mailto:noreply@example-vendor.com">no-reply</a>
      <p>real-contact@example-vendor.com</p>`;
    assert.deepEqual(extractEmails(html), ['real-contact@example-vendor.com']);
  });

  test('returns an empty array when nothing looks like a real email', () => {
    assert.deepEqual(extractEmails('<p>No contact info here.</p>'), []);
  });
});

describe('findContactPageUrl (lib/vendorContactFinder.js)', () => {
  test('finds a link whose text says "Contact" and resolves it against the base URL', () => {
    const html = '<nav><a href="/about">About</a><a href="/contact-us">Contact Us</a></nav>';
    assert.equal(findContactPageUrl(html, 'https://example-vendor.com/'), 'https://example-vendor.com/contact-us');
  });

  test('returns null when no contact-ish link exists', () => {
    const html = '<nav><a href="/about">About</a><a href="/services">Services</a></nav>';
    assert.equal(findContactPageUrl(html, 'https://example-vendor.com/'), null);
  });
});

describe('buildReplyToAddress (lib/email.js)', () => {
  test('returns null when RESEND_INBOUND_DOMAIN is not set', () => {
    const saved = process.env.RESEND_INBOUND_DOMAIN;
    delete process.env.RESEND_INBOUND_DOMAIN;
    try {
      assert.equal(buildReplyToAddress('vendor', 'abc-123'), null);
    } finally {
      if (saved !== undefined) process.env.RESEND_INBOUND_DOMAIN = saved;
    }
  });

  test('builds a reply+<kind>-<id>@<domain> address when configured', () => {
    const saved = process.env.RESEND_INBOUND_DOMAIN;
    process.env.RESEND_INBOUND_DOMAIN = 'xyz.resend.app';
    try {
      const id = '11111111-1111-1111-1111-111111111111';
      assert.equal(buildReplyToAddress('vendor', id), `reply+vendor-${id}@xyz.resend.app`);
      assert.equal(buildReplyToAddress('review', id), `reply+review-${id}@xyz.resend.app`);
    } finally {
      if (saved === undefined) delete process.env.RESEND_INBOUND_DOMAIN;
      else process.env.RESEND_INBOUND_DOMAIN = saved;
    }
  });

  test('rejects an unknown kind rather than silently building a bad address', () => {
    process.env.RESEND_INBOUND_DOMAIN = 'xyz.resend.app';
    try {
      assert.throws(() => buildReplyToAddress('bogus', 'abc-123'));
    } finally {
      delete process.env.RESEND_INBOUND_DOMAIN;
    }
  });
});

describe('REPLY_ADDRESS_RE (routes/inboundEmail.js)', () => {
  test('matches a well-formed reply+<kind>-<uuid>@ address and captures kind + id', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const m = REPLY_ADDRESS_RE.exec(`reply+vendor-${id}@abc123.resend.app`);
    assert.ok(m);
    assert.equal(m[1], 'vendor');
    assert.equal(m[2], id);
  });

  test('rejects addresses that are not our reply+ token shape', () => {
    assert.equal(REPLY_ADDRESS_RE.exec('someone@example.com'), null);
    assert.equal(REPLY_ADDRESS_RE.exec('reply+unknown-550e8400-e29b-41d4-a716-446655440000@abc.resend.app'), null);
    assert.equal(REPLY_ADDRESS_RE.exec('reply+vendor-not-a-uuid@abc.resend.app'), null);
  });
});

describe('detectsHighValueFocus (lib/vendorTargeting.js)', () => {
  test('detects an explicit luxury-market bio, matching the Levi Homes example', () => {
    assert.equal(detectsHighValueFocus('We build luxury custom homes for discerning clients.', ''), true);
  });

  test('detects across multiple text fields (services + differentiators) combined', () => {
    assert.equal(detectsHighValueFocus('General contracting', 'We specialize in high-end estate renovations'), true);
  });

  test('is case-insensitive', () => {
    assert.equal(detectsHighValueFocus('LUXURY home builder', ''), true);
  });

  test('returns false for an ordinary bio with no high-value language', () => {
    assert.equal(detectsHighValueFocus('We repair roofs and gutters for local homeowners.', 'Fast, honest, affordable.'), false);
  });

  test('handles null/undefined/empty fields without throwing', () => {
    assert.equal(detectsHighValueFocus(null, undefined, ''), false);
  });
});

describe('topHighValueNeighborhoods (lib/vendorTargeting.js)', () => {
  test('returns the requested count, highest approxMedianValue first', () => {
    const top3 = topHighValueNeighborhoods(3);
    assert.equal(top3.length, 3);
    assert.equal(top3[0], 'River Oaks'); // highest approxMedianValue in the curated list
  });

  test('defaults to 5 when no count is given', () => {
    assert.equal(topHighValueNeighborhoods().length, 5);
  });
});

describe('addressInHighValueZip (lib/vendorTargeting.js)', () => {
  test('matches a real Places-shaped address in a known high-value zip', () => {
    assert.equal(addressInHighValueZip('2100 River Oaks Blvd, Houston, TX 77019, USA'), true);
  });

  test('does not match an address in an untracked zip', () => {
    assert.equal(addressInHighValueZip('123 Main St, Houston, TX 77002, USA'), false);
  });

  test('does not mistake a street number for a zip code', () => {
    // 77019 appears as a street number here, not after a state code — must not match.
    assert.equal(addressInHighValueZip('77019 Nowhere Rd, Beaumont, TX 77701, USA'), false);
  });

  test('handles a missing/empty address without throwing', () => {
    assert.equal(addressInHighValueZip(null), false);
    assert.equal(addressInHighValueZip(''), false);
  });
});

describe('qualifiesForPermits (lib/realEstateAccess.js)', () => {
  test('qualifies by industry alone, regardless of company name', () => {
    assert.equal(qualifiesForPermits({ industry: 'home_services', companyName: 'Anything Inc' }), true);
    assert.equal(qualifiesForPermits({ industry: 'real_estate', companyName: 'Anything Inc' }), true);
  });

  test('qualifies a construction-named company under a non-real-estate industry', () => {
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: 'ABC Construction LLC' }), true);
    assert.equal(qualifiesForPermits({ industry: 'professional_services', companyName: 'Smith General Contracting' }), true);
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: 'Gulf Coast Roofing' }), true);
    assert.equal(qualifiesForPermits({ industry: 'retail', companyName: 'Houston Remodelers' }), true);
  });

  test('is case-insensitive', () => {
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: 'lone star CONSTRUCTION co' }), true);
  });

  test('does not qualify an unrelated business under a non-real-estate industry', () => {
    assert.equal(qualifiesForPermits({ industry: 'retail', companyName: 'Downtown Coffee Shop' }), false);
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: 'Acme Consulting' }), false);
  });

  test('handles missing fields without throwing', () => {
    assert.equal(qualifiesForPermits({}), false);
    assert.equal(qualifiesForPermits(), false);
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: null }), false);
  });
});

describe('getZipRegion (lib/houstonZipRegions.js)', () => {
  test('returns a named region for a known Houston zip', () => {
    assert.equal(getZipRegion('77019'), 'River Oaks');
  });

  test('matches the curated high-value neighborhood name where both files cover the same zip', () => {
    // These two reference lists are maintained separately (this one is far
    // broader) but must never show two different names for the same zip.
    for (const { zip, neighborhood } of HOUSTON_HIGH_VALUE_ZIPS) {
      assert.equal(getZipRegion(zip), neighborhood, `region for ${zip} should match houstonZipValues.js`);
    }
  });

  test('returns null for a zip with no entry', () => {
    assert.equal(getZipRegion('00000'), null);
  });

  test('every mapped zip is a real 5-digit zip code string', () => {
    for (const zip of Object.keys(HOUSTON_ZIP_REGIONS)) {
      assert.match(zip, /^\d{5}$/);
    }
  });
});

describe('describeWorkType (lib/permitMailer.js)', () => {
  test('recognizes a roof permit', () => {
    assert.equal(describeWorkType('Roof Replacement').label, 'the roof work');
  });

  test('recognizes a pool permit', () => {
    assert.equal(describeWorkType('Residential Pool/Spa').label, 'the pool or spa project');
  });

  test('falls back honestly for an unrecognized permit type', () => {
    const d = describeWorkType('Some Unusual Permit Category');
    assert.equal(d.label, 'the recent work at your property');
  });

  test('handles a missing permit type without throwing', () => {
    assert.equal(describeWorkType(null).label, 'the recent work at your property');
    assert.equal(describeWorkType(undefined).label, 'the recent work at your property');
  });
});

describe('humanizeComments (lib/permitMailer.js)', () => {
  test('strips building-code citations and classification codes into a clean phrase', () => {
    assert.equal(humanizeComments('PARKING GARAGE REMODEL 1-14-1-S2-A 2021 IBC'), 'parking garage remodel');
  });

  test('strips sprinkler/fire-alarm shorthand, M# references, and IRC/IECC citations', () => {
    const out = humanizeComments("DUPLEX RES.W/ATT. GARAGE (1-2-5-R3-B) 21 IRC/21 IECC (M#26027119)");
    assert.ok(out && !/\d/.test(out), 'should have no leftover digits: ' + out);
    assert.match(out, /residential/);
    assert.match(out, /attached/);
  });

  test('strips a leading PPR report-type prefix and expands common abbreviations', () => {
    const out = humanizeComments('PPR RESIDENTIAL DETACHED GARAGE WITH LIVING SPACE ABOVE ADDITION');
    assert.doesNotMatch(out, /^ppr/i);
    assert.match(out, /residential detached garage/);
  });

  test('returns null for empty/missing comments', () => {
    assert.equal(humanizeComments(''), null);
    assert.equal(humanizeComments(null), null);
    assert.equal(humanizeComments(undefined), null);
  });

  test('returns null rather than a garbled fragment for comments that are mostly codes', () => {
    assert.equal(humanizeComments('1-1-1-A5-B 2021 IBC (M#12345)'), null);
  });

  test('never leaves a stray digit in the returned phrase', () => {
    const out = humanizeComments('896 SF CVT SINGLE FAMILY RESIDENCE TO RETAIL 1-1-5-M-B \'21 IBC');
    assert.ok(out === null || !/\d/.test(out));
  });
});

describe('looksLikeBusinessOrPlaceholder (lib/hcadOwnerNames.js)', () => {
  test('flags HCAD\'s "CURRENT OWNER" placeholder', () => {
    assert.equal(looksLikeBusinessOrPlaceholder('CURRENT OWNER'), true);
  });

  test('flags an empty/missing name', () => {
    assert.equal(looksLikeBusinessOrPlaceholder(''), true);
    assert.equal(looksLikeBusinessOrPlaceholder(null), true);
  });

  test('flags real-world business/trust/government owner names', () => {
    ['CITY OF HOUSTON', 'MICHAEL RYAN FEAGIN TRUST', 'MILBY CHARLES FAMILY PTNSH',
      'B & W C1 LLC', 'DKGA / WUC LP', 'PORT OF HOUSTON AUTHORITY',
      'HARRIS COUNTY FLOOD CONTROL DISTRICT', 'JEHOVAHS WITNESS BELLAIRE CONGREGATION',
      'PROSPERITY BANK % PROSPERITY BANK'
    ].forEach(name => assert.equal(looksLikeBusinessOrPlaceholder(name), true, name));
  });

  test('does not flag a plain individual name', () => {
    assert.equal(looksLikeBusinessOrPlaceholder('STEPHENSON MELINDA'), false);
    assert.equal(looksLikeBusinessOrPlaceholder('BRANDT SCOTT M'), false);
  });
});

describe('parseOwnerPersonName (lib/hcadOwnerNames.js)', () => {
  test('parses a simple two-token individual name', () => {
    assert.deepEqual(parseOwnerPersonName('STEPHENSON MELINDA'), { firstName: 'Melinda', lastName: 'Stephenson' });
  });

  test('parses a three-token name with a middle initial', () => {
    assert.deepEqual(parseOwnerPersonName('BRANDT SCOTT M'), { firstName: 'Scott', lastName: 'Brandt' });
  });

  test('parses only the first-listed owner out of a joint-owner name', () => {
    assert.deepEqual(parseOwnerPersonName('MILSTEIN JEFFREY J & LAUREN K'), { firstName: 'Jeffrey', lastName: 'Milstein' });
    assert.deepEqual(parseOwnerPersonName('FREDERICK KEVIN & DANIELLE'), { firstName: 'Kevin', lastName: 'Frederick' });
  });

  test('returns null for a business/trust/government/placeholder name', () => {
    assert.equal(parseOwnerPersonName('CURRENT OWNER'), null);
    assert.equal(parseOwnerPersonName('MICHAEL RYAN FEAGIN TRUST'), null);
    assert.equal(parseOwnerPersonName('CITY OF HOUSTON'), null);
  });

  test('returns null for a 4-token name that dodges the keyword list (token-shape safety net)', () => {
    // A real HCAD example: no BUSINESS_KEYWORDS hit, but 4 tokens is not a
    // "LAST FIRST [MI]" shape — must not be treated as a confident person.
    assert.equal(parseOwnerPersonName('HOME SAVING OF AMERICA'), null);
  });

  test('returns null for a single-token or empty name', () => {
    assert.equal(parseOwnerPersonName('MADONNA'), null);
    assert.equal(parseOwnerPersonName(''), null);
    assert.equal(parseOwnerPersonName(null), null);
  });
});

describe('normalizeAddress (lib/hcadOwnerNames.js)', () => {
  test('uppercases, strips periods/commas, and collapses whitespace', () => {
    assert.equal(normalizeAddress('123  Main   St.'), '123 MAIN ST');
  });

  test('handles a missing address without throwing', () => {
    assert.equal(normalizeAddress(null), '');
    assert.equal(normalizeAddress(undefined), '');
  });
});

describe('parseRealAcctOwnerLine (lib/hcadZipValues.js)', () => {
  const header = 'acct\tmailto\tsite_addr_1\tsite_addr_3\ttot_mkt_val';
  const headerIndex = buildRealAcctHeaderIndex(header);

  test('extracts a confident owner row for a real-shaped individual-owner line', () => {
    const line = '0011870000002\tSTEPHENSON MELINDA\t4815 PALMETTO ST\t77401\t500000';
    const row = parseRealAcctOwnerLine(headerIndex, line);
    assert.deepEqual(row, {
      zip: '77401',
      rawSiteAddress: '4815 PALMETTO ST',
      normalizedAddress: '4815 PALMETTO ST',
      ownerFirstName: 'Melinda',
      ownerLastName: 'Stephenson'
    });
  });

  test('returns null for a business-owned parcel', () => {
    const line = '0011870000002\tCITY OF HOUSTON\t0 FRANKLIN\t77002\t319200';
    assert.equal(parseRealAcctOwnerLine(headerIndex, line), null);
  });

  test('returns null for a missing zip or address', () => {
    assert.equal(parseRealAcctOwnerLine(headerIndex, '0011870000002\tSTEPHENSON MELINDA\t\t77401\t500000'), null);
    assert.equal(parseRealAcctOwnerLine(headerIndex, '0011870000002\tSTEPHENSON MELINDA\t4815 PALMETTO ST\t\t500000'), null);
  });
});

describe('buildPermitLetter (lib/permitMailer.js)', () => {
  const tenant = { name: 'Levi Homes', founder: 'Alex Levi', phone: '(713) 555-0100', email: 'alex@levihomes.com', services: 'custom home building and remodeling', unique: 'We handle every project personally.' };

  test('includes the real permit address as the recipient address', () => {
    const letter = buildPermitLetter({
      permit: { address: '123 Main St', permitType: 'Roof', permitDate: '2026-08-01', projectNo: 'P-1' },
      area: { zip: '77019', region: 'River Oaks' },
      tenant
    });
    assert.equal(letter.recipientAddress, '123 Main St');
    assert.equal(letter.zip, '77019');
  });

  test('addresses "Property Owner" and uses a generic greeting when no owner is resolved', () => {
    const letter = buildPermitLetter({
      permit: { address: '456 Oak Dr', permitType: 'Remodel', permitDate: '2026-08-05', projectNo: 'P-2' },
      area: { zip: '77024', region: 'Memorial / Tanglewood' },
      tenant
    });
    assert.equal(letter.recipientName, 'Property Owner');
    assert.equal(letter.greeting, 'Dear Property Owner,');
  });

  test('addresses a real name and uses a first-name greeting only when an owner is passed in', () => {
    const letter = buildPermitLetter({
      permit: { address: '456 Oak Dr', permitType: 'Remodel', permitDate: '2026-08-05', projectNo: 'P-2' },
      area: { zip: '77024', region: 'Memorial / Tanglewood' },
      tenant,
      owner: { firstName: 'Jeffrey', lastName: 'Milstein' }
    });
    assert.equal(letter.recipientName, 'Jeffrey Milstein');
    assert.equal(letter.greeting, 'Dear Jeffrey,');
  });

  test('mentions the tenant\'s own contact info and company name, not a placeholder', () => {
    const letter = buildPermitLetter({
      permit: { address: '456 Oak Dr', permitType: 'Remodel', permitDate: '2026-08-05', projectNo: 'P-2' },
      area: { zip: '77024', region: 'Memorial / Tanglewood' },
      tenant
    });
    const full = letter.bodyParagraphs.join(' ');
    assert.match(full, /\(713\) 555-0100/);
    assert.match(full, /Levi Homes/);
    assert.deepEqual(letter.signatureLines, ['Alex Levi', 'Levi Homes', '(713) 555-0100 · alex@levihomes.com']);
  });

  test('uses the permit\'s own comments for specificity when they clean up well', () => {
    const letter = buildPermitLetter({
      permit: { address: '1600 Smith St', permitType: 'Building Pmt', permitDate: '2026-08-05', projectNo: 'P-3', comments: 'PARKING GARAGE REMODEL 1-14-1-S2-A 2021 IBC' },
      area: { zip: '77002', region: 'Downtown' },
      tenant
    });
    assert.equal(letter.workLabel, 'the parking garage remodel');
    assert.match(letter.bodyParagraphs[0], /parking garage remodel/);
  });

  test('falls back to a generic-but-honest work label when comments don\'t clean up', () => {
    const letter = buildPermitLetter({
      permit: { address: '1600 Smith St', permitType: 'Some Unusual Type', permitDate: '2026-08-05', projectNo: 'P-4', comments: '1-1-1-A5-B 2021 IBC' },
      area: { zip: '77002', region: 'Downtown' },
      tenant
    });
    assert.equal(letter.workLabel, 'the recent work at your property');
  });

  test('two different permits of the same type produce different letter text (not copy-pasted)', () => {
    const a = buildPermitLetter({
      permit: { address: '1 First St', permitType: 'Roof', permitDate: '2026-08-01', projectNo: 'P-A' },
      area: { zip: '77019', region: 'River Oaks' },
      tenant
    });
    const b = buildPermitLetter({
      permit: { address: '2 Second St', permitType: 'Roof', permitDate: '2026-08-02', projectNo: 'P-B' },
      area: { zip: '77019', region: 'River Oaks' },
      tenant
    });
    assert.notEqual(a.bodyParagraphs.join(' '), b.bodyParagraphs.join(' '));
  });

  test('the same permit always produces the same letter text (stable, not random)', () => {
    const permit = { address: '9 Ninth St', permitType: 'Fence', permitDate: '2026-08-09', projectNo: 'P-9' };
    const area = { zip: '77005', region: 'West University Place' };
    const first = buildPermitLetter({ permit, area, tenant });
    const second = buildPermitLetter({ permit, area, tenant });
    assert.deepEqual(first.bodyParagraphs, second.bodyParagraphs);
  });

  test('handles a missing tenant profile without throwing', () => {
    const letter = buildPermitLetter({
      permit: { address: '10 Tenth St', permitType: 'Roof', permitDate: '2026-08-10', projectNo: 'P-10' },
      area: { zip: '77019', region: 'River Oaks' },
      tenant: {}
    });
    assert.match(letter.bodyParagraphs.join(' '), /the number below/);
  });
});

describe('CRM core (lib/crm.js)', () => {
  const crm = require('../lib/crm');
  test('phoneDigits matches the same number typed different ways', () => {
    assert.equal(crm.phoneDigits('(713) 555-0100'), '7135550100');
    assert.equal(crm.phoneDigits('+1 713.555.0100'), '7135550100');
    assert.equal(crm.phoneDigits('12'), null);
    assert.equal(crm.phoneDigits(null), null);
  });
  test('extractZip reads a ZIP field or the end of an address', () => {
    assert.equal(crm.extractZip('77077', null), '77077');
    assert.equal(crm.extractZip('', '123 Main St, Houston, TX 77024'), '77024');
    assert.equal(crm.extractZip(null, '123 Main St, Houston, TX 77024-1234'), '77024');
    assert.equal(crm.extractZip(null, '123 Main St'), null);
  });
  test('parseValue accepts the ways people write money and rejects nonsense', () => {
    assert.equal(crm.parseValue('85,000'), 85000);
    assert.equal(crm.parseValue('$85k'), 85000);
    assert.equal(crm.parseValue('1.2m'), 1200000);
    assert.equal(crm.parseValue(42000), 42000);
    assert.equal(crm.parseValue(''), null);
    assert.equal(crm.parseValue('about 50'), null);
    assert.equal(crm.parseValue(-5), null);
  });
  test('lead status and stage map both ways', () => {
    assert.equal(crm.stageForLeadStatus('won'), 'signed');
    assert.equal(crm.stageForLeadStatus('contacted'), 'qualified');
    assert.equal(crm.leadStatusForStage('proposal'), 'contacted');
    assert.equal(crm.leadStatusForStage('production'), 'won');
    assert.equal(crm.leadStatusForStage('lost'), 'lost');
    assert.equal(crm.leadStatusForStage('new'), 'new');
  });
  test('settings fall back to safe defaults', () => {
    assert.deepEqual(crm.normalizeSettings(null), { paused: false, weeklySummary: true, waitingMinutes: 30, leadOwnerUserId: null, stageLabels: {}, hiddenStages: [], scheduleTemplate: null, minJobValue: null, booking: null, referralReward: null, reviewUrl: null, warrantyMonths: null, monthlyCapacity: null, backlogLowWeeks: null, backlogHighWeeks: null, backfilledAt: null });
    assert.equal(crm.normalizeSettings({ waitingMinutes: 7 }).waitingMinutes, 30);
    assert.equal(crm.normalizeSettings({ waitingMinutes: '60' }).waitingMinutes, 60);
  });
  test('median handles odd, even and empty lists', () => {
    assert.equal(crm.median([5, 1, 3]), 3);
    assert.equal(crm.median([1, 2, 3, 4]), 2.5);
    assert.equal(crm.median([]), null);
  });
  test('weekBounds reports on the Monday-to-Monday week just ended, in Central time', () => {
    // Monday Oct 19 2026, 9am Central = 14:00 UTC (CDT).
    const b = crm.weekBounds(new Date('2026-10-19T14:00:00Z'));
    assert.equal(b.dayOfWeek, 0);
    assert.equal(b.hour, 9);
    assert.equal(b.weekStartKey, '2026-10-12');
    assert.equal(b.start.toISOString(), '2026-10-12T05:00:00.000Z');
    assert.equal(b.end.toISOString(), '2026-10-19T05:00:00.000Z');
    // Sunday night still belongs to the week before.
    assert.equal(crm.weekBounds(new Date('2026-10-19T03:00:00Z')).weekStartKey, '2026-10-05');
  });
  test('defaultTitle names the project from the message when it can', () => {
    assert.equal(crm.defaultTitle('maria garcia', 'Looking to redo our kitchen'), 'maria — kitchen');
    assert.equal(crm.defaultTitle('Sam', ''), 'Sam — project');
  });
  test('weekly summary email escapes the company name', () => {
    const { html, subject } = crm.renderWeeklySummaryEmail({ companyName: '<b>Acme</b>', weekLabel: 'week of Oct 12', s: { newLeads: 1, respondedCount: 1, medianResponseMinutes: 12, automatedEmails: 3, replies: 1, stageMoves: 2, signedCount: 0, signedValue: 0, openPipelineValue: 150000, needsYou: 0 } });
    assert.ok(!html.includes('<b>Acme</b>'));
    assert.ok(html.includes('&lt;b&gt;Acme'));
    assert.ok(html.includes('$150,000'));
    assert.match(subject, /1 new lead, 3 automatic emails/);
  });
});

describe('CRM playbooks (lib/crmPlaybooks.js)', () => {
  const pb = require('../lib/crmPlaybooks');
  test('every starter playbook is valid and tied to a real stage', () => {
    const { isStage } = require('../lib/crm');
    for (const p of pb.DEFAULT_PLAYBOOKS) {
      assert.equal(pb.validateSteps(p.steps, p.trigger), null, p.key);
      if (p.trigger === 'stage') assert.ok(isStage(p.stage), p.key);
      else assert.equal(p.stage, null, p.key);
    }
  });
  test('any change to the wording changes the approval fingerprint', () => {
    const steps = [{ days: 3, subject: 'Hi', message: 'Hello {name}' }];
    const h = pb.playbookHash('proposal', steps);
    assert.equal(h, pb.playbookHash('proposal', [{ days: '3', subject: ' Hi ', message: 'Hello {name}\n' }]));
    assert.notEqual(h, pb.playbookHash('proposal', [{ days: 3, subject: 'Hi', message: 'Hello {name}!' }]));
    assert.notEqual(h, pb.playbookHash('proposal', [{ days: 4, subject: 'Hi', message: 'Hello {name}' }]));
    assert.notEqual(h, pb.playbookHash('lost', steps));
  });
  test('isApproved only when the approved fingerprint matches the current wording', () => {
    const steps = [{ days: 0, subject: 'Hi', message: 'Hello' }];
    const row = { stage: 'signed', steps, approved_hash: pb.playbookHash('signed', steps) };
    assert.equal(pb.isApproved(row), true);
    assert.equal(pb.isApproved({ ...row, steps: [{ days: 0, subject: 'Hi', message: 'Hello again' }] }), false);
    assert.equal(pb.isApproved({ ...row, approved_hash: null }), false);
  });
  test('validateSteps rejects unsafe or out-of-order playbooks', () => {
    assert.match(pb.validateSteps([]), /1 to 3/);
    assert.match(pb.validateSteps([{ days: 3, subject: 'a', message: 'b' }, { days: 2, subject: 'a', message: 'b' }]), /after the previous/);
    assert.match(pb.validateSteps([{ days: 400, subject: 'a', message: 'b' }]), /0 to 365/);
    assert.match(pb.validateSteps([{ days: 1, subject: 'a', message: 'Hi {address}' }]), /\{address\}/);
    assert.match(pb.validateSteps([{ days: 1, subject: '', message: 'b' }]), /subject/);
    assert.equal(pb.validateSteps([{ days: 0, subject: 'a', message: 'Hi {name} from {company}' }]), null);
  });
  test('renderStep fills tokens and the first name', () => {
    const ctx = { companyName: 'Levi Homes', profile: { phone: '713-555-0100', email: 'hi@levi.test', founder_name: 'Levi' } };
    const out = pb.renderStep({ subject: 'Welcome to {company}', message: 'Hi {name}, call {phone}.' }, { ctx, contactName: 'maria garcia' });
    assert.equal(out.subject, 'Welcome to Levi Homes');
    assert.equal(out.message, 'Hi Maria, call 713-555-0100.');
  });
  test('the reply address accepts the crm kind', () => {
    process.env.RESEND_INBOUND_DOMAIN = 'in.example.test';
    const addr = buildReplyToAddress('crm', '123e4567-e89b-12d3-a456-426614174000');
    delete process.env.RESEND_INBOUND_DOMAIN;
    const m = REPLY_ADDRESS_RE.exec(addr);
    assert.equal(m[1], 'crm');
  });
});

describe('CRM estimates (lib/crmEstimates.js)', () => {
  const est = require('../lib/crmEstimates');
  test('line price is quantity × cost × (1 + markup), in cents', () => {
    assert.equal(est.linePrice({ quantity: 3, unit_cost: 10.1, markup_pct: 20 }), 36.36);
    assert.equal(est.linePrice({ quantity: 0.5, unit_cost: '1,000', markup_pct: 0 }), 500);
    assert.equal(est.linePrice({ quantity: 'x', unit_cost: 50, markup_pct: 10 }), 0);
  });
  test('totals are worked out from cleaned lines; blank lines are dropped; blank markup uses the default', () => {
    const c = est.computeEstimate({
      lines: [
        { description: 'Demo', quantity: 1, unit: 'ls', unit_cost: 1000, markup_pct: '' },
        { description: '   ', quantity: 5, unit_cost: 99 },
        { description: 'Tile', quantity: 100, unit: 'sf', unit_cost: 8.5, markup_pct: 30 },
        { description: 'Bad unit', quantity: 2, unit: 'gallons<script>', unit_cost: 10, markup_pct: 0 }
      ],
      default_markup_pct: 25, tax_pct: 8.25, deposit_pct: 10
    });
    assert.equal(c.lines.length, 3);
    assert.deepEqual(c.lines.map(l => l.position), [0, 1, 2]);
    assert.equal(c.lines[0].markup_pct, 25);
    assert.equal(c.lines[0].price, 1250);
    assert.equal(c.lines[1].price, 1105);
    assert.equal(c.lines[2].unit, 'ea');
    assert.equal(c.cost_total, 1870);
    assert.equal(c.subtotal, 2375);
    assert.equal(c.tax, 195.94);
    assert.equal(c.total, 2570.94);
    assert.equal(c.deposit, 257.09);
  });
  test('the homeowner view never includes costs or markups', () => {
    const view = est.publicView(
      { number: 1001, kind: 'construction', title: 'T', status: 'sent', show_line_prices: false, subtotal: 120, tax: 0, tax_pct: 0, total: 120, deposit_pct: 50, contact_name: 'Pat' },
      [{ section: 'Kitchen', description: 'Cabinets', quantity: 1, unit: 'ea', unit_cost: 100, markup_pct: 20, price: 120 }],
      { name: 'Co' });
    const json = JSON.stringify(view);
    assert.ok(!/unit_cost|markup/.test(json));
    assert.equal(view.sections[0].lines[0].price, null, 'line prices hidden when asked');
    assert.equal(view.sections[0].total, 120);
    assert.equal(view.deposit, 60);
  });
  test('an estimate expires at the end of its valid-until day', () => {
    const e = { status: 'sent', valid_until: '2026-10-14' };
    assert.equal(est.isExpired(e, new Date('2026-10-14T23:00:00Z')), false);
    assert.equal(est.isExpired(e, new Date('2026-10-15T00:30:00Z')), true);
    assert.equal(est.isExpired({ ...e, status: 'accepted' }, new Date('2027-01-01')), false);
  });
});

describe('CRM automated communications', () => {
  const pb = require('../lib/crmPlaybooks');
  const intake = require('../lib/crmIntake');
  const { LEAD_ADDRESS_RE } = require('../routes/inboundEmail');
  test('stage playbooks keep their original approval fingerprint', () => {
    const steps = [{ days: 3, subject: 'Hi', message: 'Hello' }];
    const crypto = require('crypto');
    const original = crypto.createHash('sha256').update(JSON.stringify({ stage: 'proposal', steps: pb.normalizeSteps(steps) })).digest('hex');
    assert.equal(pb.playbookHash('proposal', steps), original);
    assert.equal(pb.playbookHash('proposal', steps, 'stage'), original);
    assert.notEqual(pb.playbookHash(null, steps, 'meeting'), pb.playbookHash(null, steps, 'estimate_expiry'));
  });
  test('reminders are timed before the event and may use their own details', () => {
    assert.equal(pb.validateSteps([{ days: -1, subject: 'See you {visit_date}', message: 'At {visit_time}, {address}' }], 'meeting'), null);
    assert.match(pb.validateSteps([{ days: 1, subject: 'a', message: 'b' }], 'meeting'), /before the site visit/);
    assert.match(pb.validateSteps([{ days: -1, subject: 'a', message: '{estimate_link}' }], 'meeting'), /\{estimate_link\}/);
    assert.equal(pb.validateSteps([{ days: -3, subject: 'Expires {expires}', message: '{estimate_link} {estimate_total}' }], 'estimate_expiry'), null);
    assert.match(pb.validateSteps([{ days: 1, subject: 'a', message: '{visit_date}' }], 'stage'), /\{visit_date\}/);
    for (const p of pb.DEFAULT_PLAYBOOKS) assert.equal(pb.validateSteps(p.steps, p.trigger), null, p.key);
  });
  test('an estimate stops being valid at the end of its day, Central time', () => {
    assert.equal(pb.estimateExpiresAt('2026-10-20').toISOString(), '2026-10-21T04:59:00.000Z');
    assert.equal(pb.estimateExpiresAt('2026-12-20').toISOString(), '2026-12-21T05:59:00.000Z');
  });
  test('reminders go out 8am-8pm Central', () => {
    assert.equal(pb.inDaytime(new Date('2026-10-18T13:30:00Z')), true); // Sunday 8:30am CDT
    assert.equal(pb.inDaytime(new Date('2026-10-18T12:30:00Z')), false); // 7:30am
    assert.equal(pb.inDaytime(new Date('2026-10-19T01:30:00Z')), false); // 8:30pm
  });
  test('plain lead-email reading finds contact details and the platform', () => {
    const r = intake.parseLeadEmailPlain({ subject: 'New lead from Houzz', from: 'no-reply@houzz.com', text: 'Name: Maria Garcia\nPhone: (713) 555-0101\nEmail: maria@example.test\nKitchen remodel' });
    assert.equal(r.is_lead, true);
    assert.equal(r.name, 'Maria Garcia');
    assert.equal(r.email, 'maria@example.test');
    assert.equal(r.phone, '(713) 555-0101');
    assert.equal(r.source, 'houzz');
    assert.equal(intake.parseLeadEmailPlain({ subject: 'Newsletter', from: 'x', text: 'Big sale this week' }).is_lead, false);
  });
  test('the lead-forwarding address is recognised', () => {
    assert.ok(LEAD_ADDRESS_RE.test('lead-0123456789abcdef01234567@in.example.test'));
    assert.ok(!LEAD_ADDRESS_RE.test('lead-xyz@in.example.test'));
    assert.ok(intake.KEY_RE.test('0123456789abcdef01234567'));
  });
});

describe('CRM Google Workspace (lib/crmGoogle.js)', () => {
  const g = require('../lib/crmGoogle');
  const crypto = require('crypto');
  test('the service-account sign-in request is a valid RS256 token for the right person and scope', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sa = { client_email: 'eagle@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
    const jwt = g.buildAssertion(sa, 'pat@levi.test', g.SCOPES.gmail, Date.UTC(2026, 9, 14));
    const [h, c, sig] = jwt.split('.');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
    const claims = JSON.parse(Buffer.from(c.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.equal(claims.sub, 'pat@levi.test');
    assert.equal(claims.scope, g.SCOPES.gmail);
    assert.equal(claims.exp - claims.iat, 3600);
  });
  test('the key can be given as JSON or base64, and a broken one is ignored', () => {
    const j = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k', client_id: '123' });
    assert.equal(g.serviceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: j }).client_id, '123');
    assert.equal(g.serviceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(j).toString('base64') }).client_id, '123');
    assert.equal(g.serviceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: 'nonsense' }), null);
    assert.equal(g.serviceAccount({}), null);
  });
  test('headers are read and the direction is worked out from the company domain', () => {
    const h = g.readHeaders({ id: 'x', internalDate: '1760000000000', payload: { headers: [
      { name: 'From', value: 'Maria Garcia <Maria@Example.test>' }, { name: 'To', value: 'Pat <pat@levi.test>, "Sam" <sam@levi.test>' },
      { name: 'Cc', value: 'spouse@example.test' }, { name: 'Subject', value: 'Kitchen' }, { name: 'Message-ID', value: '<abc@mail>' }] } });
    assert.equal(h.from, 'maria@example.test');
    assert.deepEqual(h.to, ['pat@levi.test', 'sam@levi.test', 'spouse@example.test']);
    assert.equal(h.messageKey, '<abc@mail>');
    assert.equal(g.directionFor({ from: h.from, mailbox: 'pat@levi.test', domain: 'levi.test' }), 'in');
    assert.equal(g.directionFor({ from: 'sam@levi.test', mailbox: 'pat@levi.test', domain: 'levi.test' }), 'out');
  });
});

describe('CRM weekly report (lib/crmReports.js)', () => {
  const rp = require('../lib/crmReports');
  const facts = {
    company: {
      newLeads: 3, leadsBySource: { website: 2, houzz: 1 }, leadsAnswered: 2, medianResponseMinutes: 95,
      signed: [{ title: 'Garcia kitchen', value: 85000 }], signedValue: 85000, lost: [{ title: 'Chen patio', reason: 'budget' }],
      estimatesSent: 2, estimatesSentValue: 140000, estimatesAccepted: [{ title: 'Garcia kitchen', total: 85000 }], estimatesDeclined: [],
      dealsMoved: 6, openDeals: 5, openValue: 220000, stalled: [{ title: 'Lee addition', stage: 'Proposal sent', daysIdle: 14, owner: 'Alex' }], stalledCount: 1,
      waitingLeads: 1, automaticEmails: 7, replies: 2, customerEmailsIn: 4, customerEmailsOut: 6, needsYou: 2
    },
    team: [
      { name: 'Sam', role: 'owner', leadsAssigned: 2, leadsAnswered: 2, medianResponseMinutes: 30, dealsMoved: 4, notes: 1, customerEmails: 5, estimatesSent: 2, signed: 1, signedValue: 85000, lost: 0, openDeals: 3, stalledDeals: [], waitingLeads: 0 },
      { name: 'Alex', role: 'member', leadsAssigned: 1, leadsAnswered: 0, medianResponseMinutes: null, dealsMoved: 0, notes: 0, customerEmails: 0, estimatesSent: 0, signed: 0, signedValue: 0, lost: 1, openDeals: 2, stalledDeals: ['Lee addition'], waitingLeads: 1 }
    ]
  };
  test('the plain-rules report only states facts, and covers successes, challenges and each person', () => {
    const n = rp.writeByRules(facts);
    assert.equal(n.headline, '$85,000 signed this week');
    assert.ok(n.successes.some(s => /Garcia kitchen/.test(s) && /\$85,000/.test(s)));
    assert.ok(n.challenges.some(s => /1 new lead is still waiting/.test(s)));
    assert.ok(n.challenges.some(s => /Lee addition.*14 days/.test(s)));
    assert.ok(n.challenges.some(s => /Chen patio \(budget\)/.test(s)));
    assert.equal(n.team.length, 2);
    const alex = n.team.find(t => t.name === 'Alex');
    assert.match(alex.note, /hand with 1 lead waiting/);
    assert.ok(!n.team.some(t => /best|worst|top|lowest|lazy/i.test(t.note)), 'no ranking or judging');
  });
  test('a one-person company gets no team section', () => {
    const solo = { ...facts, team: [{ ...facts.team[0], solo: true }] };
    assert.equal(rp.writeByRules(solo).team.length, 0);
  });
  test('the email escapes what it shows', () => {
    const n = rp.writeByRules(facts);
    n.successes.push('<script>x</script>');
    const { html, text, subject } = rp.renderEmail({ companyName: 'A & B <Builders>', report: { facts, narrative: n, writtenBy: 'rules' }, weekLabel: 'week of Oct 12', appUrl: 'https://app.test' });
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('A &amp; B &lt;Builders&gt;'));
    assert.match(text, /WHAT NEEDS ATTENTION/);
    assert.match(subject, /^Your week: \$85,000 signed/);
  });
});

describe('CRM files (lib/crmPortal.js)', () => {
  const pt = require('../lib/crmPortal');
  test('file types come from the bytes, not the name', () => {
    assert.equal(pt.sniffType(Buffer.from('%PDF-1.7 x')).type, 'application/pdf');
    assert.equal(pt.sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).type, 'image/jpeg');
    assert.equal(pt.sniffType(Buffer.from('<html><script>')), null);
    assert.equal(pt.safeFilename('../../etc/passwd.png', 'png'), '.._.._etc_passwd.png');
    assert.equal(pt.safeFilename('', 'pdf'), 'file.pdf');
  });
});

describe('CRM playbooks are email-only', () => {
  test('old text steps become emails and keep the fingerprint they were approved with', () => {
    const pb = require('../lib/crmPlaybooks');
    const email = [{ days: 1, subject: 'Hi', message: 'Hello' }];
    assert.deepEqual(pb.normalizeSteps(email), [{ days: 1, subject: 'Hi', message: 'Hello' }]);
    const legacy = [{ days: 1, subject: 'ignored', message: 'Hello', channel: 'sms' }];
    assert.deepEqual(pb.normalizeSteps(legacy), [{ days: 1, subject: 'ignored', message: 'Hello' }], 'no channel left');
    assert.notEqual(pb.playbookHash('new', legacy), pb.playbookHash('new', [{ days: 1, subject: '', message: 'Hello' }]), 'legacy fingerprint is kept as it was');
    assert.match(pb.validateSteps([{ days: 0, message: 'Hi {name}', channel: 'sms' }]), /needs a subject/, 'every step needs a subject now');
  });
});

describe('CRM job schedule (lib/crmJobs.js)', () => {
  const jobs = require('../lib/crmJobs');
  test('phases are laid out back to back on working days', () => {
    const rows = jobs.layOut([['Kickoff', 1], ['Demo', 3], ['Framing', 5]], '2026-10-17'); // a Saturday
    assert.deepEqual(rows, [
      { title: 'Kickoff', start: '2026-10-19', end: '2026-10-19' },
      { title: 'Demo', start: '2026-10-20', end: '2026-10-22' },
      { title: 'Framing', start: '2026-10-23', end: '2026-10-29' }
    ]);
  });
  test('the built-in remodel template is sensible', () => {
    assert.ok(jobs.DEFAULT_TEMPLATE.length >= 10);
    assert.equal(jobs.DEFAULT_TEMPLATE[0][0], 'Kickoff meeting');
    assert.equal(jobs.DEFAULT_TEMPLATE[jobs.DEFAULT_TEMPLATE.length - 1][0], 'Final walkthrough');
  });
});

describe('CRM job costing (lib/crmCosts.js)', () => {
  const costs = require('../lib/crmCosts');
  test('CSV export quotes commas and neutralises spreadsheet formulas', () => {
    const out = costs.csv([['Vendor', 'Note'], ['Home Depot, #455', '=HYPERLINK("http://evil")'], ['Plain', '+1 call']]);
    assert.equal(out, 'Vendor,Note\r\n"Home Depot, #455","\'=HYPERLINK(""http://evil"")"\r\nPlain,"\'+1 call"\r\n');
  });
});

describe('CRM qualifying', () => {
  const q = require('../lib/crmQualify');
  test('a big budget in a pricey ZIP who wants to start soon is an A', () => {
    const s = q.computeScore({ value: null, zipMedian: 750000, qualify: { budget: '100_250k', timeline: '1_3m', decision: 'all', answered_at: 'x' }, source: 'referral', hasEmail: true, hasPhone: true, minJobValue: 50000 });
    assert.equal(s.grade, 'A');
    assert.equal(s.score, 100);
    assert.ok(s.reasons.every(r => typeof r.why === 'string' && Number.isInteger(r.points)));
  });
  test('a small job from someone just looking is a C, with reasons', () => {
    const s = q.computeScore({ value: 8000, zipMedian: 200000, qualify: { timeline: 'just_looking' }, source: 'website', hasEmail: true, hasPhone: false, minJobValue: 25000 });
    assert.equal(s.grade, 'C');
    assert.ok(s.reasons.some(r => /well under/.test(r.why)));
    assert.ok(s.reasons.some(r => /exploring/.test(r.why)));
  });
  test('knowing nothing lands in the middle', () => {
    const s = q.computeScore({ minJobValue: 25000 });
    assert.equal(s.score, 40);
    assert.equal(s.grade, 'C');
    assert.deepEqual(s.reasons, []);
  });
  test('the questionnaire budget beats the typed-in value', () => {
    const s = q.computeScore({ value: 5000, qualify: { budget: '250k_plus' }, minJobValue: 25000 });
    assert.ok(s.reasons[0].points > 0);
  });
  test('booking settings fall back to sane defaults', () => {
    assert.deepEqual(q.bookingSettings(null), q.DEFAULT_BOOKING);
    const b = q.bookingSettings({ days: [5, 1, 1, 9], start: '25:00', end: '08:00', duration: 5000, buffer: -3, notice: 'x', horizon: 90, userId: 'nope' });
    assert.deepEqual(b.days, [1, 5]);
    assert.equal(b.start, '09:00');
    assert.equal(b.end, '16:00', 'an end before the start is ignored');
    assert.equal(b.duration, 240);
    assert.equal(b.buffer, 0);
    assert.equal(b.notice, 24);
    assert.equal(b.horizon, 60);
    assert.equal(b.userId, null);
  });
  test('the brief by rules uses only what is known', () => {
    const t = q.briefByRules({ contact_name: 'Maria', contact_phone: '713', qualify: { types: ['kitchen'], budget: '50_100k', timeline: 'asap', notes: 'Hates the tile' }, grade: 'A', score_reasons: [{ why: 'Budget fine' }] }, []);
    assert.match(t, /Wants: Kitchen/);
    assert.match(t, /\$50k–\$100k/);
    assert.match(t, /Hates the tile/);
    assert.doesNotMatch(t, /Address/);
  });
});

describe('CRM lifetime', () => {
  const life = require('../lib/crmLifetime');
  const pb = require('../lib/crmPlaybooks');
  test('adding months keeps the day, or the month’s last day', () => {
    assert.equal(life.addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(life.addMonths('2026-10-15', 12), '2027-10-15');
    assert.equal(life.addMonths('2026-11-30', 3), '2027-02-28');
  });
  test('the next care date is always in the future', () => {
    const now = new Date('2026-10-15T17:00:00Z');
    assert.equal(life.nextCare('2024-01-10', 12, now), '2027-01-10');
    assert.equal(life.nextCare('2026-10-15', 6, now), '2027-04-15');
    assert.equal(life.nextCare(null, 3, now), '2027-01-15');
    assert.equal(life.nextCare('2024-01-10', null, now), null);
  });
  test('home care and warranty playbooks have their own timing rules', () => {
    assert.equal(pb.validateSteps([{ days: 0, subject: 'Care for {item}', message: '{care_note}' }], 'home_care'), null);
    assert.match(pb.validateSteps([{ days: -3, subject: 'x', message: 'y' }], 'home_care'), /0 to 14 days after/);
    assert.equal(pb.validateSteps([{ days: -30, subject: 'Ends {warranty_end}', message: 'Your {item}' }], 'warranty_end'), null);
    assert.match(pb.validateSteps([{ days: 0, subject: 'x', message: 'y' }], 'warranty_end'), /-1 to -60/);
    assert.match(pb.validateSteps([{ days: 0, subject: 'x', message: '{item}' }], 'stage'), /not available/);
    assert.equal(pb.validateSteps([{ days: 7, subject: 'x', message: '{review_link} {referral_link}' }], 'stage'), null);
  });
  test('every starter playbook is valid as written', () => {
    for (const p of pb.DEFAULT_PLAYBOOKS) assert.equal(pb.validateSteps(p.steps, p.trigger), null, p.key);
  });
});

describe('CRM marketing', () => {
  const mk = require('../lib/crmMarketing');
  test('ad clicks and campaign tags name the channel', () => {
    assert.equal(mk.channelFromUtm({ gclid: 'abc' }), 'google_ads');
    assert.equal(mk.channelFromUtm({ utm_source: 'google', utm_medium: 'cpc' }), 'google_ads');
    assert.equal(mk.channelFromUtm({ utm_source: 'google', utm_medium: 'organic' }), null, 'organic search is just the website');
    assert.equal(mk.channelFromUtm({ utm_source: 'google', utm_medium: 'lsa' }), 'google_lsa');
    assert.equal(mk.channelFromUtm({ fbclid: 'x' }), 'facebook');
    assert.equal(mk.channelFromUtm({ utm_source: 'ig' }), 'facebook');
    assert.equal(mk.channelFromUtm({ utm_source: 'nextdoor' }), 'nextdoor');
    assert.equal(mk.channelFromUtm({ referrer: 'www.houzz.com' }), 'houzz');
    assert.equal(mk.channelFromUtm(null), null);
  });
  test('tags are cleaned: known keys only, referrer as a host name', () => {
    assert.deepEqual(mk.cleanUtm({ gclid: ' a ', evil: '<x>', referrer: 'https://www.facebook.com/some/path?q=1' }), { gclid: 'a', referrer: 'www.facebook.com' });
    assert.equal(mk.cleanUtm({ referrer: 'javascript:alert(1)' }), null);
    assert.equal(mk.cleanUtm('nope'), null);
  });
  test('months are the 1st', () => {
    assert.equal(mk.monthStart('2026-09'), '2026-09-01');
    assert.equal(mk.monthStart('2026-09-17'), '2026-09-01');
    assert.throws(() => mk.monthStart('2026-13'), /month/);
  });
  test('backlog advice: ramp up into the cheapest channel, ease off the costliest', () => {
    const channels = [
      { source: 'google_ads', spend: 6000, signed: 3, costPerSigned: 2000 },
      { source: 'angi', spend: 3000, signed: 0, costPerSigned: null },
      { source: 'facebook', spend: 4000, signed: 1, costPerSigned: 4000 }
    ];
    const ramp = mk.backlogAdvice({ weeksBooked: 4, lowWeeks: 8, highWeeks: 20, channels });
    assert.equal(ramp.level, 'ramp'); assert.match(ramp.text, /Google Ads/); assert.match(ramp.text, /\$2,000/);
    const ease = mk.backlogAdvice({ weeksBooked: 26, lowWeeks: 8, highWeeks: 20, channels });
    assert.equal(ease.level, 'ease'); assert.match(ease.text, /Angi/); assert.match(ease.text, /nothing signed yet/);
    assert.equal(mk.backlogAdvice({ weeksBooked: 12, lowWeeks: 8, highWeeks: 20, channels }).level, 'hold');
    assert.equal(mk.backlogAdvice({ weeksBooked: null, lowWeeks: 8, highWeeks: 20 }).level, 'unknown');
  });
});

describe('CRM Spanish', () => {
  const pb = require('../lib/crmPlaybooks');
  const es = require('../lib/crmSpanish');
  const steps = [{ days: 3, subject: 'Hi', message: 'Hello {name}' }];
  test('a playbook without Spanish keeps its old fingerprint; Spanish is part of what is approved', () => {
    const plain = pb.playbookHash('proposal', steps);
    assert.equal(pb.playbookHash('proposal', steps, 'stage', null), plain);
    assert.equal(pb.playbookHash('proposal', steps, 'stage', []), plain);
    const withEs = pb.playbookHash('proposal', steps, 'stage', [{ subject: 'Hola', message: 'Hola {name}' }]);
    assert.notEqual(withEs, plain);
    assert.notEqual(pb.playbookHash('proposal', steps, 'stage', [{ subject: 'Hola', message: 'Hola de nuevo' }]), withEs);
    const row = { stage: 'proposal', steps, steps_es: [{ subject: 'Hola', message: 'Hola {name}' }], approved_hash: withEs };
    assert.equal(pb.isApproved(row), true);
    assert.equal(pb.isApproved({ ...row, steps_es: [{ subject: 'Hola', message: 'Cambiado' }] }), false);
  });
  test('the Spanish version must match the English steps and use only allowed fields', () => {
    assert.equal(pb.validateEs(null, steps), null);
    assert.match(pb.validateEs([{ subject: 'a', message: 'b' }, { subject: 'c', message: 'd' }], steps), /same number/);
    assert.match(pb.validateEs([{ subject: '', message: 'b' }], steps), /Spanish Email 1 needs a subject/);
    assert.match(pb.validateEs([{ subject: 'a', message: '{estimate_link}' }], steps), /not available/);
  });
  test('every starter playbook has a valid Spanish version', () => {
    for (const p of pb.DEFAULT_PLAYBOOKS) {
      assert.ok(p.stepsEs, p.key);
      assert.equal(pb.validateEs(p.stepsEs, p.steps, p.trigger), null, p.key);
    }
  });
  test('the phrasebook fills in words in either language', () => {
    assert.equal(es.say('es', 'hi', { first: 'Ana' }), 'Hola Ana:');
    assert.equal(es.say('en', 'hi', { first: 'Ana' }), 'Hi Ana,');
    assert.equal(es.say('es', 'inv_subject', { number: 7, company: 'Co', amount: '$5' }), 'Factura #7 de Co: $5');
    assert.equal(es.say('fr', 'inv_button'), 'View and pay', 'unknown language falls back to English');
  });
});

describe('CRM import, setup and helpers', () => {
  const a = require('../lib/crmAssist');
  test('CSV: quotes, commas and line breaks inside fields, tabs, a BOM', () => {
    assert.deepEqual(a.parseCsv('﻿Name,Notes\r\n"Lee, Ann","said ""hi""\nagain"\r\nBo,x\n\n'), [['Name', 'Notes'], ['Lee, Ann', 'said "hi"\nagain'], ['Bo', 'x']]);
    assert.deepEqual(a.parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  });
  test('columns are guessed from common export headers', () => {
    const m = a.guessMapping(['Client Name', 'Email Address', 'Mobile Phone', 'Street Address', 'City', 'Zip Code', 'Job Name', 'Contract Amount', 'Status', 'Lead Source', 'Notes', 'Date Created']);
    assert.deepEqual(Object.values(m), ['name', 'email', 'phone', 'address', 'city', 'zip', 'title', 'value', 'stage', 'source', 'notes', 'created']);
    const m2 = a.guessMapping(['First Name', 'Last Name', 'E-mail']);
    assert.deepEqual(m2, { 0: 'first', 1: 'last', 2: 'email' });
  });
  test('stages, sources and dates from old tools', () => {
    assert.equal(a.stageFrom('Sold'), 'signed'); assert.equal(a.stageFrom('In Progress'), 'production'); assert.equal(a.stageFrom('Closed Lost'), 'lost');
    assert.equal(a.stageFrom('Closed Won'), 'complete'); assert.equal(a.stageFrom('Bid Sent'), 'proposal'); assert.equal(a.stageFrom('whatever'), 'new');
    assert.equal(a.sourceFrom('HomeAdvisor'), 'angi'); assert.equal(a.sourceFrom('Neighbor referral'), 'referral'); assert.equal(a.sourceFrom('Google'), 'website'); assert.equal(a.sourceFrom(''), 'other');
    assert.equal(a.dateFrom('2024-03-05').getUTCFullYear(), 2024);
    assert.equal(a.dateFrom('45000').toISOString().slice(0, 10), '2023-03-15', 'Excel serial dates');
    assert.equal(a.dateFrom('2099-01-01'), null); assert.equal(a.dateFrom('soon'), null);
  });
  test('the setup answers become settings', () => {
    const p = a.setupPlan({ minJob: '$40,000', paidDesign: 'no', visitDays: [1, 3, 5], visitStart: '08:00', visitEnd: '15:00', replySpeed: 'now', warrantyMonths: '24', reviewUrl: 'https://g.page/r/x', monthlyCapacity: '300k' });
    assert.equal(p.qualify.minJobValue, 40000);
    assert.deepEqual(p.settings.hiddenStages, ['design_agreement', 'in_design']);
    assert.deepEqual(p.qualify.booking.days, [1, 3, 5]); assert.equal(p.qualify.booking.start, '08:00');
    assert.equal(p.settings.waitingMinutes, 15); assert.equal(p.lifetime.warrantyMonths, 24); assert.equal(p.lifetime.reviewUrl, 'https://g.page/r/x');
    assert.equal(p.backlog.monthlyCapacity, undefined, '"300k" is not a number; nothing is set');
    assert.deepEqual(a.setupPlan({}).settings, {});
  });
  test('the plain weekly update, in either language', () => {
    const f = { firstName: 'Ana', done: [{ title: 'Framing' }], doing: [{ title: 'Rough plumbing' }], next: [{ title: 'Drywall' }], logs: [{ body: 'Inspection passed.' }] };
    const en = a.updateByRules({ ...f, lang: 'en' });
    assert.match(en, /Hi Ana/); assert.match(en, /Finished: Framing/); assert.match(en, /Coming up next: Drywall/); assert.match(en, /Inspection passed/);
    assert.match(a.updateByRules({ ...f, lang: 'es' }), /Terminamos: Framing/);
  });
});

describe('CRM assistant pieces', () => {
  const A = require('../lib/crmAssistant');
  const C = require('../lib/crmCheckins');
  test('every tool has a description, a schema and either a run or prepare+execute', () => {
    for (const [name, t] of Object.entries(A.TOOLS)) {
      assert.ok(t.description && t.input_schema && t.input_schema.type === 'object', name);
      assert.ok(t.confirm ? (t.prepare && t.execute) : t.run, name);
      assert.ok(A.LABELS[name], `label for ${name}`);
    }
    const outside = Object.entries(A.TOOLS).filter(([, t]) => t.confirm).map(([n]) => n).sort();
    assert.deepEqual(outside, ['email_homeowner', 'post_portal_update', 'send_bid_request', 'send_change_order', 'send_estimate', 'send_invoice', 'send_purchase_order']);
  });
  test('files shown to the model are not kept in the history', () => {
    const kept = A.stripMedia([{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'File: a.pdf' }, { type: 'document', source: { type: 'base64', data: 'AAAA' } }] }]);
    assert.equal(kept[0].content[1].type, 'text'); assert.match(kept[0].content[1].text, /read_file again/);
  });
  test('an emailed reply keeps only what they wrote', () => {
    assert.equal(C.replyBody('Did the tile.\nGrout tomorrow.\n\nOn Mon, Oct 20, Eagle I <x@y> wrote:\n> What did you get done?'), 'Did the tile.\nGrout tomorrow.');
    assert.equal(C.replyBody('> only quoted'), '');
  });
});

describe('Old Excel (.xls) files', () => {
  const fs = require('fs');
  const path = require('path');
  const { readXlsFirstSheet, rk } = require('../lib/xlsReader');
  test('reads text, numbers, dates and accents from the first sheet only', () => {
    const rows = readXlsFirstSheet(fs.readFileSync(path.join(__dirname, 'fixtures', 'leads.xls')));
    assert.deepEqual(rows[0], ['Client Name', 'Email', 'Phone', 'Job Name', 'Contract Amount', 'Status', 'Date Created', 'Notes']);
    assert.deepEqual(rows[1].slice(0, 7), ['Ana Ruiz', 'ana@xls.test', '713-555-0111', 'Kitchen remodel', '85000', 'Sold', '45749']);
    assert.equal(rows[1][7], 'Wants quartz, “no” carpet');
    assert.equal(rows[2][4], '22000.5');
    assert.equal(rows[3][0], 'José Núñez');
    assert.equal(rows.length, 4, 'the second sheet is not read');
    assert.equal(require('../lib/crmAssist').dateFrom(rows[1][6]).toISOString().slice(0, 10), '2025-04-02');
  });
  test('long shared-string tables split across records come back whole', () => {
    const rows = readXlsFirstSheet(fs.readFileSync(path.join(__dirname, 'fixtures', 'big.xls')));
    assert.equal(rows.length, 700);
    for (const i of [1, 7, 350, 699]) assert.equal(rows[i][1], ('Long note about the project, row ' + i + '. ').repeat(6) + (i % 7 === 0 ? 'é' : ''));
  });
  test('compact numbers (RK) decode', () => {
    assert.equal(rk((42 << 2) | 2), 42);
    assert.equal(rk((1234 << 2) | 3), 12.34);
  });
  test('anything else is turned away politely', () => {
    assert.throws(() => readXlsFirstSheet(Buffer.from('not an excel file at all, just text that is long enough to check')), /isn’t an Excel/);
  });
  test('the importer previews an .xls straight away', () => {
    const p = require('../lib/crmAssist').previewImport({ filename: 'leads.xls', dataBase64: fs.readFileSync(path.join(__dirname, 'fixtures', 'leads.xls')).toString('base64') });
    assert.equal(p.rows, 3); assert.equal(p.mapping[0], 'name'); assert.equal(p.mapping[5], 'stage');
  });
});

describe('CRM AI: estimate checks, forecasts, matching, coaching', () => {
  test('the estimate check flags the usual misses and stays quiet when covered', () => {
    const { checkByRules } = require('../lib/crmEstimateAi');
    const est = (lines, extra = {}) => ({ kind: 'construction', title: 'Refresh', total: 30000, subtotal: 30000, cost_total: 22000, terms: 'x', valid_until: '2026-12-01', deposit_pct: 10, lines, ...extra });
    const k = checkByRules(est([{ description: 'Tile shower walls', quantity: 90, unit: 'sf', unit_cost: 12 }], { title: 'Bath' })).map(i => i.key);
    for (const x of ['permit', 'dumpster', 'waterproof', 'backer', 'plumb']) assert.ok(k.includes(x), x);
    const covered = checkByRules(est([{ description: 'Permit', quantity: 1, unit_cost: 500 }, { description: 'Dumpster', quantity: 1, unit_cost: 600 }, { description: 'Floor protection', quantity: 1, unit_cost: 200 }, { description: 'Final cleaning', quantity: 1, unit_cost: 300 }, { description: 'Project management', quantity: 1, unit_cost: 2000 }, { description: 'Contingency', quantity: 1, unit_cost: 1000 }])).map(i => i.key);
    assert.deepEqual(covered, []);
    assert.ok(checkByRules(est([{ description: 'Cabinets', quantity: 1, unit_cost: 100 }], { subtotal: 1000, cost_total: 950 })).some(i => i.key === 'margin'));
    assert.ok(checkByRules(est([{ description: 'Vanity', quantity: 1, unit_cost: 300 }]), { unitCosts: { vanity: 600 } }).some(i => i.key === 'low'));
  });
  test('the cost forecast follows history and spending pace', () => {
    const { forecastCost, progressOf } = require('../lib/crmForecast');
    assert.equal(forecastCost({ contract: 100, budget: 80, spent: 0, committed: 0, progress: null }).eac, 80);
    assert.equal(forecastCost({ contract: 100, budget: 80, spent: 0, committed: 0, progress: null, history: [1.1, 1.1, 1.1] }).eac, 88);
    assert.equal(forecastCost({ contract: 100, budget: 80, spent: 90, committed: 5, progress: 1 }).eac, 95, 'never below what’s already spent and committed');
    assert.equal(progressOf([{ start_date: '2026-10-19', end_date: '2026-10-19', status: 'done' }, { start_date: '2026-10-20', end_date: '2026-10-22', status: 'todo' }]), 0.25);
  });
  test('schedule risk names its reasons', () => {
    const { scheduleRiskFrom } = require('../lib/crmForecast');
    const r = scheduleRiskFrom({ today: '2026-10-20', items: [{ title: 'Framing', start_date: '2026-10-10', end_date: '2026-10-16', status: 'doing' }, { title: 'City inspection', start_date: '2026-10-22', end_date: '2026-10-22', status: 'todo' }], pos: [{ number: 3, title: 'Windows', status: 'draft', needed_by: '2026-10-23' }], selections: [], cos: [] });
    assert.match(r.reasons.map(x => x.text).join(' '), /Framing.*4 days ago.*inspection.*PO #3/s);
    assert.equal(r.slipDays, 4); assert.equal(r.likelyFinish, '2026-10-28');
    assert.equal(scheduleRiskFrom({ today: '2026-10-20', items: [{ title: 'A', start_date: '2026-11-01', end_date: '2026-11-02', status: 'todo' }], pos: [], selections: [], cos: [] }).level, 'low');
  });
  test('bills find their purchase order', () => {
    const { pickPO } = require('../lib/crmMatching');
    const pos = [{ id: 1, number: 7, total: 1000, billed: 0, vendor_id: 'v', status: 'sent' }, { id: 2, number: 8, total: 300, billed: 0, vendor_id: 'v', status: 'sent' }];
    assert.equal(pickPO({ amount: 290, vendor_id: 'v' }, pos).po.number, 8);
    assert.match(pickPO({ amount: 1000, vendor_id: 'v' }, pos).note, /fully billed/);
    assert.equal(pickPO({ amount: 100, vendor_id: 'v' }, [{ ...pos[0], counted: true }]).flag, 'double');
    assert.equal(pickPO({ amount: 100, vendor_name: 'Someone else' }, pos), null);
  });
  test('change catches are priced from the catalog only', () => {
    const { priceFrom, worthALook } = require('../lib/crmChangeCatcher');
    assert.deepEqual(priceFrom([{ id: 'a', quantity: 2 }, { id: 'zz', quantity: 1 }], [{ id: 'a', name: 'Outlet', unit: 'ea', unit_cost: 100, markup_pct: 50 }]), { cost: 200, amount: 300, from: '2 ea Outlet' });
    assert.equal(priceFrom([], []), null);
    assert.equal(worthALook('Can we upgrade the faucet?'), true);
  });
  test('coaching advice is fair and needs enough to go on', () => {
    const { adviceByRules, findings } = require('../lib/crmCoaching');
    const base = { answered: 0, firstReplyMins: null, unanswered: 0, tasksOverdue: 0, tasksDone: 0, estimatesAccepted: 0, estimatesDeclined: 0, wonValue: 0, quietDeals: 0, siteLogs: 0, checkinsAsked: 0, checkinsAnswered: 0, notes: 0, emails: 0 };
    assert.deepEqual(adviceByRules(base, base, {}), { keep: [], tryThis: [] }, 'nothing recorded, nothing said');
    assert.match(adviceByRules({ ...base, answered: 5, firstReplyMins: 600 }, base, { firstReplyMins: 60 }).tryThis[0], /10\.0 h \(team: 1\.0 h\)/);
    const f = findings([...Array(4)].map(() => ({ won: true, source: 'A', visited: true })).concat([...Array(4)].map(() => ({ won: false, source: 'B', visited: false }))));
    assert.equal(f.overall, 50); assert.equal(f.groups[0].spread, 100);
  });
  test('products are offered under, near and above the allowance', () => {
    const { pickByPrice } = require('../lib/crmProducts');
    const p = [100, 400, 900, 1200, 2000].map(price => ({ price }));
    assert.deepEqual(pickByPrice(p, 1000).map(x => x.price), [400, 900, 1200]);
    assert.deepEqual(pickByPrice(p.slice(0, 2), 1000).map(x => x.price), [100, 400]);
  });
});
