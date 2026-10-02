// Real building-permit data for real-estate/home-services tenants — Houston's
// from lib/houstonPermits.js (weekly reports, no owner name field) or San Diego's
// from lib/sdPermits.js (daily city open data), chosen by the company's market
// via lib/permitSources.js. Both have real limitations, documented there.
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { mostRecentWeekKey, isNewestWeek } = require('../lib/houstonPermits');
const { getParcelAgesForZips } = require('../lib/hcadZipValues');
const { getHighValueZipInfo } = require('../lib/houstonZipValues');
const { getZipRegion } = require('../lib/houstonZipRegions');
const { providerFor } = require('../lib/permitSources');
const markets = require('../lib/markets');
const { buildPermitLetter, buildAgingSystemLetter } = require('../lib/permitMailer');
const { normalizeAddress } = require('../lib/hcadOwnerNames');
const { qualifiesForPermits } = require('../lib/realEstateAccess');

const router = express.Router();

// The permit/area-value source for this company's market (Houston's for any
// market that has none of its own, as it always was).
async function tenantProvider(tenantId) {
  const r = await query('SELECT market FROM business_profile WHERE tenant_id = $1', [tenantId]);
  return providerFor(markets.getMarket(r.rows[0] && r.rows[0].market));
}

// Roughly the point in a system's typical service life where it's worth a
// proactive look, not a hard failure age — framed to the homeowner as
// "likely due," never a guarantee (see lib/permitMailer.js's letter copy).
// These are defensible engineering ranges, not verified against real
// roofing/HVAC/plumbing trade guidance — worth a sanity check against
// that before this copy ships broadly.
const SYSTEM_AGE_THRESHOLDS = {
  roof: { minAge: 18, maxAge: 25 },
  hvac: { minAge: 12, maxAge: 18 },
  water_heater: { minAge: 8, maxAge: 12 }
};

