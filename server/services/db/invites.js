/**
 * db/invites.js — Invite token creation, redemption, and management.
 */

import crypto from 'crypto';
import { getDb, now } from './core.js';

export function createInviteToken({ createdByUserId, email = null, note = null, expiresInHours = 72 } = {}) {
  const db = getDb();
  const token = crypto.randomBytes(20).toString('hex'); // 40-char
  const expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString();
  db.prepare(`
    INSERT INTO InviteTokens (Token, CreatedByUserId, Email, Note, ExpiresAt, CreatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, createdByUserId, email || null, note || null, expiresAt, now());
  return token;
}

export function getInviteToken(token) {
  const db = getDb();
  const row = db.prepare(`
    SELECT it.*, u.Username as createdByUsername
    FROM InviteTokens it
    JOIN Users u ON u.Id = it.CreatedByUserId
    WHERE it.Token = ?
  `).get(token);
  if (!row) return null;
  return {
    token: row.Token, email: row.Email, note: row.Note,
    usedByUserId: row.UsedByUserId, usedAt: row.UsedAt,
    expiresAt: row.ExpiresAt, createdAt: row.CreatedAt,
    createdByUsername: row.createdByUsername,
    expired: row.ExpiresAt < now(),
    used: !!row.UsedByUserId,
  };
}

export function redeemInviteToken(token, newUserId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM InviteTokens WHERE Token = ?').get(token);
  if (!row) return { valid: false, reason: 'Token not found' };
  if (row.UsedByUserId) return { valid: false, reason: 'Token already used' };
  if (row.ExpiresAt < now()) return { valid: false, reason: 'Token expired' };
  db.prepare('UPDATE InviteTokens SET UsedByUserId = ?, UsedAt = ? WHERE Token = ?')
    .run(newUserId, now(), token);
  return { valid: true, email: row.Email };
}

export function listInvites(createdByUserId = null) {
  let sql = `
    SELECT it.Token, it.Email, it.Note, it.ExpiresAt, it.CreatedAt,
           it.UsedAt, it.UsedByUserId,
           creator.Username as createdByUsername,
           used_user.Username as usedByUsername
    FROM InviteTokens it
    JOIN Users creator ON creator.Id = it.CreatedByUserId
    LEFT JOIN Users used_user ON used_user.Id = it.UsedByUserId
  `;
  const params = [];
  if (createdByUserId) { sql += ' WHERE it.CreatedByUserId = ?'; params.push(createdByUserId); }
  sql += ' ORDER BY it.CreatedAt DESC';
  return getDb().prepare(sql).all(...params).map(r => ({
    token: r.Token, email: r.Email, note: r.Note,
    expiresAt: r.ExpiresAt, createdAt: r.CreatedAt,
    usedAt: r.UsedAt, usedByUsername: r.usedByUsername,
    createdByUsername: r.createdByUsername,
    expired: r.ExpiresAt < now(),
    used: !!r.UsedByUserId,
  }));
}

export function revokeInviteToken(token) {
  getDb().prepare('DELETE FROM InviteTokens WHERE Token = ?').run(token);
}
