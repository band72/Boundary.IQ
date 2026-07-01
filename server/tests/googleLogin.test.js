import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { request } from 'undici';
import { switchDbPath, getDb } from '../services/db/core.js';
import { getUserById } from '../services/db/users.js';
import authRouter from '../routes/auth.js';

describe('Google Login Integration Test Suite', () => {
  const TEST_DB_PATH = path.resolve('tests/google_login_test.db');
  let app;
  let server;
  let baseUrl;

  // Helper to generate a mock Google Identity Services token (JWT)
  function createMockGoogleToken(email, emailVerified = true, malformed = false) {
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: 'https://accounts.google.com',
      sub: `10987654321${Math.floor(Math.random() * 10000)}`,
      email: email,
      email_verified: emailVerified,
      name: email.split('@')[0],
      picture: 'https://lh3.googleusercontent.com/a/mock-avatar',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    };

    const encodeBase64Url = (obj) => {
      const str = JSON.stringify(obj);
      return Buffer.from(str)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    };

    if (malformed) {
      return `invalidheader.not_base64_json_at_all.mocksignature`;
    }

    return `${encodeBase64Url(header)}.${encodeBase64Url(payload)}.mocksignature`;
  }

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
    app.use(express.json());

    // Mount auth router
    app.use('/api/auth', authRouter);

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

  it('should return 400 when credential token is missing', async () => {
    const response = await fetch(`${baseUrl}/auth/google-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Google credential token is required');
  });

  it('should successfully register a new user using a valid mock Google token', async () => {
    const email = 'new_surveyor@google.com';
    const mockToken = createMockGoogleToken(email, true);

    const response = await fetch(`${baseUrl}/auth/google-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: mockToken })
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.token).toBeDefined();
    expect(data.username).toBe(email);
    expect(data.plan).toBe('free');

    // Confirm user was written to the test database
    const userInDb = getUserById(data.id);
    expect(userInDb).toBeDefined();
    expect(userInDb.username).toBe(email);

    // Confirm that the auth cookie was set
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('boundaryiq_auth_token=');
  });

  it('should successfully log in an existing user using a valid mock Google token', async () => {
    const email = 'new_surveyor@google.com'; // user already created in previous test
    const mockToken = createMockGoogleToken(email, true);

    const response = await fetch(`${baseUrl}/auth/google-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: mockToken })
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.username).toBe(email);
    expect(data.plan).toBe('free');
  });

  it('should return 403 when the Google account email is not verified', async () => {
    const email = 'unverified_surveyor@google.com';
    const mockToken = createMockGoogleToken(email, false);

    const response = await fetch(`${baseUrl}/auth/google-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: mockToken })
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Google account email is not verified');
  });

  it('should return 400 when the mock simulator token is malformed', async () => {
    const email = 'malformed_surveyor@google.com';
    const mockToken = createMockGoogleToken(email, true, true); // malformed

    const response = await fetch(`${baseUrl}/auth/google-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: mockToken })
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Malformed simulator credential.');
  });

  it('should successfully authenticate /me requests using the session token', async () => {
    const email = 'verify_me@google.com';
    const mockToken = createMockGoogleToken(email, true);

    const loginRes = await fetch(`${baseUrl}/auth/google-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: mockToken })
    });

    const loginData = await loginRes.json();
    const token = loginData.token;

    // Verify authentication via Authorization Header
    const meHeaderRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(meHeaderRes.status).toBe(200);
    const meHeaderData = await meHeaderRes.json();
    expect(meHeaderData.username).toBe(email);

    // Verify authentication via Cookie Header (using undici request to bypass fetch's forbidden header block)
    const meCookieRes = await request(`${baseUrl}/auth/me/sessions`, {
      headers: { 'Cookie': `boundaryiq_auth_token=${token}` }
    });
    expect(meCookieRes.statusCode).toBe(200);
    const meCookieData = await meCookieRes.body.json();
    expect(meCookieData.sessions).toBeDefined();
    expect(Array.isArray(meCookieData.sessions)).toBe(true);
  });
});
