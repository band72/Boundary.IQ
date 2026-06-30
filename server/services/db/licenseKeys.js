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
import { getDb, now } from './core.js';

const VALID_PLANS = ['basic', 'pro', 'enterprise'];

// ── Internal ──────────────────────────────────────────────────────────────────

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey.trim().toUpperCase()).digest('hex');
}

function epochToSqlite(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function sqliteToEpoch(str) {
  return str ? new Date(str.replace(' ', 'T') + 'Z').getTime() : null;
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
export function createLicenseKey({ plan = 'pro', createdByUserId = null, note = null, expiresInDays = null } = {}) {
  if (!VALID_PLANS.includes(plan)) throw new Error(`Invalid plan: ${plan}`);

  const rawKey = generateKeyString();
  const keyHash = hashKey(rawKey);
  const expiresAt = expiresInDays
    ? epochToSqlite(Date.now() + expiresInDays * 86400000)
    : null;

  getDb().prepare(`
    INSERT INTO LicenseKeys (KeyHash, Plan, CreatedByUserId, ExpiresAt, Note, CreatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(keyHash, plan, createdByUserId, expiresAt, note, now());

  return { rawKey, plan, expiresAt };
}

// ── Redemption ────────────────────────────────────────────────────────────────

/**
 * Attempt to redeem a license key for a user.
 * Returns { ok: true, plan } on success or { ok: false, error } on failure.
 */
export function redeemLicenseKey(rawKey, userId) {
  const db = getDb();
  const keyHash = hashKey(rawKey);

  const row = db.prepare(
    'SELECT * FROM LicenseKeys WHERE KeyHash = ?'
  ).get(keyHash);

  if (!row) return { ok: false, error: 'License key not found. Please check and try again.' };

  if (row.RedeemedByUserId) {
    // Allow the same user to view their own key status (idempotent redeem)
    if (row.RedeemedByUserId === userId) {
      return { ok: true, plan: row.Plan, alreadyOwner: true };
    }
    return { ok: false, error: 'This license key has already been redeemed.' };
  }

  if (row.ExpiresAt && sqliteToEpoch(row.ExpiresAt) < Date.now()) {
    return { ok: false, error: 'This license key has expired.' };
  }

  // Mark as redeemed
  db.prepare(`
    UPDATE LicenseKeys SET RedeemedByUserId = ?, RedeemedAt = ?
    WHERE KeyHash = ?
  `).run(userId, now(), keyHash);

  return { ok: true, plan: row.Plan };
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Get all license keys redeemed by a user (for display in settings).
 */
export function getLicenseKeysForUser(userId) {
  return getDb().prepare(`
    SELECT Plan, RedeemedAt, ExpiresAt, Note
    FROM LicenseKeys
    WHERE RedeemedByUserId = ?
    ORDER BY RedeemedAt DESC
  `).all(userId);
}

/**
 * Admin: list all license keys (hashes masked for security).
 */
export function listAllLicenseKeys() {
  return getDb().prepare(`
    SELECT
      substr(KeyHash, 1, 8) || '…' AS keyPrefix,
      Plan, Note,
      RedeemedByUserId, RedeemedAt,
      ExpiresAt, CreatedAt, CreatedByUserId
    FROM LicenseKeys
    ORDER BY CreatedAt DESC
  `).all();
}