router.get('/api/permits/high-value-areas', requireAuth, async (req, res) => {
  try {
    const tenantRes = await query('SELECT industry, company_name FROM tenants WHERE id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    if (!qualifiesForPermits({ industry: tenantRes.rows[0].industry, companyName: tenantRes.rows[0].company_name })) {
      return res.status(403).json({ error: { message: 'This feature is only available for real estate, home services, or construction accounts.' } });
    }

    const provider = await tenantProvider(req.tenantId);
    const forceRefresh = req.query.refresh === 'true';
    const { records, fetchedAt, failures } = await provider.getRecentPermits({ weeksBack: 4, forceRefresh });

    const byZip = new Map();
    for (const rec of records) {
      if (!byZip.has(rec.zip)) byZip.set(rec.zip, []);
      byZip.get(rec.zip).push(rec);
    }

    const info = await provider.areaInfo([...byZip.keys()]);

    // "New" means the most recent week the city has actually published data for —
    // not today's real calendar week. Houston's own publish lag runs well over a
    // week (observed directly: the newest report was still only "Aug 17-23" as of
    // Sept 2), so a permit dated in the literal current week essentially never
    // exists yet; see lib/houstonPermits.js's mostRecentWeekKey for the reasoning.
    // Computed once across all records, not per zip/permit.
    const latestWeekKey = mostRecentWeekKey(records);

    const areas = [...byZip.entries()].map(([zip, permits]) => {
      const a = info.get(zip);
      return {
        zip,
        region: a.region,
        neighborhood: a.neighborhood,
        approxMedianValue: a.approxMedianValue,
        highValue: a.highValue,
        estValue: a.estValue,
        hcad: a.hcad, // Houston only: real HCAD appraisal-district data, when the import has covered this zip
        stats: a.stats, // San Diego only: recent-sale median from county parcel records
        permitCount: permits.length,
        newCount: permits.filter(p => isNewestWeek(p.permitDate, latestWeekKey)).length,
        permits: permits
          .sort((x, y) => (y.permitDate || '').localeCompare(x.permitDate || ''))
          .slice(0, 25) // cap per zip so one busy zip doesn't dwarf the response
          .map(p => ({ ...p, isNew: isNewestWeek(p.permitDate, latestWeekKey) }))
      };
    });
    areas.sort(provider.compareAreas);

    res.json({
      areas,
      totalPermits: records.length,
      fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      sourceFailures: failures && failures.length ? failures : undefined,
      trackedHighValueZipCount: provider.trackedHighValueZipCount,
      market: provider.meta,
      agingSystems: provider.agingSystems
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to load permit data: ' + err.message } });
  }
});

// Caps how much text a single field can carry into a letter — the client
// is expected to send back exactly the permit rows it just received from
// the endpoint above, but this is still user-reachable input, so keep
// individual fields bounded regardless of what's actually sent.
const MAX_FIELD_LEN = 300;
function cleanField(v) {
  return String(v == null ? '' : v).slice(0, MAX_FIELD_LEN);
}

// Builds one personalized letter per selected permit — see
// lib/permitMailer.js for why this is a deterministic template rather than
// an AI call (a batch here can be up to 200 letters). The client already
// has the full permit + area data from GET /api/permits/high-value-areas
// above (same pattern already used by the CSV export), so it sends back
// exactly the rows the tenant selected rather than re-fetching permits by
// some id — permits have no stable id in the source data. The tenant's own
// business-profile fields are read fresh from the database here, not
// trusted from the client, so a letter always reflects what's actually
// saved on the account.
router.post('/api/permits/mailer-letters', requireAuth, async (req, res) => {
  try {
    const tenantRes = await query('SELECT company_name, industry FROM tenants WHERE id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    if (!qualifiesForPermits({ industry: tenantRes.rows[0].industry, companyName: tenantRes.rows[0].company_name })) {
      return res.status(403).json({ error: { message: 'This feature is only available for real estate, home services, or construction accounts.' } });
    }

    const permits = Array.isArray(req.body.permits) ? req.body.permits : [];
    if (!permits.length) return res.status(400).json({ error: { message: 'No permits selected.' } });
    if (permits.length > 200) return res.status(400).json({ error: { message: 'Select 200 permits or fewer at a time.' } });

    const profileRes = await query(
      'SELECT founder_name, phone, email, services, differentiators FROM business_profile WHERE tenant_id = $1',
      [req.tenantId]
    );
    const profile = profileRes.rows[0] || {};
    const tenant = {
      name: tenantRes.rows[0].company_name,
      founder: profile.founder_name,
      phone: profile.phone,
      email: profile.email,
      services: profile.services,
      unique: profile.differentiators
    };

    const cleanedPermits = permits.map((p, i) => {
      const zip = cleanField(p && p.zip).replace(/[^0-9]/g, '').slice(0, 5);
      return {
        id: i,
        zip,
        address: cleanField(p && p.address),
        permitType: cleanField(p && p.permitType),
        permitDate: cleanField(p && p.permitDate),
        projectNo: cleanField(p && p.projectNo),
        comments: cleanField(p && p.comments)
      };
    });

    // Real property-owner names, only where lib/hcadZipValues.js's
    // findConfidentOwners() considers the (zip, address) match unambiguous
    // — see lib/hcadOwnerNames.js for the "only if fully confident" rules.
    // One query for the whole batch, not one per permit.
    const provider = await tenantProvider(req.tenantId);
    const owners = await provider.owners(
      cleanedPermits.map(p => ({ id: p.id, zip: p.zip, address: p.address }))
    );
    const areaInfo = await provider.areaInfo([...new Set(cleanedPermits.map(p => p.zip).filter(Boolean))]);

    const letters = cleanedPermits.map(permit => {
      const a = areaInfo.get(permit.zip);
      const region = (a && a.region) || (permit.zip ? `Zip ${permit.zip}` : '');
      const owner = owners.get(permit.id) || null;
      const letter = buildPermitLetter({ permit, area: { zip: permit.zip, region, metro: provider.meta.metro }, tenant, owner });
      return { ...letter, permitType: permit.permitType, permitDate: permit.permitDate, projectNo: permit.projectNo, region, cityState: provider.meta.cityState };
    });

    res.json({
      letters,
      tenant: { name: tenant.name, founder: tenant.founder, phone: tenant.phone, email: tenant.email }
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to build mailer letters: ' + err.message } });
  }
});

// Properties whose HCAD-recorded construction year suggests a given
// system (roof/HVAC/water heater) is likely due, scoped to the same zips
// the tenant's regular Permits view is already showing (from the same
// getRecentPermits() window) so this stays relevant to their actual
// service area rather than all of Harris County. Excludes any address
// that already has a permit in that same recent window — a house that
// just pulled a roof permit shouldn't also get an "aging roof" pitch.
router.get('/api/permits/aging-systems', requireAuth, async (req, res) => {
  try {
    const tenantRes = await query('SELECT industry, company_name FROM tenants WHERE id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    if (!qualifiesForPermits({ industry: tenantRes.rows[0].industry, companyName: tenantRes.rows[0].company_name })) {
      return res.status(403).json({ error: { message: 'This feature is only available for real estate, home services, or construction accounts.' } });
    }

    const system = String(req.query.system || 'roof');
    const thresholds = SYSTEM_AGE_THRESHOLDS[system];
    if (!thresholds) {
      return res.status(400).json({ error: { message: `system must be one of: ${Object.keys(SYSTEM_AGE_THRESHOLDS).join(', ')}` } });
    }

    const provider = await tenantProvider(req.tenantId);
    if (!provider.agingSystems) return res.json({ properties: [], system, thresholds, unavailable: provider.agingNote });

    const forceRefresh = req.query.refresh === 'true';
    const { records, fetchedAt } = await provider.getRecentPermits({ weeksBack: 4, forceRefresh });
    const zips = [...new Set(records.map(r => r.zip).filter(Boolean))];
    const recentAddresses = new Set(records.filter(r => r.address).map(r => `${r.zip}||${normalizeAddress(r.address)}`));

    const thisYear = new Date().getFullYear();
    const minYear = thisYear - thresholds.maxAge;
    const maxYear = thisYear - thresholds.minAge;

    const candidates = await getParcelAgesForZips(zips, { minYear, maxYear, limit: 300 });
    const properties = candidates
      .filter(p => !recentAddresses.has(`${p.zip}||${p.normalizedAddress}`))
      .map(p => {
        const zipInfo = getHighValueZipInfo(p.zip);
        return {
          zip: p.zip,
          address: p.rawSiteAddress,
          yearBuilt: p.yearBuilt,
          approxAge: thisYear - p.yearBuilt,
          region: getZipRegion(p.zip) || (zipInfo ? zipInfo.neighborhood : null) || `Zip ${p.zip}`,
          neighborhood: zipInfo ? zipInfo.neighborhood : null,
          highValue: !!zipInfo
        };
      });

    res.json({
      properties,
      system,
      thresholds,
      fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to load aging-system properties: ' + err.message } });
  }
});

// Same shape and safeguards as POST /api/permits/mailer-letters above,
// building letters for aging-system properties instead of real permits —
// see lib/permitMailer.js's buildAgingSystemLetter for why this is a
// separate function (reusing the permit-letter openers here would falsely
// claim a permit exists).
router.post('/api/permits/aging-mailer-letters', requireAuth, async (req, res) => {
  try {
    const tenantRes = await query('SELECT company_name, industry FROM tenants WHERE id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    if (!qualifiesForPermits({ industry: tenantRes.rows[0].industry, companyName: tenantRes.rows[0].company_name })) {
      return res.status(403).json({ error: { message: 'This feature is only available for real estate, home services, or construction accounts.' } });
    }

    const system = String(req.body.system || 'roof');
    if (!SYSTEM_AGE_THRESHOLDS[system]) {
      return res.status(400).json({ error: { message: `system must be one of: ${Object.keys(SYSTEM_AGE_THRESHOLDS).join(', ')}` } });
    }
    const provider = await tenantProvider(req.tenantId);
    if (!provider.agingSystems) return res.status(400).json({ error: { message: provider.agingNote } });

    const properties = Array.isArray(req.body.properties) ? req.body.properties : [];
    if (!properties.length) return res.status(400).json({ error: { message: 'No properties selected.' } });
    if (properties.length > 200) return res.status(400).json({ error: { message: 'Select 200 properties or fewer at a time.' } });

    const profileRes = await query(
      'SELECT founder_name, phone, email, services, differentiators FROM business_profile WHERE tenant_id = $1',
      [req.tenantId]
    );
    const profile = profileRes.rows[0] || {};
    const tenant = {
      name: tenantRes.rows[0].company_name,
      founder: profile.founder_name,
      phone: profile.phone,
      email: profile.email,
      services: profile.services,
      unique: profile.differentiators
    };

    const cleanedProperties = properties.map((p, i) => {
      const zip = cleanField(p && p.zip).replace(/[^0-9]/g, '').slice(0, 5);
      const yearBuilt = parseInt(p && p.yearBuilt, 10);
      return {
        id: i,
        zip,
        address: cleanField(p && p.address),
        yearBuilt: Number.isFinite(yearBuilt) ? yearBuilt : null
      };
    });

    const owners = await provider.owners(
      cleanedProperties.map(p => ({ id: p.id, zip: p.zip, address: p.address }))
    );

    const letters = cleanedProperties.map(property => {
      const zipInfo = getHighValueZipInfo(property.zip);
      const region = getZipRegion(property.zip) || (zipInfo ? zipInfo.neighborhood : null) || (property.zip ? `Zip ${property.zip}` : '');
      const owner = owners.get(property.id) || null;
      const letter = buildAgingSystemLetter({ property, area: { zip: property.zip, region, metro: provider.meta.metro }, tenant, system, owner });
      return { ...letter, yearBuilt: property.yearBuilt, system, region, cityState: provider.meta.cityState };
    });

    res.json({
      letters,
      tenant: { name: tenant.name, founder: tenant.founder, phone: tenant.phone, email: tenant.email }
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to build aging-system mailer letters: ' + err.message } });
  }
});

module.exports = router;
