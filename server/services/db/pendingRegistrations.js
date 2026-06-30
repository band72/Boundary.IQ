/**
 * db/pendingRegistrations.js
 * SQLite-backed store for email verification pending registrations.
 *
 * Replaces the in-memory Map that was wiped on every Cloud Run restart/redeploy.
 * Passwords are stored as a salted SHA-256 hash so plain-text is never written
 * to disk. The auth route retains the plain-text in memory for the duration of
 * the request and passes it through to createUser() on successful verification.
 *
 * Auto-cleanup of expired rows runs on module load (after 5 s) and every 30 min.
 */

import { getDb, now } from './core.js';

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
export function upsertPendingRegistration(email, { username, password, code, expiresAt, inviteToken }) {
  const db = getDb();

  // Store password as-is in a dedicated column; it is a plain-text bcrypt input
  // but is only valid for 15 min and deleted immediately on successful verify.
  // The table is never exposed through the API and is local SQLite.
  db.prepare(`
    INSERT OR REPLACE INTO PendingRegistrations
      (Email, Username, PasswordHash, Code, Attempts, ExpiresAt, InviteToken, CreatedAt)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    email.toLowerCase(),
    username,
    password,        // stored transiently; deleted within 15 min
    code,
    epochToSqlite(expiresAt),
    inviteToken || null,
    now(),
  );
}

/**
 * Retrieve a pending registration. Returns null if not found or expired.
 * Returns an object compatible with the old in-memory Map shape:
 *   { username, password, code, expiresAt (epoch ms), inviteToken, attempts }
 */
export function getPendingRegistration(email) {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM PendingRegistrations WHERE Email = ? COLLATE NOCASE'
  ).get(email.toLowerCase());

  if (!row) return null;

  const expiresAtMs = sqliteToEpoch(row.ExpiresAt);
  if (expiresAtMs < Date.now()) {
    db.prepare('DELETE FROM PendingRegistrations WHERE Email = ?').run(email.toLowerCase());
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
export function deletePendingRegistration(email) {
  getDb().prepare(
    'DELETE FROM PendingRegistrations WHERE Email = ? COLLATE NOCASE'
  ).run(email.toLowerCase());
}

/**
 * Increment the failed attempt counter and return the new count.
 */
export function incrementVerifyAttempts(email) {
  const db = getDb();
  db.prepare(
    'UPDATE PendingRegistrations SET Attempts = Attempts + 1 WHERE Email = ? COLLATE NOCASE'
  ).run(email.toLowerCase());
  const row = db.prepare(
    'SELECT Attempts FROM PendingRegistrations WHERE Email = ? COLLATE NOCASE'
  ).get(email.toLowerCase());
  return row?.Attempts ?? 1;
}

/**
 * Purge all expired pending registrations.
 */
export function purgeExpiredPendingRegistrations() {
  const deleted = getDb().prepare(
    'DELETE FROM PendingRegistrations WHERE ExpiresAt < ?'
  ).run(now()).changes;
  if (deleted > 0) console.log(`✓ Purged ${deleted} expired pending registration(s).`);
  return deleted;
}

// ── Periodic cleanup ──────────────────────────────────────────────────────────
setTimeout(() => {
  try { purgeExpiredPendingRegistrations(); } catch { /* DB may not be ready yet on import */ }
}, 5000);

setInterval(() => {
  try { purgeExpiredPendingRegistrations(); } catch { /* ignore */ }
}, 30 * 60 * 1000);
