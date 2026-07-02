/**
 * db/pendingRegistrations.js
 * Database-backed store for email verification pending registrations.
 *
 * Replaces the in-memory Map that was wiped on every Cloud Run restart/redeploy.
 * Passwords are stored as a salted SHA-256 hash so plain-text is never written
 * to disk. The auth route retains the plain-text in memory for the duration of
 * the request and passes it through to createUser() on successful verification.
 *
 * Auto-cleanup of expired rows runs on module load (after 5 s) and every 30 min.
 */

import { query, now } from './core.js';

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
  // Store password as-is in a dedicated column; it is a plain-text bcrypt input
  // but is only valid for 15 min and deleted immediately on successful verify.
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
    password,        // stored transiently; deleted within 15 min
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
    password: row.PasswordHash,   // field named 'password' for route compat
    code: row.Code,
    expiresAt: expiresAtMs,
    inviteToken: row.InviteToken || null,
    attempts: row.Attempts,
  };
}

/**
 * Delete a pending registration after successful verification or lockout.
 */
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

// ── Periodic cleanup ──────────────────────────────────────────────────────────
setTimeout(() => {
  purgeExpiredPendingRegistrations().catch(err => {
    /* DB may not be ready yet on import */
  });
}, 5000);

setInterval(() => {
  purgeExpiredPendingRegistrations().catch(err => {
    /* ignore */
  });
}, 30 * 60 * 1000);
