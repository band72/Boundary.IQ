/**
 * db/users.js — User CRUD, password management, and usage tracking.
 */

import crypto from 'crypto';
import { getDb, now } from './core.js';
import { upsertSubscription } from './subscriptions.js';

// ── Password hashing ──────────────────────────────────────────────────────────

// NIST SP 800-132 recommends ≥ 210,000 iterations for PBKDF2-SHA-512.
// We use 310,000 to stay comfortably above the 2025 guideline.
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_LEGACY_ITERATIONS = 1_000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return { valid: false, needsRehash: false };
  const [salt, originalHash] = storedHash.split(':');
  const tryVerify = (iterations) =>
    crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex') === originalHash;

  if (tryVerify(PBKDF2_ITERATIONS)) return { valid: true, needsRehash: false };
  if (tryVerify(PBKDF2_LEGACY_ITERATIONS)) {
    console.warn('[Auth] Upgrading legacy 1k-iteration password hash to current strength.');
    return { valid: true, needsRehash: true, newHash: hashPassword(password) };
  }
  return { valid: false, needsRehash: false };
}

// ── User CRUD ─────────────────────────────────────────────────────────────────

export function createUser(username, password, role = null, plan = 'free') {
  const db = getDb();
  const existing = db.prepare('SELECT Id FROM Users WHERE Username = ? COLLATE NOCASE').get(username);
  if (existing) throw new Error('Username already exists');

  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM Users').get().c;
  let effectiveRole = role;
  if (!effectiveRole) {
    if (totalUsers === 0) {
      effectiveRole = 'admin';
    } else if (adminEmail && username.toLowerCase() === adminEmail) {
      effectiveRole = 'admin';
    } else {
      effectiveRole = 'user';
    }
  }

  const passwordHash = hashPassword(password);
  const result = db.prepare('INSERT INTO Users (Username, PasswordHash, Role, Plan, Timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(username, passwordHash, effectiveRole, plan, now());

  return { id: result.lastInsertRowid, username, role: effectiveRole, plan };
}

export function verifyUser(username, password) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM Users WHERE Username = ? COLLATE NOCASE').get(username);
  if (!row) return null;
  const { valid, needsRehash, newHash } = verifyPassword(password, row.PasswordHash);
  if (!valid) return null;
  if (needsRehash && newHash) {
    db.prepare('UPDATE Users SET PasswordHash = ? WHERE Id = ?').run(newHash, row.Id);
  }
  touchLastLogin(row.Id);
  return { id: row.Id, username: row.Username, role: row.Role, plan: row.Plan || 'free' };
}

export function findUserByUsername(username) {
  const db = getDb();
  const row = db.prepare('SELECT Id as id, Username as username, Role as role, Plan as plan FROM Users WHERE Username = ? COLLATE NOCASE').get(username);
  return row ? { id: row.id, username: row.username, role: row.role, plan: row.plan || 'free' } : null;
}

export function getAllUsers() {
  const db = getDb();
  return db.prepare(`
    SELECT u.Id as id, u.Username as username, u.Role as role, u.Plan as plan,
           u.Timestamp as createdAt, u.LastLogin as lastLogin, u.DisplayName as displayName,
           s.Status as subStatus, s.PeriodEnd as subPeriodEnd, s.StripeCustomerId as stripeCustomerId,
           COALESCE(SUM(t.TotalTokens), 0) as totalTokens
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id
    LEFT JOIN TokenUsage t ON t.UserId = u.Id
    GROUP BY u.Id
    ORDER BY u.Timestamp DESC
  `).all().map(r => ({
    id: r.id, username: r.username, role: r.role, plan: r.plan || 'free',
    createdAt: r.createdAt, lastLogin: r.lastLogin, displayName: r.displayName,
    subStatus: r.subStatus, subPeriodEnd: r.subPeriodEnd, stripeCustomerId: r.stripeCustomerId,
    totalTokens: r.totalTokens,
  }));
}

