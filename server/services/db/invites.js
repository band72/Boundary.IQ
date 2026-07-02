/**
 * db/invites.js — Invite token creation, redemption, and management.
 */

import crypto from 'crypto';
import { query, now } from './core.js';

export async function createInviteToken({ createdByUserId, email = null, note = null, expiresInHours = 72 } = {}) {
  const token = crypto.randomBytes(20).toString('hex'); // 40-char
  const expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString();
  await query(`
    INSERT INTO InviteTokens (Token, CreatedByUserId, Email, Note, ExpiresAt, CreatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [token, createdByUserId, email || null, note || null, expiresAt, now()]);
  return token;
}

export async function getInviteToken(token) {
  const res = await query(`
    SELECT it.*, u.Username as createdByUsername
    FROM InviteTokens it
    JOIN Users u ON u.Id = it.CreatedByUserId
    WHERE it.Token = ?
  `, [token]);
  const row = res.rows[0];
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

export async function redeemInviteToken(token, newUserId) {
  const res = await query('SELECT * FROM InviteTokens WHERE Token = ?', [token]);
  const row = res.rows[0];
  if (!row) return { valid: false, reason: 'Token not found' };
  if (row.UsedByUserId) return { valid: false, reason: 'Token already used' };
  if (row.ExpiresAt < now()) return { valid: false, reason: 'Token expired' };
  await query('UPDATE InviteTokens SET UsedByUserId = ?, UsedAt = ? WHERE Token = ?',
    [newUserId, now(), token]);
  return { valid: true, email: row.Email };
}

export async function listInvites(createdByUserId = null) {
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
  if (createdByUserId) {
    sql += ' WHERE it.CreatedByUserId = ?';
    params.push(createdByUserId);
  }
  sql += ' ORDER BY it.CreatedAt DESC';
  const res = await query(sql, params);
  return res.rows.map(r => ({
    token: r.Token, email: r.Email, note: r.Note,
    expiresAt: r.ExpiresAt, createdAt: r.CreatedAt,
    usedAt: r.UsedAt, usedByUsername: r.usedByUsername,
    createdByUsername: r.createdByUsername,
    expired: r.ExpiresAt < now(),
    used: !!r.UsedByUserId,
  }));
}

export async function revokeInviteToken(token) {
  await query('DELETE FROM InviteTokens WHERE Token = ?', [token]);
}
