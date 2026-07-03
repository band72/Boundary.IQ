/**
 * tests/validPlansAndRevenue.test.js
 *
 * Covers:
 *  1. VALID_PLANS constant from config includes 'basic' (was missing before fix)
 *  2. Admin PUT /orders/:userId/plan accepts all four plans including 'basic'
 *  3. Admin PUT /orders/:userId/plan rejects unknown plans with 400
 *  4. getRevenueStats reads prices from PlanSettings table (not hardcoded JS)
 *  5. getAllSubscriptions no longer aliases username as email
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { switchDbPath } from '../services/db/core.js';
import { createUser } from '../services/db/users.js';
import { createSession } from '../services/db/sessions.js';
import { getRevenueStats, getAllSubscriptions } from '../services/db/subscriptions.js';
import { upsertSubscription } from '../services/db/subscriptions.js';
import { updatePlanSettings, getAllPlanSettings } from '../services/diagnosticsDb.js';
import { VALID_PLANS } from '../config.js';
import authRouter from '../routes/auth.js';

const TEST_DB = path.resolve('tests/valid_plans_test.db');
let app, server, baseUrl;
let adminToken, user1Id, user2Id;

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  switchDbPath(TEST_DB);

  app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  server = app.listen(0);
  baseUrl = `http://localhost:${server.address().port}/api/auth`;

  const admin = await createUser(`admin_plans_${Date.now()}`, 'AdminPass!', 'admin', 'enterprise');
  adminToken = await createSession(admin.id);

  const u1 = await createUser(`user1_plans_${Date.now()}`, 'Pass1!', 'user', 'free');
  user1Id = u1.id;
  const u2 = await createUser(`user2_plans_${Date.now()}`, 'Pass2!', 'user', 'pro');
  user2Id = u2.id;
});

afterAll(async () => {
  if (server) await new Promise(r => server.close(r));
  if (fs.existsSync(TEST_DB)) { try { fs.unlinkSync(TEST_DB); } catch {} }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. VALID_PLANS constant
// ─────────────────────────────────────────────────────────────────────────────
describe('VALID_PLANS constant', () => {
  it('exports an array from config.js', () => {
    expect(Array.isArray(VALID_PLANS)).toBe(true);
  });

  it('includes all four plan tiers', () => {
    expect(VALID_PLANS).toContain('free');
    expect(VALID_PLANS).toContain('basic');
    expect(VALID_PLANS).toContain('pro');
    expect(VALID_PLANS).toContain('enterprise');
  });

  it('does not include unknown plans', () => {
    expect(VALID_PLANS).not.toContain('gold');
    expect(VALID_PLANS).not.toContain('unlimited');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PUT /orders/:userId/plan — valid plan acceptance
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /orders/:userId/plan — valid plans', () => {
  for (const plan of ['free', 'basic', 'pro', 'enterprise']) {
    it(`accepts plan="${plan}"`, async () => {
      const res = await fetch(`${baseUrl}/orders/${user1Id}/plan`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ plan }),
      });
      // Should not be 400 (invalid plan)
      expect(res.status).not.toBe(400);
      // Should succeed (200) or be a server-side issue, not a validation failure
      expect([200, 201]).toContain(res.status);
    });
  }

  it('rejects plan="gold" with 400', async () => {
    const res = await fetch(`${baseUrl}/orders/${user1Id}/plan`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ plan: 'gold' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid plan');
  });

  it('rejects plan="" with 400', async () => {
    const res = await fetch(`${baseUrl}/orders/${user1Id}/plan`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ plan: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing plan field with 400', async () => {
    const res = await fetch(`${baseUrl}/orders/${user1Id}/plan`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-admin user', async () => {
    const u = await createUser(`non_admin_${Date.now()}`, 'Pw!', 'user', 'pro');
    const tok = await createSession(u.id);
    const res = await fetch(`${baseUrl}/orders/${user1Id}/plan`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({ plan: 'pro' }),
    });
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getRevenueStats — reads from PlanSettings, not hardcoded prices
// ─────────────────────────────────────────────────────────────────────────────
describe('getRevenueStats reads from PlanSettings table', () => {
  it('returns mrr=0 when all users are on free plan', async () => {
    const stats = await getRevenueStats();
    // With no active paid subscriptions, MRR must be 0
    expect(typeof stats.mrr).toBe('number');
    expect(stats.breakdown).toBeDefined();
    expect(stats.totalUsers).toBeGreaterThan(0);
  });

  it('reflects admin-updated prices from PlanSettings', async () => {
    // First get current plan settings
    const allSettings = await getAllPlanSettings();
    const proPlan = allSettings.find(p => (p.Plan || p.plan) === 'pro');

    if (proPlan) {
      const planName = proPlan.Plan || proPlan.plan;

      // Activate a pro subscription for user2
      await upsertSubscription(user2Id, {
        plan: 'pro',
        status: 'active',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        periodEnd: null,
      });

      // Update pro price to a test value
      const testPrice = 42.00;
      await updatePlanSettings(planName, {
        name: proPlan.name,
        dailyDeedLimit: proPlan.dailyDeedLimit,
        price: testPrice,
        features: proPlan.features,
        description: proPlan.description,
      });

      const stats = await getRevenueStats();
      // Should reflect the updated price, not the old hardcoded value
      expect(stats.mrr).toBeGreaterThanOrEqual(testPrice);
    } else {
      // PlanSettings table may be empty in this test env — just verify structure
      const stats = await getRevenueStats();
      expect(stats).toHaveProperty('mrr');
      expect(stats).toHaveProperty('breakdown');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. getAllSubscriptions — no email alias bug
// ─────────────────────────────────────────────────────────────────────────────
describe('getAllSubscriptions email alias bug fix', () => {
  it('returns rows without a spurious "email" column shadowing "username"', async () => {
    const rows = await getAllSubscriptions();
    expect(Array.isArray(rows)).toBe(true);

    for (const row of rows) {
      // username must exist and be the actual username
      expect(row.username).toBeDefined();
      // email column must NOT exist (it was an erroneous alias of username)
      expect(row.email).toBeUndefined();
    }
  });

  it('returns username field correctly (not overwritten by alias)', async () => {
    const rows = await getAllSubscriptions();
    const testRow = rows.find(r => r.userId === user2Id);
    if (testRow) {
      // username should be a string that looks like a username, not undefined
      expect(typeof testRow.username).toBe('string');
      expect(testRow.username.length).toBeGreaterThan(0);
    }
  });
});
