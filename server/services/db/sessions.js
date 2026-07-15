/**
 * db/sessions.js — Session creation, retrieval, revocation, and expiry.
 */

import crypto from 'crypto';
import { query, now } from './core.js';

export async function createSession(userId, { ipAddress = null, userAgent = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  await query(
    'INSERT INTO Sessions (Token, UserId, ExpiresAt, IpAddress, UserAgent, CreatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    [token, userId, expiresAt, ipAddress, userAgent, now()]
  );
  return token;
}

export async function getSession(token) {
  // Fast-reject malformed tokens (expected: 64-char hex from randomBytes(32))
  if (!token || typeof token !== 'string' || token.length !== 64 || !/^[0-9a-f]+$/i.test(token)) {
    return null;
  }

  const res = await query(`
    SELECT s.Token, s.ExpiresAt, u.Id as UserId, u.Username, u.Role, u.Plan
    FROM Sessions s
    INNER JOIN Users u ON s.UserId = u.Id
    WHERE s.Token = ?
  `, [token]);
  const row = res.rows[0];

  if (!row) return null;

  // Timing-safe token comparison (prevents timing-oracle attacks)
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(token.toLowerCase(), 'hex'),
      Buffer.from(row.Token.toLowerCase(), 'hex')
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  // Check expiration
  if (row.ExpiresAt < now()) {
    await query('DELETE FROM Sessions WHERE Token = ?', [token]);
    return null;
  }

  return { userId: row.UserId, username: row.Username, role: row.Role, plan: row.Plan || 'free' };
}

/** Remove a specific session token. Alias kept for backward compatibility. */
export async function deleteSession(token) {
  return revokeSession(token);
}

export async function purgeExpiredSessions() {
  const res = await query('DELETE FROM Sessions WHERE ExpiresAt < ?', [now()]);
  const deleted = res.changes;
  if (deleted > 0) console.log(`✓ Purged ${deleted} expired session(s).`);
  return deleted;
}

export async function getUserSessions(userId) {
  const res = await query(`
    SELECT Token, ExpiresAt, IpAddress, UserAgent, CreatedAt
    FROM Sessions
    WHERE UserId = ?
    ORDER BY CreatedAt DESC
  `, [userId]);

  return res.rows.map(s => {
    const tok = s.Token || '';
    return {
      token: tok.substring(0, 8) + '…', // masked for security
      tokenPrefix: tok.substring(0, 8),
      fullToken: s.Token,
      expiresAt: s.ExpiresAt,
      ipAddress: s.IpAddress,
      userAgent: s.UserAgent,
      createdAt: s.CreatedAt,
    };
  });
}

export async function revokeSession(token) {
  await query('DELETE FROM Sessions WHERE Token = ?', [token]);
}

export async function revokeAllUserSessions(userId) {
  const res = await query('DELETE FROM Sessions WHERE UserId = ?', [userId]);
  return res.changes;
}

export async function revokeAllUserSessionsExcept(userId, keepToken) {
  const res = await query('DELETE FROM Sessions WHERE UserId = ? AND Token != ?', [userId, keepToken]);
  return res.changes;
}
