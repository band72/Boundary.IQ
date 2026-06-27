/**
 * db/sessions.js — Session creation, retrieval, revocation, and expiry.
 */

import crypto from 'crypto';
import { getDb, now } from './core.js';

export function createSession(userId, { ipAddress = null, userAgent = null } = {}) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO Sessions (Token, UserId, ExpiresAt, IpAddress, UserAgent, CreatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, userId, expiresAt, ipAddress, userAgent, now());
  return token;
}

export function getSession(token) {
  const db = getDb();
  // Fast-reject malformed tokens (expected: 64-char hex from randomBytes(32))
  if (!token || typeof token !== 'string' || token.length !== 64 || !/^[0-9a-f]+$/i.test(token)) {
    return null;
  }

  const row = db.prepare(`
    SELECT s.Token, s.ExpiresAt, u.Id as UserId, u.Username, u.Role, u.Plan
    FROM Sessions s
    INNER JOIN Users u ON s.UserId = u.Id
    WHERE s.Token = ?
  `).get(token);

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
    db.prepare('DELETE FROM Sessions WHERE Token = ?').run(token);
    return null;
  }

  return { userId: row.UserId, username: row.Username, role: row.Role, plan: row.Plan || 'free' };
}

export function deleteSession(token) {
  getDb().prepare('DELETE FROM Sessions WHERE Token = ?').run(token);
}

export function purgeExpiredSessions() {
  const deleted = getDb().prepare('DELETE FROM Sessions WHERE ExpiresAt < ?').run(now()).changes;
  if (deleted > 0) console.log(`✓ Purged ${deleted} expired session(s).`);
  return deleted;
}

export function getUserSessions(userId) {
  return getDb().prepare(`
    SELECT Token, ExpiresAt, IpAddress, UserAgent, CreatedAt
    FROM Sessions
    WHERE UserId = ?
    ORDER BY CreatedAt DESC
  `).all(userId).map(s => {
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

export function revokeSession(token) {
  getDb().prepare('DELETE FROM Sessions WHERE Token = ?').run(token);
}

export function revokeAllUserSessions(userId) {
  return getDb().prepare('DELETE FROM Sessions WHERE UserId = ?').run(userId).changes;
}

export function revokeAllUserSessionsExcept(userId, keepToken) {
  return getDb().prepare('DELETE FROM Sessions WHERE UserId = ? AND Token != ?').run(userId, keepToken).changes;
}