export function getUserById(userId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT u.Id as id, u.Username as username, u.Role as role, u.Plan as plan,
           u.Timestamp as createdAt, u.LastLogin as lastLogin, u.DisplayName as displayName,
           s.Status as subStatus, s.PeriodEnd as subPeriodEnd, s.StripeCustomerId as stripeCustomerId,
           s.StripeSubscriptionId as stripeSubscriptionId
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id
    WHERE u.Id = ?
  `).get(userId);
  if (!row) return null;
  return {
    id: row.id, username: row.username, role: row.role, plan: row.plan || 'free',
    createdAt: row.createdAt, lastLogin: row.lastLogin, displayName: row.displayName,
    subStatus: row.subStatus, subPeriodEnd: row.subPeriodEnd,
    stripeCustomerId: row.stripeCustomerId, stripeSubscriptionId: row.stripeSubscriptionId,
  };
}

export function updateUserRole(userId, role) {
  const allowed = ['user', 'pro', 'admin'];
  if (!allowed.includes(role)) throw new Error(`Invalid role: ${role}`);
  getDb().prepare('UPDATE Users SET Role = ? WHERE Id = ?').run(role, userId);
}

export function updateUserPlan(userId, plan) {
  const db = getDb();
  const allowed = ['free', 'pro', 'enterprise'];
  if (!allowed.includes(plan)) throw new Error(`Invalid plan: ${plan}`);
  db.prepare('UPDATE Users SET Plan = ? WHERE Id = ?').run(plan, userId);
  upsertSubscription(userId, {
    plan,
    status: plan === 'free' ? 'inactive' : 'active',
    periodEnd: plan === 'free' ? null : new Date(Date.now() + 365 * 86400000).toISOString(),
  });
}

export function touchLastLogin(userId) {
  getDb().prepare('UPDATE Users SET LastLogin = ? WHERE Id = ?').run(now(), userId);
}

export function getUserCount() {
  return getDb().prepare('SELECT COUNT(*) as c FROM Users').get().c;
}

export function deleteUser(userId) {
  const result = getDb().prepare('DELETE FROM Users WHERE Id = ?').run(userId);
  return result.changes > 0;
}

export function updateProfile(userId, { displayName } = {}) {
  getDb().prepare('UPDATE Users SET DisplayName = ? WHERE Id = ?').run(displayName || null, userId);
}

export function updatePassword(userId, newPassword) {
  const hash = hashPassword(newPassword);
  getDb().prepare('UPDATE Users SET PasswordHash = ?, ForceResetPw = 0 WHERE Id = ?').run(hash, userId);
}

export function forceResetPassword(userId) {
  const db = getDb();
  const tempPw = crypto.randomBytes(6).toString('hex'); // 12-char hex
  const hash = hashPassword(tempPw);
  db.prepare('UPDATE Users SET PasswordHash = ?, ForceResetPw = 1 WHERE Id = ?').run(hash, userId);
  db.prepare('DELETE FROM Sessions WHERE UserId = ?').run(userId);
  return tempPw;
}

export function verifyPasswordOnly(userId, password) {
  const row = getDb().prepare('SELECT PasswordHash FROM Users WHERE Id = ?').get(userId);
  if (!row) return false;
  return verifyPassword(password, row.PasswordHash).valid;
}

export function checkForceReset(userId) {
  const row = getDb().prepare('SELECT ForceResetPw FROM Users WHERE Id = ?').get(userId);
  return row?.ForceResetPw === 1;
}

// ── Usage tracking ─────────────────────────────────────────────────────────────

export const FREE_DAILY_DEED_LIMIT = 5;

export function getDailyUsage(userId) {
  const db = getDb();
  const date = now().slice(0, 10);
  const row = db.prepare('SELECT DeedSolves FROM UsageTracking WHERE UserId = ? AND Date = ?').get(userId, date);
  return row ? row.DeedSolves : 0;
}

export function incrementDailyUsage(userId) {
  const db = getDb();
  const date = now().slice(0, 10);
  db.prepare(`
    INSERT INTO UsageTracking (UserId, Date, DeedSolves) VALUES (?, ?, 1)
    ON CONFLICT(UserId, Date) DO UPDATE SET DeedSolves = DeedSolves + 1
  `).run(userId, date);
}

export function checkDailyLimit(userId, userPlan, userRole) {
  // Admins and paid plans have no daily limit
  if (userRole === 'admin' || userPlan === 'pro' || userPlan === 'enterprise') return { allowed: true, used: null, limit: null };
  const used = getDailyUsage(userId);
  return { allowed: used < FREE_DAILY_DEED_LIMIT, used, limit: FREE_DAILY_DEED_LIMIT };
}

export function getUserDailyStats(userId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return getDb().prepare(`
    SELECT Date as date, DeedSolves as deedSolves
    FROM UsageTracking
    WHERE UserId = ? AND Date >= ?
    ORDER BY Date ASC
  `).all(userId, since);
}

export function getSystemStats() {
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) as c FROM Users').get().c;
  const proCount = db.prepare("SELECT COUNT(*) as c FROM Users WHERE Plan != 'free'").get().c;
  const sessionCount = db.prepare('SELECT COUNT(*) as c FROM Sessions WHERE ExpiresAt > ?').get(now()).c;
  const todayDate = now().slice(0, 10);
  const todaySolves = db.prepare('SELECT COALESCE(SUM(DeedSolves),0) as s FROM UsageTracking WHERE Date = ?').get(todayDate).s;
  const totalSolves = db.prepare('SELECT COALESCE(SUM(DeedSolves),0) as s FROM UsageTracking').get().s;
  return { userCount, proCount, sessionCount, todaySolves, totalSolves };
}
