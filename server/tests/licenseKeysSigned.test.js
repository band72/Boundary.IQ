import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { switchDbPath } from '../services/db/core.js';
import { createUser, updateUserRole } from '../services/db/users.js';
import { getOrCreateLicensePrivateKey, getActiveLicenseKeyForUser, createSignedLicenseKeyForUser } from '../services/db/licenseKeys.js';
import authRouter from '../routes/auth.js';

describe('Cryptographic License Keys Test Suite', () => {
  const TEST_DB_PATH = path.resolve('tests/license_keys_signed_test.db');
  let app;
  let server;
  let baseUrl;
  let adminToken;
  let adminHeaders;
  let targetUserId;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
    }

    switchDbPath(TEST_DB_PATH);

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);

    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}/api`;

    // Create admin user and target user
    const adminUser = await createUser('license_admin', 'password123', 'admin@example.com');
    await updateUserRole(adminUser.id, 'admin');

    const targetUser = await createUser('license_target', 'password123', 'target@example.com');
    targetUserId = targetUser.id;

    // Login admin
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'license_admin', password: 'password123' })
    });
    const loginData = await loginRes.json();
    adminToken = loginData.token;
    adminHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    };
  });

  afterAll(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
    }
  });

  it('should generate/retrieve the license private key successfully', async () => {
    const key = getOrCreateLicensePrivateKey();
    expect(key).toBeDefined();
    expect(key).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('should create a signed license key via DB service and return rawKey to caller only', async () => {
    // Security model: rawKey is returned to the caller at creation time only.
    // The DB stores only the SHA-256 hash — RawKey column is intentionally NOT populated.
    const { rawKey, plan } = await createSignedLicenseKeyForUser({
      plan: 'pro',
      userId: targetUserId
    });

    expect(rawKey).toBeDefined();
    expect(rawKey).toContain('BIQ-PRO-');
    expect(plan).toBe('pro');

    // The DB record should have plan metadata, but NOT the raw key
    const activeKey = await getActiveLicenseKeyForUser(targetUserId);
    expect(activeKey).toBeDefined();
    expect(activeKey.Plan).toBe('pro');
    // RawKey should NOT be returned (security fix: key is one-time-display only)
    expect(activeKey.RawKey).toBeUndefined();
  });

  it('should fetch active license key metadata via API endpoint (no raw key)', async () => {
    const res = await fetch(`${baseUrl}/auth/users/${targetUserId}/license`, {
      headers: adminHeaders
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.license).toBeDefined();
    expect(data.license.Plan).toBe('pro');
    // Security fix: raw key must NOT be exposed via the GET endpoint
    expect(data.license.RawKey).toBeUndefined();
  });

  it('should generate and sign a new license key via API endpoint (key returned once)', async () => {
    // First upgrade the target user's plan to enterprise so they have a valid plan for generation
    // (Free plan throws 400 as per safety logic)
    const upgradeRes = await fetch(`${baseUrl}/auth/users/${targetUserId}/plan`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ plan: 'enterprise' })
    });
    expect(upgradeRes.status).toBe(200);

    // Generate license — key is returned in the response (one-time display)
    const genRes = await fetch(`${baseUrl}/auth/users/${targetUserId}/license/generate`, {
      method: 'POST',
      headers: adminHeaders
    });
    expect(genRes.status).toBe(200);
    const genData = await genRes.json();
    expect(genData.success).toBe(true);
    expect(genData.licenseKey).toContain('BIQ-ENTERPRISE-');

    // Retrieve metadata again — plan updated, but raw key must NOT be re-exposed
    const fetchRes = await fetch(`${baseUrl}/auth/users/${targetUserId}/license`, {
      headers: adminHeaders
    });
    const fetchData = await fetchRes.json();
    expect(fetchData.license.Plan).toBe('enterprise');
    // Security fix: raw key is not stored or re-served after initial generation
    expect(fetchData.license.RawKey).toBeUndefined();
  });
});
