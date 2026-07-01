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
    const adminUser = createUser('license_admin', 'password123', 'admin@example.com');
    updateUserRole(adminUser.id, 'admin');

    const targetUser = createUser('license_target', 'password123', 'target@example.com');
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

  it('should generate/retrieve the license private key successfully', () => {
    const key = getOrCreateLicensePrivateKey();
    expect(key).toBeDefined();
    expect(key).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('should create and retrieve a signed license key for a user via DB service', () => {
    const { rawKey, plan } = createSignedLicenseKeyForUser({
      plan: 'pro',
      userId: targetUserId
    });

    expect(rawKey).toBeDefined();
    expect(rawKey).toContain('BIQ-PRO-');
    expect(plan).toBe('pro');

    const activeKey = getActiveLicenseKeyForUser(targetUserId);
    expect(activeKey).toBeDefined();
    expect(activeKey.RawKey).toBe(rawKey);
    expect(activeKey.Plan).toBe('pro');
  });

  it('should fetch active license key via API endpoint', async () => {
    const res = await fetch(`${baseUrl}/auth/users/${targetUserId}/license`, {
      headers: adminHeaders
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.license).toBeDefined();
    expect(data.license.RawKey).toContain('BIQ-PRO-');
  });

  it('should generate and sign a new license key via API endpoint', async () => {
    // First upgrade the target user's plan to enterprise so they have a valid plan for generation
    // (Free plan throws 400 as per safety logic)
    const upgradeRes = await fetch(`${baseUrl}/auth/users/${targetUserId}/plan`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ plan: 'enterprise' })
    });
    expect(upgradeRes.status).toBe(200);

    // Generate license
    const genRes = await fetch(`${baseUrl}/auth/users/${targetUserId}/license/generate`, {
      method: 'POST',
      headers: adminHeaders
    });
    expect(genRes.status).toBe(200);
    const genData = await genRes.json();
    expect(genData.success).toBe(true);
    expect(genData.licenseKey).toContain('BIQ-ENTERPRISE-');

    // Retrieve again to verify it has updated to the new Enterprise key
    const fetchRes = await fetch(`${baseUrl}/auth/users/${targetUserId}/license`, {
      headers: adminHeaders
    });
    const fetchData = await fetchRes.json();
    expect(fetchData.license.RawKey).toBe(genData.licenseKey);
    expect(fetchData.license.Plan).toBe('enterprise');
  });
});
