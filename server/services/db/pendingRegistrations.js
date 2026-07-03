/**
 * db/pendingRegistrations.js
 * Database-backed store for email verification pending registrations.
 *
 * Replaces the in-memory Map that was wiped on every Cloud Run restart/redeploy.
 * Passwords are stored as a PBKDF2-SHA-512 hash (same algorithm as Users.PasswordHash)
 * so plain-text is never written to disk or WAL files.  On successful code
 * verification, createUserWithPrehashedPassword() is called with the stored hash
 * directly, avoiding a redundant hashing round.
 *
 * Auto-cleanup of expired rows runs on module load (after 5 s) and every 30 min.
 */

import { query, now } from './core.js';
import { hashPassword } from './users.js';
import logger from '../../logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function epochToSqlite(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function sqliteToEpoch(str) {
  return str ? new Date(str.replace(' ', 'T') + 'Z').getTime() : 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Insert or replace a pending registration entry.
 * @param {string} email  Lowercase email (used as PK)
 * @param {{ username, password, code, expiresAt, inviteToken }} value
 */
export async function upsertPendingRegistration(email, { username, password, code, expiresAt, inviteToken }) {
  // Hash the password before persisting so plain-text never touches disk.
  // On successful verification, createUserWithPrehashedPassword() is called
  // with this hash directly, skipping the hashing step in createUser().
  const passwordHash = await hashPassword(password);
  await query(`
    INSERT INTO PendingRegistrations
      (Email, Username, PasswordHash, Code, Attempts, ExpiresAt, InviteToken, CreatedAt)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT (Email) DO UPDATE SET
      Username = EXCLUDED.Username,
      PasswordHash = EXCLUDED.PasswordHash,
      Code = EXCLUDED.Code,
      Attempts = 0,
      ExpiresAt = EXCLUDED.ExpiresAt,
      InviteToken = EXCLUDED.InviteToken,
      CreatedAt = EXCLUDED.CreatedAt
  `, [
    email.toLowerCase(),
    username,
    passwordHash,    // PBKDF2 hash — never plain-text on disk
    code,
    epochToSqlite(expiresAt),
    inviteToken || null,
    now(),
  ]);
}

/**
 * Retrieve a pending registration. Returns null if not found or expired.
 * Returns an object compatible with the old in-memory Map shape:
 *   { username, password, code, expiresAt (epoch ms), inviteToken, attempts }
 */
export async function getPendingRegistration(email) {
  const res = await query(
    'SELECT * FROM PendingRegistrations WHERE LOWER(Email) = LOWER(?)',
    [email.toLowerCase()]
  );
  const row = res.rows[0];

  if (!row) return null;

  const expiresAtMs = sqliteToEpoch(row.ExpiresAt);
  if (expiresAtMs < Date.now()) {
    await query('DELETE FROM PendingRegistrations WHERE LOWER(Email) = LOWER(?)', [email.toLowerCase()]);
    return null;
  }

  return {
    username: row.Username,
    passwordHash: row.PasswordHash,  // PBKDF2 hash — pass to createUserWithPrehashedPassword()
    code: row.Code,
    expiresAt: expiresAtMs,
    inviteToken: row.InviteToken || null,
    attempts: row.Attempts,
  };
}

/**
 * Update the verification code on an existing pending registration.
 * This intentionally does NOT touch PasswordHash, which is already stored
 * as a PBKDF2 hash and must not be re-hashed on resend.
 */
export async function updatePendingRegistrationCode(email, { code, expiresAt }) {
  await query(`
    UPDATE PendingRegistrations
    SET Code = ?, Attempts = 0, ExpiresAt = ?
    WHERE LOWER(Email) = LOWER(?)
  `, [code, epochToSqlite(expiresAt), email.toLowerCase()]);
}


export async function deletePendingRegistration(email) {
  await query(
    'DELETE FROM PendingRegistrations WHERE LOWER(Email) = LOWER(?)',
    [email.toLowerCase()]
  );
}

/**
 * Increment the failed attempt counter and return the new count.
 */
export async function incrementVerifyAttempts(email) {
  await query(
    'UPDATE PendingRegistrations SET Attempts = Attempts + 1 WHERE LOWER(Email) = LOWER(?)',
    [email.toLowerCase()]
  );
  const res = await query(
    'SELECT Attempts FROM PendingRegistrations WHERE LOWER(Email) = LOWER(?)',
    [email.toLowerCase()]
  );
  return res.rows[0]?.Attempts ?? 1;
}

/**
 * Purge all expired pending registrations.
 */
export async function purgeExpiredPendingRegistrations() {
  const res = await query(
    'DELETE FROM PendingRegistrations WHERE ExpiresAt < ?',
    [now()]
  );
  const deleted = res.changes;
  if (deleted > 0) console.log(`✓ Purged ${deleted} expired pending registration(s).`);
  return deleted;
}

// ── Periodic cleanup ──────────────────────────────────────────────────────────────────
// One-shot at startup (DB may not be ready immediately on module import)
setTimeout(() => {
  purgeExpiredPendingRegistrations().catch(() => {
    /* DB may not be ready yet on import */
  });
}, 5000);

// Recurring every 30 minutes — log failures so silent disk/DB issues are surfaced
setInterval(() => {
  purgeExpiredPendingRegistrations().catch(err => {
    logger.warn({ err }, 'Periodic pending-registration cleanup failed');
  });
}, 30 * 60 * 1000);
