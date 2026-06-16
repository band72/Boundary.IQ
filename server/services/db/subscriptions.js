/**
 * db/subscriptions.js — Stripe subscription records and plan management.
 */

import { getDb, now } from './core.js';
import { logAudit } from './audit.js';

export function upsertSubscription(userId, { plan, stripeCustomerId, stripeSubscriptionId, status, periodEnd } = {}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO Subscriptions (UserId, Plan, StripeCustomerId, StripeSubscriptionId, Status, PeriodEnd, UpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(UserId) DO UPDATE SET
      Plan = excluded.Plan,
      StripeCustomerId = COALESCE(excluded.StripeCustomerId, StripeCustomerId),
      StripeSubscriptionId = COALESCE(excluded.StripeSubscriptionId, StripeSubscriptionId),
      Status = excluded.Status,
      PeriodEnd = excluded.PeriodEnd,
      UpdatedAt = excluded.UpdatedAt
  `).run(userId, plan || 'free', stripeCustomerId || null, stripeSubscriptionId || null,
         status || 'inactive', periodEnd || null, now());
  // Keep Users.Plan in sync
  db.prepare('UPDATE Users SET Plan = ? WHERE Id = ?').run(plan || 'free', userId);
}

export function getSubscriptionByUser(userId) {
  return getDb().prepare('SELECT * FROM Subscriptions WHERE UserId = ?').get(userId) || null;
}

export function getSubscriptionByStripeCustomer(stripeCustomerId) {
  return getDb().prepare(`
    SELECT s.*, u.Username as username
    FROM Subscriptions s
    JOIN Users u ON u.Id = s.UserId
    WHERE s.StripeCustomerId = ?
  `).get(stripeCustomerId) || null;
}

export function getSubscriptionByStripeSubscription(stripeSubscriptionId) {
  return getDb().prepare(`
    SELECT s.*, u.Id as userId
    FROM Subscriptions s
    JOIN Users u ON u.Id = s.UserId
    WHERE s.StripeSubscriptionId = ?
  `).get(stripeSubscriptionId) || null;
}

export function getAllSubscriptions() {
  return getDb().prepare(`
    SELECT
      u.Id          AS userId,
      u.Username    AS username,
      u.Username    AS email,
      u.Role        AS role,
      u.Timestamp   AS userCreatedAt,
      COALESCE(s.Plan,   u.Plan)   AS plan,
      COALESCE(s.Status,'inactive') AS status,
      s.StripeCustomerId        AS stripeCustomerId,
      s.StripeSubscriptionId    AS stripeSubscriptionId,
      s.PeriodEnd               AS periodEnd,
      s.UpdatedAt               AS updatedAt,
      COALESCE(ut.totalSolves, 0) AS totalSolves
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id
    LEFT JOIN (
      SELECT UserId, SUM(DeedSolves) AS totalSolves
      FROM UsageTracking
      GROUP BY UserId
    ) ut ON ut.UserId = u.Id
    ORDER BY COALESCE(s.UpdatedAt, u.Timestamp) DESC
  `).all();
}

export function getRevenueStats() {
  const PLAN_PRICE = { free: 0, pro: 29, enterprise: 99 };
  const rows = getDb().prepare(`
    SELECT COALESCE(s.Plan, u.Plan, 'free') AS plan, COUNT(*) AS cnt
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id AND s.Status = 'active'
    GROUP BY plan
  `).all();

  let mrr = 0;
  const breakdown = {};
  rows.forEach(r => {
    const price = PLAN_PRICE[r.plan] || 0;
    mrr += price * r.cnt;
    breakdown[r.plan] = (breakdown[r.plan] || 0) + r.cnt;
  });
  return { mrr, breakdown, totalUsers: rows.reduce((a, r) => a + r.cnt, 0) };
}

export function adminSetPlan(userId, plan, actorId) {
  upsertSubscription(userId, {
    plan,
    status: plan === 'free' ? 'inactive' : 'active',
    periodEnd: plan === 'free' ? null : undefined,
  });
  logAudit({ actorId, userId, action: 'admin_set_plan', target: `userId=${userId}`, detail: { plan } });
}

export function adminCancelSubscription(userId, actorId) {
  const db = getDb();
  db.prepare(`
    UPDATE Subscriptions
    SET Plan='free', Status='cancelled', PeriodEnd=NULL, UpdatedAt=?
    WHERE UserId=?
  `).run(now(), userId);
  db.prepare('UPDATE Users SET Plan=? WHERE Id=?').run('free', userId);
  logAudit({
    actorId, userId,
    action: 'admin_cancel_subscription',
    target: `userId=${userId}`,
    detail: { message: 'cancelled by admin' },
  });
}
