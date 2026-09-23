// Google Local Services Ads readiness — see the migration's header for why
// this is a checklist/document tool, not a campaign creator: Google has no
// API to create or launch an LSA campaign, only its own manual
// verification process on ads.google.com/local-services-ads.
const express = require('express');
const { requireAuth } = require('../auth');
const { query } = require('../db');
const { checkAndIncrementUsage } = require('../lib/usage');
const { generateJSON } = require('../lib/anthropic');

const router = express.Router();
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const KINDS = ['license', 'insurance'];
const oneLine = (s, n) => String(s == null ? '' : s).split('').filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('').replace(/\s+/g, ' ').trim().slice(0, n);

// Same real signature-sniff as lib/workWithUs.js — documents can be a PDF
// or a photo of a physical certificate.
function sniffType(buf) {
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  return null;
}
const safeFilename = (name, ext, kind) => {
  const base = oneLine(name, 80).replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{1,5}$/i, '').trim() || kind;
  return `${base}.${ext}`;
};

router.get('/api/lsa/status', requireAuth, async (req, res) => {
  try {
    const t = await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId]);
    if (!t.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const p = (await query(
      `SELECT address, phone, service_area, founder_name, lsa_has_insurance, lsa_years_in_business, lsa_service_categories, lsa_bio, lsa_bio_generated_at
       FROM business_profile WHERE tenant_id = $1`, [req.tenantId])).rows[0] || {};
    const docs = (await query('SELECT id, kind, filename, content_type, size, created_at FROM lsa_documents WHERE tenant_id = $1 ORDER BY id', [req.tenantId])).rows;

    res.json({
      companyName: t.rows[0].company_name,
      // Auto-derived checklist items — real facts already on file, not asked twice.
      hasAddress: !!(p.address && p.address.trim()),
      hasPhone: !!(p.phone && p.phone.trim()),
      hasServiceArea: !!(p.service_area && p.service_area.trim()),
      hasOwnerName: !!(p.founder_name && p.founder_name.trim()),
      // Self-reported checklist items.
      hasInsurance: p.lsa_has_insurance ?? null,
      yearsInBusiness: p.lsa_years_in_business || '',
      serviceCategories: p.lsa_service_categories || '',
      bio: p.lsa_bio || '',
      bioGeneratedAt: p.lsa_bio_generated_at || null,
      documents: docs.map(d => ({ id: Number(d.id), kind: d.kind, filename: d.filename, contentType: d.content_type, size: d.size, createdAt: d.created_at }))
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load: ' + err.message } });
  }
});

router.patch('/api/lsa/checklist', requireAuth, async (req, res) => {
  const { hasInsurance, yearsInBusiness, serviceCategories } = req.body || {};
  try {
    await query(
      `UPDATE business_profile SET
         lsa_has_insurance = COALESCE($2, lsa_has_insurance),
         lsa_years_in_business = COALESCE($3, lsa_years_in_business),
         lsa_service_categories = COALESCE($4, lsa_service_categories)
       WHERE tenant_id = $1`,
      [req.tenantId, typeof hasInsurance === 'boolean' ? hasInsurance : null,
       yearsInBusiness !== undefined ? oneLine(yearsInBusiness, 40) : null,
       serviceCategories !== undefined ? oneLine(serviceCategories, 300) : null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save: ' + err.message } });
  }
});

router.post('/api/lsa/documents', requireAuth, async (req, res) => {
  try {
    const { kind, name, data } = req.body || {};
    if (!KINDS.includes(kind)) return res.status(400).json({ error: { message: 'kind must be license or insurance.' } });
    const b64 = String(data || '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return res.status(400).json({ error: { message: 'The file could not be read. Try again.' } });
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return res.status(400).json({ error: { message: 'The file is empty.' } });
    if (buf.length > MAX_FILE_BYTES) return res.status(400).json({ error: { message: 'The file can be up to 6 MB.' } });
    const sniffed = sniffType(buf);
    if (!sniffed) return res.status(400).json({ error: { message: 'Files must be PDF, JPG or PNG.' } });
    const filename = safeFilename(name, sniffed.ext, kind);

    const row = (await query(
      'INSERT INTO lsa_documents (tenant_id, kind, filename, content_type, size, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.tenantId, kind, filename, sniffed.type, buf.length, buf]
    )).rows[0];
    res.json({ id: Number(row.id), filename, contentType: sniffed.type, size: buf.length });
  } catch (err) {
    res.status(500).json({ error: { message: 'Upload failed: ' + err.message } });
  }
});

router.get('/api/lsa/documents/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const r = await query('SELECT filename, content_type, data FROM lsa_documents WHERE id = $1 AND tenant_id = $2', [id, req.tenantId]);
    if (!r.rows.length) return res.status(404).json({ error: { message: 'File not found.' } });
    const f = r.rows[0];
    res.set({
      'Content-Type': f.content_type,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'"
    }).send(f.data);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load: ' + err.message } });
  }
});

router.delete('/api/lsa/documents/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const n = (await query('DELETE FROM lsa_documents WHERE id = $1 AND tenant_id = $2', [id, req.tenantId])).rowCount;
    if (!n) return res.status(404).json({ error: { message: 'Not found.' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to delete: ' + err.message } });
  }
});

router.post('/api/lsa/generate-bio', requireAuth, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: { message: 'AI drafting is not configured on this server yet (missing ANTHROPIC_API_KEY).' } });
  }
  try {
    const usage = await checkAndIncrementUsage(req.tenantId);
    if (!usage.allowed) return res.status(429).json({ error: { message: `Monthly generation limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.`, code: 'generation_cap' } });

    const t = await query('SELECT company_name, industry FROM tenants WHERE id = $1', [req.tenantId]);
    if (!t.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const p = (await query('SELECT founder_name, service_area, services, differentiators FROM business_profile WHERE tenant_id = $1', [req.tenantId])).rows[0] || {};

    const prompt = `Write a short business description for a Google Local Services Ads profile — the "About" text homeowners see before they message the business. 2-3 sentences, plain and trustworthy, no hype/superlatives ("best," "#1"), no fabricated claims beyond what's given.

Business: ${t.rows[0].company_name}
Industry: ${t.rows[0].industry || 'construction'}
Owner: ${p.founder_name || ''}
Service area: ${p.service_area || 'the local area'}
Services: ${p.services || ''}
What makes them different: ${p.differentiators || ''}

Return ONLY this JSON: {"bio": "..."}`;
    const result = await generateJSON(prompt, 400);
    const bio = String(result.bio || '').trim();
    if (!bio) throw new Error('Empty draft.');

    await query('UPDATE business_profile SET lsa_bio = $1, lsa_bio_generated_at = now() WHERE tenant_id = $2', [bio, req.tenantId]);
    res.json({ ok: true, bio });
  } catch (err) {
    res.status(500).json({ error: { message: 'Draft failed: ' + err.message } });
  }
});

module.exports = router;
