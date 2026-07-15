/**
 * db/licenseKeys.js
 * License key issuance, validation, and redemption.
 *
 * Keys are formatted as: BIQ-XXXX-XXXX-XXXX-XXXX (20 random hex chars in groups)
 * Only the SHA-256 hash of the key is stored, so even a DB leak exposes nothing.
 *
 * Plans: 'basic' | 'pro' | 'enterprise'
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { query, now } from './core.js';

const VALID_PLANS = ['basic', 'pro', 'enterprise'];

// ── Internal ──────────────────────────────────────────────────────────────────

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey.trim().toUpperCase()).digest('hex');
}

// ── Key generation ────────────────────────────────────────────────────────────

/**
 * Generate a formatted license key string: BIQ-XXXX-XXXX-XXXX-XXXX
 * Does NOT persist it — caller must call createLicenseKey() to store it.
 */
export function generateKeyString() {
  const hex = crypto.randomBytes(10).toString('hex').toUpperCase();
  return `BIQ-${hex.slice(0,4)}-${hex.slice(4,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}`;
}

/**
 * Create and persist a license key.
 * @param {{ plan, createdByUserId, note, expiresInDays }} opts
 * @returns {{ rawKey, plan, expiresAt }}
 */
export async function createLicenseKey({ plan = 'pro', createdByUserId = null, note = null, expiresInDays = null } = {}) {
  if (!VALID_PLANS.includes(plan)) throw new Error(`Invalid plan: ${plan}`);

  const rawKey = generateKeyString();
  const keyHash = hashKey(rawKey);
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString().replace('T', ' ').slice(0, 19)
    : null;

  await query(`
    INSERT INTO LicenseKeys (KeyHash, Plan, CreatedByUserId, ExpiresAt, Note, CreatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [keyHash, plan, createdByUserId, expiresAt, note, now()]);

  return { rawKey, plan, expiresAt };
}

// ── Redemption ────────────────────────────────────────────────────────────────

/**
 * Attempt to redeem a license key for a user.
 * Returns { ok: true, plan } on success or { ok: false, error } on failure.
 */
export async function redeemLicenseKey(rawKey, userId) {
  const keyHash = hashKey(rawKey);

  const res = await query(
    'SELECT * FROM LicenseKeys WHERE KeyHash = ?',
    [keyHash]
  );
  const row = res.rows[0];

  if (!row) return { ok: false, error: 'License key not found. Please check and try again.' };

  if (row.RedeemedByUserId) {
    // Allow the same user to view their own key status (idempotent redeem)
    if (row.RedeemedByUserId === userId) {
      return { ok: true, plan: row.Plan, alreadyOwner: true };
    }
    return { ok: false, error: 'This license key has already been redeemed.' };
  }

  if (row.ExpiresAt && new Date(row.ExpiresAt.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    return { ok: false, error: 'This license key has expired.' };
  }

  // Mark as redeemed
  await query(`
    UPDATE LicenseKeys SET RedeemedByUserId = ?, RedeemedAt = ?
    WHERE KeyHash = ?
  `, [userId, now(), keyHash]);

  return { ok: true, plan: row.Plan };
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Get all license keys redeemed by a user (for display in settings).
 */
export async function getLicenseKeysForUser(userId) {
  const res = await query(`
    SELECT Plan, RedeemedAt, ExpiresAt, Note
    FROM LicenseKeys
    WHERE RedeemedByUserId = ?
    ORDER BY RedeemedAt DESC
  `, [userId]);
  return res.rows;
}

/**
 * Admin: list all license keys (hashes masked for security).
 */
export async function listAllLicenseKeys() {
  const res = await query(`
    SELECT
      Plan, Note,
      RedeemedByUserId, RedeemedAt,
      ExpiresAt, CreatedAt, CreatedByUserId, KeyHash
    FROM LicenseKeys
    ORDER BY CreatedAt DESC
  `);
  return res.rows.map(r => {
    const hash = r.KeyHash || '';
    return {
      keyPrefix: hash.substring(0, 8) + '…',
      Plan: r.Plan,
      Note: r.Note,
      RedeemedByUserId: r.RedeemedByUserId,
      RedeemedAt: r.RedeemedAt,
      ExpiresAt: r.ExpiresAt,
      CreatedAt: r.CreatedAt,
      CreatedByUserId: r.CreatedByUserId,
    };
  });
}

// ── Private Key Env Persistence ───────────────────────────────────────────────

function saveEnvVar(key, val) {
  const paths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'server', '.env'),
  ];
  let written = false;
  for (const envPath of paths) {
    if (!fs.existsSync(envPath)) continue;
    let envContent = '';
    try {
      envContent = fs.readFileSync(envPath, 'utf8');
    } catch (e) {
      continue;
    }
    const lines = envContent.split(/\r?\n/);
    const vars = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      vars[k] = v;
    }
    vars[key] = val;
    const newLines = ['# Boundary.IQ — Environment Variables'];
    for (const [k, v] of Object.entries(vars)) {
      newLines.push(`${k}=${v}`);
    }
    const envTmpPath = envPath + '.tmp';
    try {
      fs.writeFileSync(envTmpPath, newLines.join('\n') + '\n', 'utf8');
      fs.renameSync(envTmpPath, envPath);
      written = true;
    } catch (e) {
      // Read-only filesystem (e.g. Cloud Run) — log clearly so operators know to set the env var manually
      console.warn(`[LicenseKeys] Could not persist ${key} to ${envPath}: ${e.message}`);
    }
  }
  return written;
}

export function getOrCreateLicensePrivateKey() {
  let keyBase64 = process.env.LICENSE_PRIVATE_KEY;
  if (!keyBase64) {
    // Generate a new RSA-2048 key pair for this process lifetime.
    // IMPORTANT: If this warning appears in production, set LICENSE_PRIVATE_KEY in your
    // environment variables (.env or Cloud Run secret) so the key survives restarts.
    // Keys generated here are lost when the process exits unless written to .env successfully.
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    keyBase64 = Buffer.from(privateKey).toString('base64');
    process.env.LICENSE_PRIVATE_KEY = keyBase64;
    const persisted = saveEnvVar('LICENSE_PRIVATE_KEY', keyBase64);
    if (!persisted) {
      console.warn(
        '[LicenseKeys] ⚠ LICENSE_PRIVATE_KEY was auto-generated but could NOT be persisted to .env\n' +
        '  (filesystem may be read-only — e.g. Cloud Run). Add LICENSE_PRIVATE_KEY to your environment\n' +
        '  secrets to ensure signed license keys survive server restarts.'
      );
    }
  }
  return Buffer.from(keyBase64, 'base64').toString('utf8');
}

// ── User Specific Key Generation & Retrieval ──────────────────────────────────

/**
 * Create a signed license key for a specific user and plan.
 * The rawKey is returned to the caller for one-time display but is NOT stored
 * in the database — only the SHA-256 hash is persisted to prevent key leakage
 * from a database breach.
 */
export async function createSignedLicenseKeyForUser({ plan, userId, createdByUserId = null } = {}) {
  if (!VALID_PLANS.includes(plan)) throw new Error(`Invalid plan: ${plan}`);

  const privateKeyPem = getOrCreateLicensePrivateKey();
  const payload = JSON.stringify({
    plan,
    userId,
    createdAt: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex')
  });

  const signer = crypto.createSign('sha256');
  signer.update(payload);
  signer.end();
  const signature = signer.sign(privateKeyPem, 'base64url');

  const payloadB64 = Buffer.from(payload).toString('base64url');
  const rawKey = `BIQ-${plan.toUpperCase()}-${payloadB64}.${signature}`;
  const keyHash = hashKey(rawKey);

  // Store only the hash — rawKey is returned to the caller for one-time display only.
  await query(`
    INSERT INTO LicenseKeys (KeyHash, Plan, CreatedByUserId, RedeemedByUserId, RedeemedAt, Note, CreatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    keyHash,
    plan,
    createdByUserId,
    userId,
    now(),
    `Generated for user ID ${userId} (${plan})`,
    now(),
  ]);

  return { rawKey, plan };
}

/**
 * Retrieve the active license key metadata for a specific user.
 * Note: the raw key is never returned here — it is shown only once at generation time.
 */
export async function getActiveLicenseKeyForUser(userId) {
  const res = await query(`
    SELECT Plan, RedeemedAt, ExpiresAt, Note
    FROM LicenseKeys
    WHERE RedeemedByUserId = ?
    ORDER BY CreatedAt DESC, RedeemedAt DESC LIMIT 1
  `, [userId]);
  return res.rows[0] || null;
}
