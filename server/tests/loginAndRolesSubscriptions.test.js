import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

// Hijack Node's CommonJS require cache for the 'stripe' library
// to mock signature validation and webhook constructEvent behavior.
const require = createRequire(import.meta.url);
const stripePath = require.resolve('stripe');

let mockStripeEvent = null;

class MockStripe {
  constructor() {
    this.webhooks = {
      constructEvent: (body, sig, secret) => {
        if (sig === 'invalid-signature') {
          throw new Error('Invalid signature');
        }
        return mockStripeEvent;
      }
    };
  }
}

require.cache[stripePath] = {
  id: stripePath,
  filename: stripePath,
  loaded: true,
  exports: MockStripe
};

import { switchDbPath, getDb } from '../services/db/core.js';
import { createUser, getUserById, updateUserRole } from '../services/db/users.js';
import { getSubscriptionByUser } from '../services/db/subscriptions.js';
import authRouter from '../routes/auth.js';
import billingRouter from '../routes/billing.js';

describe('Login, Roles, and Subscriptions Test Suite', () => {
  const TEST_DB_PATH = path.resolve('tests/login_roles_sub_test.db');
  let app;
  let server;
  let baseUrl;

  // Keep track of credentials/tokens between tests
  const adminCreds = {
    username: `test_admin_${Math.random().toString(36).substring(7)}`,
    password: 'AdminPassword123!'
  };
  let adminToken = null;
  let adminId = null;

  const user1Creds = {
    username: `test_user_${Math.random().toString(36).substring(7)}`,
    password: 'Password123!'
  };
  let user1Token = null;
  let user1Id = null;

  beforeAll(async () => {
    // Ensure we start with a clean test database
    if (fs.existsSync(TEST_DB_PATH)) {
      try {
        fs.unlinkSync(TEST_DB_PATH);
      } catch (err) {
        // ignore
      }
    }
    
    // Switch connection to test database
    switchDbPath(TEST_DB_PATH);

    // Initialize express application for integration testing
    app = express();
    
    // Raw body parsing required for Stripe webhook
    app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
    
    // Standard JSON body parsing for other routes
    app.use(express.json());

    // Mount routers
    app.use('/api/auth', authRouter);
    app.use('/api/billing', billingRouter);

    // Global error handler
    app.use((err, req, res, next) => {
      if (res.headersSent) return;
      res.status(err.status || 500).json({ error: err.message || 'Internal error' });
    });

    // Start ephemeral local server
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}/api`;
  });

  afterAll(async () => {
    // Stop local server
    await new Promise((resolve) => server.close(resolve));

    // Close SQLite database and delete test files
    const db = getDb();
    if (db) {
      db.close();
    }

    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
      if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
    } catch (err) {
      console.warn('Cleanup failed for test db files:', err.message);
    }
  });

  // ==========================================
  // 1. Authentication & Login Tests
  // ==========================================
  describe('Authentication APIs', () => {
    // We register the admin first so it automatically takes the admin role (totalUsers === 0)
    it('should successfully register the first user as an admin', async () => {
      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adminCreds)
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.token).toBeDefined();
      expect(data.username).toBe(adminCreds.username);
      expect(data.role).toBe('admin');

      adminToken = data.token;
      adminId = data.id;
    });

    // We register the second user which will naturally default to user role (totalUsers > 0)
    it('should successfully register a second user with free plan and user role', async () => {
      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user1Creds)
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.token).toBeDefined();
      expect(data.username).toBe(user1Creds.username);
      expect(data.role).toBe('user');
      expect(data.plan).toBe('free');

      user1Token = data.token;
      user1Id = data.id;
    });

    it('should return 400 when registering with duplicate username', async () => {
      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user1Creds)
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it('should return 400 when missing username or password', async () => {
      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'only_username' })
      });

      expect(response.status).toBe(400);
    });

    it('should successfully login and update last login timestamp', async () => {
      // Find initial lastLogin in DB
      const userBefore = getUserById(user1Id);
      expect(userBefore.lastLogin).toBeNull();

      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user1Creds)
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.token).toBeDefined();
      expect(data.username).toBe(user1Creds.username);

      // Verify lastLogin has been updated in database
      const userAfter = getUserById(user1Id);
      expect(userAfter.lastLogin).not.toBeNull();
    });

    it('should fail login with incorrect password', async () => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: user1Creds.username,
          password: 'IncorrectPassword!'
        })
      });

      expect(response.status).toBe(401);
    });

    it('should successfully get profile information using me endpoint', async () => {
      const response = await fetch(`${baseUrl}/auth/me`, {
        headers: { 'Authorization': `Bearer ${user1Token}` }
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe(user1Id);
      expect(data.username).toBe(user1Creds.username);
      expect(data.role).toBe('user');
      expect(data.plan).toBe('free');
    });

    it('should deny profile access with invalid token', async () => {
      const response = await fetch(`${baseUrl}/auth/me`, {
        headers: { 'Authorization': 'Bearer invalid_session_token' }
      });

      expect(response.status).toBe(401);
    });
  });

  // ==========================================
  // 2. Role-Based Access Control Tests
  // ==========================================
  describe('Roles & Permissions APIs', () => {
    it('should block non-admin users from accessing list of users', async () => {
      const response = await fetch(`${baseUrl}/auth/users`, {
        headers: { 'Authorization': `Bearer ${user1Token}` }
      });

      expect(response.status).toBe(403);
    });

    it('should allow admin users to access list of users', async () => {
      const response = await fetch(`${baseUrl}/auth/users`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data.users)).toBe(true);
      expect(data.users.length).toBeGreaterThanOrEqual(2);
    });

    it('should allow admin to change another user\'s role', async () => {
      const response = await fetch(`${baseUrl}/auth/users/${user1Id}/role`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ role: 'pro' })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.role).toBe('pro');

      // Verify in DB
      const user = getUserById(user1Id);
      expect(user.role).toBe('pro');
    });

    it('should block non-admin user from changing another user\'s role', async () => {
      const response = await fetch(`${baseUrl}/auth/users/${adminId}/role`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user1Token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ role: 'admin' })
      });

      expect(response.status).toBe(403);
    });

    it('should prevent admin from changing their own admin role', async () => {
      const response = await fetch(`${baseUrl}/auth/users/${adminId}/role`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ role: 'user' })
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('You cannot change your own admin role');
    });
  });

  // ==========================================
  // 3. Billing & Plans APIs
  // ==========================================
  describe('Billing & Plans APIs', () => {
    it('should return plans configurations', async () => {
      const response = await fetch(`${baseUrl}/billing/plans`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.plans).toBeDefined();
      expect(data.freePlan).toBeDefined();
    });

    it('should return correct subscription status for user', async () => {
      // Note: we upgraded user1's role to 'pro' in the previous block,
      // but plan is still 'free' by default. Let's reset role to 'user' to verify cleanly
      updateUserRole(user1Id, 'user');

      const response = await fetch(`${baseUrl}/billing/status`, {
        headers: { 'Authorization': `Bearer ${user1Token}` }
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.plan).toBe('free');
      expect(data.mockMode).toBe(true);
    });

    it('should upgrade plan immediately when checking out in mock mode', async () => {
      // Execute mock checkout
      const response = await fetch(`${baseUrl}/billing/create-checkout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user1Token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ plan: 'pro' })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.mockMode).toBe(true);
      expect(data.success).toBe(true);
      expect(data.plan).toBe('pro');

      // Verify plan is updated in database
      const user = getUserById(user1Id);
      expect(user.plan).toBe('pro');
    });
  });

  // ==========================================
  // 4. Stripe Webhook Events Tests
  // ==========================================
  describe('Stripe Webhook Event Processing', () => {
    beforeAll(() => {
      // Configure Stripe mock mode bypass
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
      process.env.STRIPE_WEBHOOK_SECRET = 'valid-webhook-secret';
    });

    afterAll(() => {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    });

    it('should reject webhook requests with invalid signature with 400', async () => {
      const response = await fetch(`${baseUrl}/billing/webhook`, {
        method: 'POST',
        headers: {
          'stripe-signature': 'invalid-signature',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id: 'evt_123' })
      });

      expect(response.status).toBe(400);
    });

    it('should successfully handle checkout.session.completed and activate subscription', async () => {
      // Set mock event details
      mockStripeEvent = {
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_tester1',
            subscription: 'sub_tester1',
            metadata: {
              userId: String(user1Id),
              plan: 'enterprise'
            }
          }
        }
      };

      const response = await fetch(`${baseUrl}/billing/webhook`, {
        method: 'POST',
        headers: {
          'stripe-signature': 'valid-sig',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(mockStripeEvent)
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.received).toBe(true);

      // Verify subscription record was created/upserted in database
      const sub = getSubscriptionByUser(user1Id);
      expect(sub).not.toBeNull();
      expect(sub.Status).toBe('active');
      expect(sub.Plan).toBe('enterprise');
      expect(sub.StripeCustomerId).toBe('cus_tester1');
      expect(sub.StripeSubscriptionId).toBe('sub_tester1');

      // Verify user plan was updated to enterprise
      const user = getUserById(user1Id);
      expect(user.plan).toBe('enterprise');
    });

    it('should handle customer.subscription.updated and update details', async () => {
      const periodEndUnix = Math.floor(Date.now() / 1000) + 3600 * 24 * 30; // 30 days out
      
      // Set mock event details
      mockStripeEvent = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_tester1',
            status: 'active',
            current_period_end: periodEndUnix,
            metadata: {
              plan: 'basic'
            }
          }
        }
      };

      const response = await fetch(`${baseUrl}/billing/webhook`, {
        method: 'POST',
        headers: {
          'stripe-signature': 'valid-sig',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(mockStripeEvent)
      });

      expect(response.status).toBe(200);

      // Verify updated values in DB
      const sub = getSubscriptionByUser(user1Id);
      expect(sub.Status).toBe('active');
      expect(sub.Plan).toBe('basic');
      expect(sub.PeriodEnd).toBe(new Date(periodEndUnix * 1000).toISOString());

      const user = getUserById(user1Id);
      expect(user.plan).toBe('basic');
    });

    it('should handle customer.subscription.deleted and downgrade to free plan', async () => {
      // Set mock event details
      mockStripeEvent = {
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_tester1'
          }
        }
      };

      const response = await fetch(`${baseUrl}/billing/webhook`, {
        method: 'POST',
        headers: {
          'stripe-signature': 'valid-sig',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(mockStripeEvent)
      });

      expect(response.status).toBe(200);

      // Verify subscription record status and plan updated to free in DB
      const sub = getSubscriptionByUser(user1Id);
      expect(sub.Status).toBe('cancelled');
      expect(sub.Plan).toBe('free');

      const user = getUserById(user1Id);
      expect(user.plan).toBe('free');
    });
  });
});
