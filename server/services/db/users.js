/**
 * db/users.js — User CRUD, password management, and usage tracking.
 */

import crypto from 'crypto';
import { query, now } from './core.js';
import { upsertSubscription } from './subscriptions.js';

// ── Password hashing ──────────────────────────────────────────────────────────

// NIST SP 800-132 recommends ≥ 210,000 iterations for PBKDF2-SHA-512.
// We use 310,000 to stay comfortably above the 2025 guideline.
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_LEGACY_ITERATIONS = 1_000;

/** Async PBKDF2 helper — does not block the event loop. */
function pbkdf2Async(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 64, 'sha512', (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await pbkdf2Async(password, salt, PBKDF2_ITERATIONS);
  return `${salt}:${hash}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return { valid: false, needsRehash: false };
  const [salt, originalHash] = storedHash.split(':');

  if (await pbkdf2Async(password, salt, PBKDF2_ITERATIONS) === originalHash) {
    return { valid: true, needsRehash: false };
  }
  if (await pbkdf2Async(password, salt, PBKDF2_LEGACY_ITERATIONS) === originalHash) {
    console.warn('[Auth] Upgrading legacy 1k-iteration password hash to current strength.');
    return { valid: true, needsRehash: true, newHash: await hashPassword(password) };
  }
  return { valid: false, needsRehash: false };
}

// ── User CRUD ─────────────────────────────────────────────────────────────────

export async function createUser(username, password, role = null, plan = 'free') {
  const existingRes = await query('SELECT Id FROM Users WHERE LOWER(Username) = LOWER(?)', [username]);
  if (existingRes.rows[0]) throw new Error('Username already exists');

  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const countRes = await query('SELECT COUNT(*) as c FROM Users');
  const totalUsers = parseInt(countRes.rows[0].c || 0);
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

  const passwordHash = await hashPassword(password);
  const result = await query(
    'INSERT INTO Users (Username, PasswordHash, Role, Plan, Timestamp) VALUES (?, ?, ?, ?, ?) RETURNING Id',
    [username, passwordHash, effectiveRole, plan, now()]
  );

  const insertedId = result.rows[0]?.Id || result.rows[0]?.id;
  return { id: insertedId, username, role: effectiveRole, plan };
}

/**
 * Create a user with a password that has already been hashed by hashPassword().
 * Used by the email verification flow where the hash was stored before DB insertion.
 * Skips the hashing step so the pre-computed hash is stored as-is.
 */
export async function createUserWithPrehashedPassword(username, passwordHash, role = null, plan = 'free') {
  const existingRes = await query('SELECT Id FROM Users WHERE LOWER(Username) = LOWER(?)', [username]);
  if (existingRes.rows[0]) throw new Error('Username already exists');

  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const countRes = await query('SELECT COUNT(*) as c FROM Users');
  const totalUsers = parseInt(countRes.rows[0].c || 0);
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

  const result = await query(
    'INSERT INTO Users (Username, PasswordHash, Role, Plan, Timestamp) VALUES (?, ?, ?, ?, ?) RETURNING Id',
    [username, passwordHash, effectiveRole, plan, now()]
  );

  const insertedId = result.rows[0]?.Id || result.rows[0]?.id;
  return { id: insertedId, username, role: effectiveRole, plan };
}

export async function verifyUser(username, password) {
  const res = await query('SELECT * FROM Users WHERE LOWER(Username) = LOWER(?)', [username]);
  const row = res.rows[0];
  if (!row) return null;
  const { valid, needsRehash, newHash } = await verifyPassword(password, row.PasswordHash);
  if (!valid) return null;
  if (needsRehash && newHash) {
    await query('UPDATE Users SET PasswordHash = ? WHERE Id = ?', [newHash, row.Id]);
  }
  await touchLastLogin(row.Id);
  return { id: row.Id, username: row.Username, role: row.Role, plan: row.Plan || 'free', displayName: row.DisplayName || null };
}

export async function findUserByUsername(username) {
  const res = await query('SELECT Id as id, Username as username, Role as role, Plan as plan, DisplayName as displayName FROM Users WHERE LOWER(Username) = LOWER(?)', [username]);
  const row = res.rows[0];
  return row ? { id: row.id, username: row.username, role: row.role, plan: row.plan || 'free', displayName: row.displayName || null } : null;
}

export async function getAllUsers() {
  const res = await query(`
    SELECT u.Id as id, u.Username as username, u.Role as role, u.Plan as plan,
           u.Timestamp as createdAt, u.LastLogin as lastLogin, u.DisplayName as displayName,
           s.Status as subStatus, s.PeriodEnd as subPeriodEnd, s.StripeCustomerId as stripeCustomerId,
           COALESCE(SUM(t.TotalTokens), 0) as totalTokens
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id
    LEFT JOIN TokenUsage t ON t.UserId = u.Id
    GROUP BY u.Id, u.Username, u.Role, u.Plan, u.Timestamp, u.LastLogin, u.DisplayName, s.Status, s.PeriodEnd, s.StripeCustomerId
    ORDER BY u.Timestamp DESC
  `);
  return res.rows.map(r => ({
    id: r.id, username: r.username, role: r.role, plan: r.plan || 'free',
    createdAt: r.createdAt, lastLogin: r.lastLogin, displayName: r.displayName,
    subStatus: r.subStatus, subPeriodEnd: r.subPeriodEnd, stripeCustomerId: r.stripeCustomerId,
    totalTokens: r.totalTokens,
  }));
}

export async function getUserById(userId) {
  const res = await query(`
    SELECT u.Id as id, u.Username as username, u.Role as role, u.Plan as plan,
           u.Timestamp as createdAt, u.LastLogin as lastLogin, u.DisplayName as displayName,
           s.Status as subStatus, s.PeriodEnd as subPeriodEnd, s.StripeCustomerId as stripeCustomerId,
           s.StripeSubscriptionId as stripeSubscriptionId
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id
    WHERE u.Id = ?
  `, [userId]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id, username: row.username, role: row.role, plan: row.plan || 'free',
    createdAt: row.createdAt, lastLogin: row.lastLogin, displayName: row.displayName,
    subStatus: row.subStatus, subPeriodEnd: row.subPeriodEnd,
    stripeCustomerId: row.stripeCustomerId, stripeSubscriptionId: row.stripeSubscriptionId,
  };
}

export async function updateUserRole(userId, role) {
  const allowed = ['user', 'pro', 'admin'];
  if (!allowed.includes(role)) throw new Error(`Invalid role: ${role}`);
  await query('UPDATE Users SET Role = ? WHERE Id = ?', [role, userId]);
}

export async function updateUserPlan(userId, plan) {
  const allowed = ['free', 'basic', 'pro', 'enterprise'];
  if (!allowed.includes(plan)) throw new Error(`Invalid plan: ${plan}`);
  await query('UPDATE Users SET Plan = ? WHERE Id = ?', [plan, userId]);
  await upsertSubscription(userId, {
    plan,
    status: plan === 'free' ? 'inactive' : 'active',
    periodEnd: plan === 'free' ? null : new Date(Date.now() + 365 * 86400000).toISOString(),
  });
}

export async function touchLastLogin(userId) {
  await query('UPDATE Users SET LastLogin = ? WHERE Id = ?', [now(), userId]);
}

export async function getUserCount() {
  const res = await query('SELECT COUNT(*) as c FROM Users');
  return parseInt(res.rows[0].c || 0);
}

export async function deleteUser(userId) {
  // Sanitize any globally corrupted foreign keys in AuditLog to prevent FOREIGN KEY constraint failures
  // This cleans up bad data (e.g. string timestamps incorrectly stored in ActorId)
  await query(`UPDATE AuditLog SET ActorId = NULL WHERE ActorId IS NOT NULL AND (typeof(ActorId) = 'text' OR ActorId NOT IN (SELECT Id FROM Users))`);
  await query(`UPDATE AuditLog SET UserId = NULL WHERE UserId IS NOT NULL AND (typeof(UserId) = 'text' OR UserId NOT IN (SELECT Id FROM Users))`);

  // Manual cascading deletes (production DB might lack ON DELETE CASCADE)
  await query('DELETE FROM Sessions WHERE UserId = ?', [userId]);
  await query('DELETE FROM Subscriptions WHERE UserId = ?', [userId]);
  await query('DELETE FROM UsageTracking WHERE UserId = ?', [userId]);
  await query('DELETE FROM TokenUsage WHERE UserId = ?', [userId]);
  await query('DELETE FROM UserSettings WHERE UserId = ?', [userId]);
  
  await query('UPDATE AuditLog SET UserId = NULL WHERE UserId = ?', [userId]);
  await query('UPDATE AuditLog SET ActorId = NULL WHERE ActorId = ?', [userId]);
  
  await query('DELETE FROM InviteTokens WHERE CreatedByUserId = ?', [userId]);
  await query('UPDATE InviteTokens SET UsedByUserId = NULL WHERE UsedByUserId = ?', [userId]);
  
  await query('UPDATE LicenseKeys SET CreatedByUserId = NULL WHERE CreatedByUserId = ?', [userId]);
  await query('UPDATE LicenseKeys SET RedeemedByUserId = NULL WHERE RedeemedByUserId = ?', [userId]);
  
  await query('UPDATE BatchRuns SET UserId = NULL WHERE UserId = ?', [userId]);

  const result = await query('DELETE FROM Users WHERE Id = ?', [userId]);
  return result.changes > 0;
}

export async function updateProfile(userId, { displayName } = {}) {
  await query('UPDATE Users SET DisplayName = ? WHERE Id = ?', [displayName || null, userId]);
}

export async function updatePassword(userId, newPassword) {
  const hash = await hashPassword(newPassword);
  await query('UPDATE Users SET PasswordHash = ?, ForceResetPw = 0 WHERE Id = ?', [hash, userId]);
}

export async function forceResetPassword(userId) {
  const tempPw = crypto.randomBytes(6).toString('hex'); // 12-char hex
  const hash = await hashPassword(tempPw);
  await query('UPDATE Users SET PasswordHash = ?, ForceResetPw = 1 WHERE Id = ?', [hash, userId]);
  await query('DELETE FROM Sessions WHERE UserId = ?', [userId]);
  return tempPw;
}

export async function verifyPasswordOnly(userId, password) {
  const res = await query('SELECT PasswordHash FROM Users WHERE Id = ?', [userId]);
  const row = res.rows[0];
  if (!row) return false;
  return (await verifyPassword(password, row.PasswordHash)).valid;
}

export async function checkForceReset(userId) {
  const res = await query('SELECT ForceResetPw FROM Users WHERE Id = ?', [userId]);
  return res.rows[0]?.ForceResetPw === 1;
}

// ── Usage tracking ─────────────────────────────────────────────────────────────

export const FREE_DAILY_DEED_LIMIT = 5;

export async function getDailyUsage(userId) {
  const date = now().slice(0, 10);
  const res = await query('SELECT DeedSolves FROM UsageTracking WHERE UserId = ? AND Date = ?', [userId, date]);
  const row = res.rows[0];
  return row ? row.DeedSolves : 0;
}

export async function incrementDailyUsage(userId, credits = 1) {
  const date = now().slice(0, 10);
  await query(`
    INSERT INTO UsageTracking (UserId, Date, DeedSolves) VALUES (?, ?, ?)
    ON CONFLICT(UserId, Date) DO UPDATE SET DeedSolves = UsageTracking.DeedSolves + ?
  `, [userId, date, credits, credits]);
}

export async function checkDailyLimit(userId, userPlan, userRole, requestedCredits = 1) {
  if (userRole === 'admin') return { allowed: true, used: null, limit: null };
  const res = await query('SELECT DailyDeedLimit FROM PlanSettings WHERE Plan = ?', [userPlan || 'free']);
  const planSetting = res.rows[0];
  const limit = planSetting ? planSetting.DailyDeedLimit : 5;
  if (limit < 0) return { allowed: true, used: null, limit: null };
  const used = await getDailyUsage(userId);
  return { allowed: (used + requestedCredits) <= limit, used, limit };
}

export async function getUserDailyStats(userId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const res = await query(`
    SELECT Date as date, DeedSolves as deedSolves
    FROM UsageTracking
    WHERE UserId = ? AND Date >= ?
    ORDER BY Date ASC
  `, [userId, since]);
  return res.rows;
}

export async function getSystemStats() {
  const userCountRes = await query('SELECT COUNT(*) as c FROM Users');
  const proCountRes = await query("SELECT COUNT(*) as c FROM Users WHERE Plan != 'free'");
  const sessionCountRes = await query('SELECT COUNT(*) as c FROM Sessions WHERE ExpiresAt > ?', [now()]);
  const todayDate = now().slice(0, 10);
  const todaySolvesRes = await query('SELECT COALESCE(SUM(DeedSolves),0) as s FROM UsageTracking WHERE Date = ?', [todayDate]);
  const totalSolvesRes = await query('SELECT COALESCE(SUM(DeedSolves),0) as s FROM UsageTracking');

  return {
    userCount: parseInt(userCountRes.rows[0].c || 0),
    proCount: parseInt(proCountRes.rows[0].c || 0),
    sessionCount: parseInt(sessionCountRes.rows[0].c || 0),
    todaySolves: parseInt(todaySolvesRes.rows[0].s || 0),
    totalSolves: parseInt(totalSolvesRes.rows[0].s || 0),
  };
}
