import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { switchDbPath } from '../services/db/core.js';
import authRouter from '../routes/auth.js';
import { getPendingRegistration } from '../services/db/pendingRegistrations.js';

describe('Resend Verification Email Test Suite', () => {
  const TEST_DB_PATH = path.resolve('tests/resend_verification_test.db');
  let app;
  let server;
  let baseUrl;
  let originalNodeEnv;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    // Set node env to something other than 'test' to force verification check
    process.env.NODE_ENV = 'production';

    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
    }

    switchDbPath(TEST_DB_PATH);

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);

    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}/api/auth`;
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
    }
  });

  it('should require email verification for non-test emails and allow resending the verification code', async () => {
    const email = 'user_resend_test@example.com';
    
    // 1. Sign up the user
    const regRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: email,
        password: 'Password123!'
      })
    });
    
    expect(regRes.status).toBe(200);
    const regData = await regRes.json();
    expect(regData.verificationRequired).toBe(true);

    // Get the first verification code from the database
    const pending1 = await getPendingRegistration(email);
    expect(pending1).toBeDefined();
    expect(pending1.code).toBeDefined();
    const firstCode = pending1.code;

    // 2. Call resend-verification endpoint
    const resendRes = await fetch(`${baseUrl}/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    expect(resendRes.status).toBe(200);
    const resendData = await resendRes.json();
    expect(resendData.success).toBe(true);

    // Get the second verification code from the database and verify it has changed
    const pending2 = await getPendingRegistration(email);
    expect(pending2).toBeDefined();
    expect(pending2.code).toBeDefined();
    expect(pending2.code).not.toBe(firstCode); // Code should be regenerated!
  });

  it('should return 400 when resend is requested for a non-existent email', async () => {
    const resendRes = await fetch(`${baseUrl}/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent@example.com' })
    });

    expect(resendRes.status).toBe(400);
    const resendData = await resendRes.json();
    expect(resendData.error).toContain('No pending registration found');
  });
});
