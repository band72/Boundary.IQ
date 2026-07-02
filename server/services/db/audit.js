/**
 * db/audit.js — Audit log writes and reads.
 */

import { query, now } from './core.js';

/**
 * Write an audit event. Errors are swallowed so a broken audit table
 * never causes a user-facing failure.
 */
export async function logAudit({ userId = null, actorId = null, action, target = null, detail = null, ipAddress = null } = {}) {
  try {
    await query(`
      INSERT INTO AuditLog (UserId, ActorId, Action, Target, Detail, IpAddress, Timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [userId, actorId, action, target, detail ? JSON.stringify(detail) : null, ipAddress, now()]);
  } catch (e) {
    console.warn('[AuditLog] Write failed:', e.message);
  }
}

export async function getAuditLog({ limit = 100, offset = 0, userId = null, action = null } = {}) {
  let sql = `
    SELECT a.Id, a.Action, a.Target, a.Detail, a.IpAddress, a.Timestamp,
           u.Username as username, actor.Username as actorUsername
    FROM AuditLog a
    LEFT JOIN Users u ON u.Id = a.UserId
    LEFT JOIN Users actor ON actor.Id = a.ActorId
  `;
  const params = [];
  const conditions = [];
  if (userId) { conditions.push('a.UserId = ?'); params.push(userId); }
  if (action) { conditions.push('a.Action = ?'); params.push(action); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY a.Timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const res = await query(sql, params);
  return res.rows.map(r => ({
    id: r.Id,
    action: r.Action,
    target: r.Target,
    detail: r.Detail ? (() => { try { return typeof r.Detail === 'string' ? JSON.parse(r.Detail) : r.Detail; } catch { return r.Detail; } })() : null,
    ipAddress: r.IpAddress,
    timestamp: r.Timestamp,
    username: r.username,
    actorUsername: r.actorUsername,
  }));
}
