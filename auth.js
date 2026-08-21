// Self-rolled email+password auth: bcrypt hashing, Postgres-backed sessions
// (connect-pg-simple), httpOnly/secure/sameSite cookies. No third-party
// auth vendor — see the plan's rationale in the repo's plan file.

const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool, query } = require('./db');
const { sendEmail } = require('./lib/email');

const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Raw tokens go in emails/links; only their SHA-256 hash is ever stored, so
// a DB leak alone can't be used to reset a password or verify an email.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('WARNING: SESSION_SECRET is not set — using an insecure default. Set it before going live.');
  }
  return session({
    store: new pgSession({ pool, createTableIfMissing: true }),
    secret: secret || 'dev-only-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
  });
}

// Attach to routes that require a logged-in user. Populates req.tenantId / req.userId.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: { message: 'Not logged in.' } });
  }
  req.userId = req.session.userId;
  req.tenantId = req.session.tenantId;
  next();
}

// Attach after requireAuth on platform-admin-only routes (read-only visibility
// across all tenants — not impersonation/write access to other tenants' data).
async function requireAdmin(req, res, next) {
  try {
    const result = await query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    if (!result.rows.length || !result.rows[0].is_admin) {
      return res.status(403).json({ error: { message: 'Admin access required.' } });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to verify admin access: ' + err.message } });
  }
}

function registerAuthRoutes(app) {
  app.post('/api/auth/signup', async (req, res) => {
    const { email, password, companyName, industry, acceptedTerms } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: { message: 'A valid email is required.' } });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: { message: 'Password must be at least 8 characters.' } });
    }
    if (!companyName || !companyName.trim()) {
      return res.status(400).json({ error: { message: 'Company name is required.' } });
    }
    if (!acceptedTerms) {
      return res.status(400).json({ error: { message: 'You must accept the Terms of Service and Privacy Policy.' } });
    }
    const validIndustries = ['home_services', 'real_estate', 'professional_services', 'retail', 'other'];
    const safeIndustry = validIndustries.includes(industry) ? industry : 'other';

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: 'An account with that email already exists.' } });
      }

      const tenantResult = await client.query(
        `INSERT INTO tenants (company_name, industry) VALUES ($1, $2) RETURNING id`,
        [companyName.trim(), safeIndustry]
      );
      const tenantId = tenantResult.rows[0].id;

      await client.query(`INSERT INTO business_profile (tenant_id) VALUES ($1)`, [tenantId]);

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const userResult = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, terms_accepted_at, email_verification_token_hash, email_verification_sent_at)
         VALUES ($1, $2, $3, now(), $4, now()) RETURNING id`,
        [tenantId, email.toLowerCase(), passwordHash, hashToken(verificationToken)]
      );

      await client.query('COMMIT');

      req.session.userId = userResult.rows[0].id;
      req.session.tenantId = tenantId;
      res.json({ ok: true, tenantId });

      // Best-effort — signup already succeeded and the user is logged in
      // regardless of whether this send works (e.g. RESEND_API_KEY unset).
      const verifyUrl = `${req.protocol}://${req.get('host')}/verify-email.html?token=${verificationToken}`;
      sendEmail({
        to: email.toLowerCase(),
        subject: 'Verify your Eagle I email',
        html: `<p>Welcome to Eagle I! <a href="${verifyUrl}">Confirm your email address</a> to secure your account.</p>`,
        text: `Welcome to Eagle I! Confirm your email address: ${verifyUrl}`
      }).catch(err => console.warn('Verification email not sent:', err.message));
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: { message: 'Signup failed: ' + err.message } });
    } finally {
      if (client) client.release();
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: { message: 'Email and password are required.' } });
    }
    try {
      const result = await query('SELECT id, tenant_id, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
      const user = result.rows[0];
      // Always run bcrypt.compare, even with a placeholder hash, so failed
      // lookups take the same time as failed password checks (no user-enumeration timing leak).
      const hashToCheck = user ? user.password_hash : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidin.';
      const valid = await bcrypt.compare(password, hashToCheck);
      if (!user || !valid) {
        return res.status(401).json({ error: { message: 'Invalid email or password.' } });
      }
      req.session.userId = user.id;
      req.session.tenantId = user.tenant_id;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: { message: 'Login failed: ' + err.message } });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get('/api/auth/me', async (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: { message: 'Not logged in.' } });
    }
    try {
      const result = await query(
        `SELECT u.email, u.email_verified, u.is_admin, t.id AS tenant_id, t.company_name, t.industry, t.plan_tier
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.id = $1`,
        [req.session.userId]
      );
      if (!result.rows.length) return res.status(401).json({ error: { message: 'Not logged in.' } });
      const row = result.rows[0];
      res.json({ email: row.email, emailVerified: row.email_verified, isAdmin: row.is_admin, tenant_id: row.tenant_id, company_name: row.company_name, industry: row.industry, plan_tier: row.plan_tier });
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to load session: ' + err.message } });
    }
  });

  app.post('/api/auth/request-password-reset', async (req, res) => {
    const { email } = req.body || {};
    // Always respond ok:true regardless of whether the email exists, so this
    // endpoint can't be used to enumerate registered accounts.
    if (!email || !EMAIL_RE.test(email)) {
      return res.json({ ok: true });
    }
    try {
      const userRes = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (userRes.rows.length) {
        const userId = userRes.rows[0].id;
        const token = crypto.randomBytes(32).toString('hex');
        await query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
          [userId, hashToken(token), new Date(Date.now() + RESET_TOKEN_TTL_MS)]
        );
        const resetUrl = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
        sendEmail({
          to: email.toLowerCase(),
          subject: 'Reset your Eagle I password',
          html: `<p>Someone requested a password reset. <a href="${resetUrl}">Reset your password</a> — this link expires in 1 hour. If this wasn't you, ignore this email.</p>`,
          text: `Reset your password: ${resetUrl} (expires in 1 hour; ignore if this wasn't you)`
        }).catch(err => console.warn('Password reset email not sent:', err.message));
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to process request: ' + err.message } });
    }
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: { message: 'A valid token and a password of at least 8 characters are required.' } });
    }
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const tokenRes = await client.query(
        `SELECT id, user_id FROM password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
        [hashToken(token)]
      );
      if (!tokenRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'That reset link is invalid or has expired.' } });
      }
      const { id: tokenId, user_id: userId } = tokenRes.rows[0];
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
      await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [tokenId]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: { message: 'Failed to reset password: ' + err.message } });
    } finally {
      if (client) client.release();
    }
  });

  app.post('/api/auth/verify-email', async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: { message: 'Missing token.' } });
    try {
      const result = await query(
        `UPDATE users SET email_verified = true, email_verification_token_hash = NULL
         WHERE email_verification_token_hash = $1 RETURNING id`,
        [hashToken(token)]
      );
      if (!result.rows.length) {
        return res.status(400).json({ error: { message: 'That verification link is invalid or already used.' } });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to verify email: ' + err.message } });
    }
  });

  app.post('/api/auth/resend-verification', async (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: { message: 'Not logged in.' } });
    }
    try {
      const userRes = await query('SELECT email, email_verified FROM users WHERE id = $1', [req.session.userId]);
      if (!userRes.rows.length) return res.status(404).json({ error: { message: 'Account not found.' } });
      const user = userRes.rows[0];
      if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

      const token = crypto.randomBytes(32).toString('hex');
      await query(
        `UPDATE users SET email_verification_token_hash = $1, email_verification_sent_at = now() WHERE id = $2`,
        [hashToken(token), req.session.userId]
      );
      const verifyUrl = `${req.protocol}://${req.get('host')}/verify-email.html?token=${token}`;
      await sendEmail({
        to: user.email,
        subject: 'Verify your Eagle I email',
        html: `<p><a href="${verifyUrl}">Confirm your email address</a> to secure your account.</p>`,
        text: `Confirm your email address: ${verifyUrl}`
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: { message: 'Failed to send verification email: ' + err.message } });
    }
  });

  app.post('/api/auth/change-password', async (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: { message: 'Not logged in.' } });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: { message: 'New password must be at least 8 characters.' } });
    }
    try {
      const userRes = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
      if (!userRes.rows.length) return res.status(404).json({ error: { message: 'Account not found.' } });
      const valid = await bcrypt.compare(currentPassword || '', userRes.rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: { message: 'Current password is incorrect.' } });
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, req.session.userId]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to change password: ' + err.message } });
    }
  });

  app.post('/api/auth/change-email', async (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: { message: 'Not logged in.' } });
    }
    const { newEmail, password } = req.body || {};
    if (!newEmail || !EMAIL_RE.test(newEmail)) {
      return res.status(400).json({ error: { message: 'A valid email is required.' } });
    }
    try {
      const userRes = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
      if (!userRes.rows.length) return res.status(404).json({ error: { message: 'Account not found.' } });
      const valid = await bcrypt.compare(password || '', userRes.rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: { message: 'Password is incorrect.' } });

      const existing = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [newEmail.toLowerCase(), req.session.userId]);
      if (existing.rows.length) {
        return res.status(409).json({ error: { message: 'That email is already in use.' } });
      }
      const token = crypto.randomBytes(32).toString('hex');
      await query(
        `UPDATE users SET email = $1, email_verified = false, email_verification_token_hash = $2, email_verification_sent_at = now() WHERE id = $3`,
        [newEmail.toLowerCase(), hashToken(token), req.session.userId]
      );
      const verifyUrl = `${req.protocol}://${req.get('host')}/verify-email.html?token=${token}`;
      sendEmail({
        to: newEmail.toLowerCase(),
        subject: 'Verify your new Eagle I email',
        html: `<p><a href="${verifyUrl}">Confirm your new email address</a>.</p>`,
        text: `Confirm your new email address: ${verifyUrl}`
      }).catch(err => console.warn('Verification email not sent:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to change email: ' + err.message } });
    }
  });

  app.delete('/api/auth/account', async (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: { message: 'Not logged in.' } });
    }
    const { password } = req.body || {};
    try {
      const userRes = await query('SELECT password_hash, tenant_id FROM users WHERE id = $1', [req.session.userId]);
      if (!userRes.rows.length) return res.status(404).json({ error: { message: 'Account not found.' } });
      const valid = await bcrypt.compare(password || '', userRes.rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: { message: 'Password is incorrect.' } });

      // Every tenant-scoped table has ON DELETE CASCADE back to tenants, so
      // deleting the tenant row removes all of this account's data in one go.
      await query('DELETE FROM tenants WHERE id = $1', [userRes.rows[0].tenant_id]);
      req.session.destroy(() => res.json({ ok: true }));
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to delete account: ' + err.message } });
    }
  });
}

module.exports = { sessionMiddleware, requireAuth, requireAdmin, registerAuthRoutes };
