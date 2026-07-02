import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { switchDbPath, getDb } from '../services/db/core.js';
import { createUser, updateUserRole, checkDailyLimit } from '../services/db/users.js';
import authRouter from '../routes/auth.js';
import billingRouter from '../routes/billing.js';

describe('Admin Plan Settings Integration Test Suite', () => {
  const TEST_DB_PATH = path.resolve('tests/plan_settings_test.db');
  let app;
  let server;
  let baseUrl;
  let adminToken;
  let userToken;

  beforeAll(async () => {
    // Clean test database
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
    }

    switchDbPath(TEST_DB_PATH);

    // Set up application
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/billing', billingRouter);

    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}/api`;

    // Create test accounts
    const adminUser = await createUser('settings_admin', 'password123', 'admin@example.com');
    await updateUserRole(adminUser.id, 'admin');

    const regularUser = await createUser('settings_user', 'password123', 'user@example.com');

    // Fetch tokens
    const adminRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'settings_admin', password: 'password123' })
    });
    const adminData = await adminRes.json();
    adminToken = adminData.token;

    const userRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'settings_user', password: 'password123' })
    });
    const userData = await userRes.json();
    userToken = userData.token;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    const db = getDb();
    if (db) db.close();

    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
      if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
    } catch (e) {}
  });

  it('should block non-admins from reading plan settings', async () => {
    const res = await fetch(`${baseUrl}/auth/admin/plan-settings`, {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });
    expect(res.status).toBe(403);
  });

  it('should allow admins to read the seeded plan settings templates', async () => {
    const res = await fetch(`${baseUrl}/auth/admin/plan-settings`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.settings).toHaveLength(4);

    const freePlan = data.settings.find(p => p.plan === 'free');
    expect(freePlan.name).toBe('Free');
    expect(freePlan.dailyDeedLimit).toBe(5);
    expect(freePlan.price).toBe(0);
  });

  it('should allow admins to update plan settings', async () => {
    const res = await fetch(`${baseUrl}/auth/admin/plan-settings/basic`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Basic Dynamic',
        dailyDeedLimit: 75,
        price: 899,
        features: ['75 deed solves/day', 'Dynamic feature test'],
        description: 'New dynamic test description'
      })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.settings.name).toBe('Basic Dynamic');
    expect(data.settings.dailyDeedLimit).toBe(75);
    expect(data.settings.price).toBe(899);
  });

  it('should verify /billing/plans returns the updated plan config', async () => {
    const res = await fetch(`${baseUrl}/billing/plans`);
    expect(res.status).toBe(200);
    const data = await res.json();

    const basicPlan = data.plans.find(p => p.id === 'basic');
    expect(basicPlan.name).toBe('Basic Dynamic');
    expect(basicPlan.price).toBe(899);
    expect(basicPlan.features).toContain('Dynamic feature test');
  });

  it('should verify checkDailyLimit respects dynamic DB configurations', async () => {
    // Check limit dynamically for free user (which has 5 solves limit)
    const limitCheckFree = await checkDailyLimit(999, 'free', 'user');
    expect(limitCheckFree.limit).toBe(5);

    // Now update free plan limit using PUT admin setting
    const updateRes = await fetch(`${baseUrl}/auth/admin/plan-settings/free`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Free Dynamic',
        dailyDeedLimit: 12,
        price: 0,
        features: ['12 solves/day'],
        description: 'Free tier description'
      })
    });
    expect(updateRes.status).toBe(200);

    // Verify limit check is now updated to 12
    const limitCheckUpdated = await checkDailyLimit(999, 'free', 'user');
    expect(limitCheckUpdated.limit).toBe(12);
  });
});
