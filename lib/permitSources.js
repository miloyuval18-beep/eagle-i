// One interface over "where do permits and area values come from" for each
// market, so routes/permits.js and routes/signals.js do not care whether they
// are serving Houston (weekly spreadsheets + Harris County appraisal data) or
// San Diego (daily city open data + county parcel records).
//
// A provider says:
//   getRecentPermits(opts)   -> { records, fetchedAt, failures }, records shaped
//                               { zip, permitDate, permitType, projectNo, address, comments }
//   areaInfo(zips)           -> Map(zip -> { region, neighborhood, approxMedianValue, highValue,
//                               estValue, hcad, stats })   (estValue ranks "most valuable homes")
//   owners(items)            -> Map(id -> { firstName, lastName }) -- real owner names, only where
//                               a source exists and is confident; empty otherwise
//   compareAreas(a, b)       -> sort order for the area list
//   meta                     -> the words and links the page shows (city, records source, ...)
//   agingSystems             -> true where a property-age source exists
//
// Markets without their own permit data keep getting Houston's, exactly as
// before this existed.
const houston = require('./houstonPermits');
const sd = require('./sdPermits');
const { HOUSTON_HIGH_VALUE_ZIPS, getHighValueZipInfo } = require('./houstonZipValues');
const { getRealHcadZipStatsForZips, findConfidentOwners } = require('./hcadZipValues');
const { getZipRegion } = require('./houstonZipRegions');
const { getSdZipInfo, SD_HIGH_VALUE_ZIPS, SD_VALUES_META } = require('./sdZipValues');

const HOUSTON = {
  key: 'houston',
  getRecentPermits: houston.getRecentPermits,
  async areaInfo(zips) {
    const hcadByZip = await getRealHcadZipStatsForZips(zips);
    const out = new Map();
    for (const zip of zips) {
      const zipInfo = getHighValueZipInfo(zip);
      const hcad = hcadByZip.get(zip) || null;
      out.set(zip, {
        // Broad area label for grouping/filtering -- covers every zip the permit reports
        // touch, not just the curated high-value list. Falls back to the zip itself.
        region: getZipRegion(zip) || (zipInfo ? zipInfo.neighborhood : null) || `Zip ${zip}`,
        neighborhood: zipInfo ? zipInfo.neighborhood : null,
        approxMedianValue: zipInfo ? zipInfo.approxMedianValue : null,
        highValue: !!zipInfo,
        // Single best-available value for "top N by value": real HCAD data first, then the
        // curated estimate, 0 when neither is known so those permits simply rank last.
        estValue: hcad ? hcad.avgMarketValue : (zipInfo ? zipInfo.approxMedianValue : 0),
        hcad,
        stats: null
      });
    }
    return out;
  },
  owners: (items) => findConfidentOwners(items),
  // Real HCAD data ranks first when present; the curated high-value list is the fallback
  // ranking for zips the import has not covered; permit volume breaks ties.
  compareAreas(a, b) {
    if (!!a.hcad !== !!b.hcad) return a.hcad ? -1 : 1;
    if (a.hcad) return b.hcad.avgMarketValue - a.hcad.avgMarketValue;
    if (a.highValue !== b.highValue) return a.highValue ? -1 : 1;
    if (a.highValue) return b.approxMedianValue - a.approxMedianValue;
    return b.permitCount - a.permitCount;
  },
  trackedHighValueZipCount: HOUSTON_HIGH_VALUE_ZIPS.length,
  agingSystems: true,
  meta: {
    key: 'houston', city: 'Houston', cityState: 'Houston, TX', metro: 'the Houston area',
    recordsName: 'City of Houston', recordsCadence: 'once a week',
    recordsUrl: 'https://www.houstonpermittingcenter.org/sold-permits-search',
    recordsLinkLabel: "See the City's Original Records ↗",
    ownerNote: 'On the rare property where public county tax records clearly show a real owner\'s name, your mailer letter will use that name instead.',
    csvPrefix: 'houston_permits'
  }
};

const SAN_DIEGO = {
  key: 'san_diego',
  getRecentPermits: sd.getRecentPermits,
  async areaInfo(zips) {
    const out = new Map();
    for (const zip of zips) {
      const info = getSdZipInfo(zip);
      const value = info ? info.approxMedianValue : null;
      out.set(zip, {
        region: (info && info.region) || `Zip ${zip}`,
        neighborhood: info && info.highValue ? info.region : null,
        approxMedianValue: value,
        highValue: !!(info && info.highValue),
        estValue: value || 0,
        hcad: null,
        stats: value ? { kind: 'recent_sale_median', value, since: info.valueSince, transfers: info.recentTransfers } : null
      });
    }
    return out;
  },
  // California does not publish owner names with the parcel data, and the permit holder is
  // often the contractor, so letters stay addressed to "Property Owner".
  owners: async () => new Map(),
  compareAreas(a, b) {
    if (!!a.estValue !== !!b.estValue) return a.estValue ? -1 : 1;
    if (a.estValue !== b.estValue) return b.estValue - a.estValue;
    return b.permitCount - a.permitCount;
  },
  trackedHighValueZipCount: SD_HIGH_VALUE_ZIPS.length,
  agingSystems: false,
  agingNote: 'Aging-system targeting is not available for San Diego yet. The county\'s parcel records give a home\'s "effective year" as only two digits (for example "08"), which could mean 1908 or 2008 -- a wrong guess would tell the owner of a 100-year-old house that its roof is 18 years old. It will be added once the century can be told apart reliably.',
  meta: {
    key: 'san_diego', city: 'San Diego', cityState: 'San Diego, CA', metro: 'the San Diego area',
    recordsName: 'City of San Diego', recordsCadence: 'every day',
    recordsUrl: 'https://data.sandiego.gov/datasets/development-permits/',
    recordsLinkLabel: "See the City's Open Data Records ↗",
    ownerNote: 'San Diego County does not publish owner names with its property data, so every letter is addressed to "Property Owner".',
    valueNote: `Area values are the median county-assessed value of single-family homes recorded as sold since ${SD_VALUES_META.since} (California reassesses a home to its purchase price when it sells), so they approximate recent sale prices. They are not appraisals.`,
    coverageNote: 'Covers permits issued inside the City of San Diego only. Chula Vista, Oceanside, Escondido, Carlsbad and the unincorporated county publish their permits separately.',
    csvPrefix: 'san_diego_permits'
  }
};

const PROVIDERS = { houston: HOUSTON, san_diego: SAN_DIEGO };

// The provider for a market; markets without their own keep Houston's.
function providerFor(market) {
  return PROVIDERS[market && market.key] || HOUSTON;
}

// Does this market have permit data of its own (as opposed to inheriting Houston's)?
const hasOwnPermits = (market) => !!PROVIDERS[market && market.key];

module.exports = { providerFor, hasOwnPermits, PROVIDERS };
