/**
 * db/subscriptions.js — Stripe subscription records and plan management.
 */

import { query, now } from './core.js';
import { logAudit } from './audit.js';

export async function upsertSubscription(userId, { plan, stripeCustomerId, stripeSubscriptionId, status, periodEnd } = {}) {
  await query(`
    INSERT INTO Subscriptions (UserId, Plan, StripeCustomerId, StripeSubscriptionId, Status, PeriodEnd, UpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(UserId) DO UPDATE SET
      Plan = EXCLUDED.Plan,
      StripeCustomerId = COALESCE(EXCLUDED.StripeCustomerId, Subscriptions.StripeCustomerId),
      StripeSubscriptionId = COALESCE(EXCLUDED.StripeSubscriptionId, Subscriptions.StripeSubscriptionId),
      Status = EXCLUDED.Status,
      PeriodEnd = EXCLUDED.PeriodEnd,
      UpdatedAt = EXCLUDED.UpdatedAt
  `, [userId, plan || 'free', stripeCustomerId || null, stripeSubscriptionId || null,
         status || 'inactive', periodEnd || null, now()]);
  // Keep Users.Plan in sync
  await query('UPDATE Users SET Plan = ? WHERE Id = ?', [plan || 'free', userId]);
}

export async function getSubscriptionByUser(userId) {
  const res = await query('SELECT * FROM Subscriptions WHERE UserId = ?', [userId]);
  return res.rows[0] || null;
}

export async function getSubscriptionByStripeCustomer(stripeCustomerId) {
  const res = await query(`
    SELECT s.*, u.Username as username
    FROM Subscriptions s
    JOIN Users u ON u.Id = s.UserId
    WHERE s.StripeCustomerId = ?
  `, [stripeCustomerId]);
  return res.rows[0] || null;
}

export async function getSubscriptionByStripeSubscription(stripeSubscriptionId) {
  const res = await query(`
    SELECT s.*, u.Id as userId
    FROM Subscriptions s
    JOIN Users u ON u.Id = s.UserId
    WHERE s.StripeSubscriptionId = ?
  `, [stripeSubscriptionId]);
  return res.rows[0] || null;
}

export async function getAllSubscriptions() {
  const res = await query(`
    SELECT
      u.Id          AS userId,
      u.Username    AS username,
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
  `);
  return res.rows;
}

export async function getRevenueStats() {
  // Read plan prices from the admin-editable PlanSettings table rather than
  // a hardcoded JS object, so any price changes are reflected immediately.
  const priceRes = await query('SELECT Plan, Price FROM PlanSettings');
  const PLAN_PRICE = Object.fromEntries(priceRes.rows.map(r => [r.Plan || r.plan, r.Price ?? r.price ?? 0]));

  const res = await query(`
    SELECT COALESCE(s.Plan, u.Plan, 'free') AS plan, COUNT(*) AS cnt
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id AND s.Status = 'active'
    GROUP BY COALESCE(s.Plan, u.Plan, 'free')
  `);
  const rows = res.rows;

  let mrr = 0;
  const breakdown = {};
  rows.forEach(r => {
    const plan = r.plan || 'free';
    const cnt = parseInt(r.cnt || 0);
    const price = PLAN_PRICE[plan] ?? 0;
    mrr += price * cnt;
    breakdown[plan] = (breakdown[plan] || 0) + cnt;
  });
  return { mrr, breakdown, totalUsers: rows.reduce((a, r) => a + parseInt(r.cnt || 0), 0) };
}

export async function adminSetPlan(userId, plan, actorId) {
  await upsertSubscription(userId, {
    plan,
    status: plan === 'free' ? 'inactive' : 'active',
    periodEnd: plan === 'free' ? null : undefined,
  });
  await logAudit({ actorId, userId, action: 'admin_set_plan', target: `userId=${userId}`, detail: { plan } });
}

export async function adminCancelSubscription(userId, actorId) {
  await query(`
    UPDATE Subscriptions
    SET Plan='free', Status='cancelled', PeriodEnd=NULL, UpdatedAt=?
    WHERE UserId=?
  `, [now(), userId]);
  await query('UPDATE Users SET Plan=? WHERE Id=?', ['free', userId]);
  await logAudit({
    actorId, userId,
    action: 'admin_cancel_subscription',
    target: `userId=${userId}`,
    detail: { message: 'cancelled by admin' },
  });
}
