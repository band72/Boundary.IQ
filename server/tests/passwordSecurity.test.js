/**
 * tests/passwordSecurity.test.js
 *
 * Covers every use case introduced by the security hardening:
 *  1. hashPassword returns a salt:hash string and is async
 *  2. verifyPassword accepts the same-iteration hash
 *  3. verifyPassword rejects wrong passwords
 *  4. Legacy 1k-iteration hashes are accepted and upgraded (needsRehash)
 *  5. PendingRegistrations stores a PBKDF2 hash, not plain-text
 *  6. resend-verification rotates only the code; PasswordHash column is unchanged
 *  7. createUserWithPrehashedPassword creates a fully working user account
 *  8. Full end-to-end: register → email verify → login with original password
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { switchDbPath } from '../services/db/core.js';
import { hashPassword, verifyPassword, createUserWithPrehashedPassword, createUser, verifyUser } from '../services/db/users.js';
import { upsertPendingRegistration, getPendingRegistration, updatePendingRegistrationCode } from '../services/db/pendingRegistrations.js';
import authRouter from '../routes/auth.js';

// ── Test server setup ──────────────────────────────────────────────────────────
const TEST_DB = path.resolve('tests/password_security_test.db');
let app, server, baseUrl;
let originalNodeEnv;

beforeAll(async () => {
  originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production'; // force non-test mode for bypass checks

  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  switchDbPath(TEST_DB);

  app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  server = app.listen(0);
  baseUrl = `http://localhost:${server.address().port}/api/auth`;
});

afterAll(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  if (server) await new Promise(r => server.close(r));
  if (fs.existsSync(TEST_DB)) { try { fs.unlinkSync(TEST_DB); } catch {} }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. hashPassword unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe('hashPassword', () => {
  it('returns a salt:hash string', async () => {
    const h = await hashPassword('mypassword');
    expect(h).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const [h1, h2] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(h1).not.toBe(h2);
  });

  it('is async (returns a Promise)', () => {
    const result = hashPassword('test');
    expect(result).toBeInstanceOf(Promise);
    return result;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. verifyPassword unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyPassword', () => {
  it('returns { valid: true, needsRehash: false } for correct password', async () => {
    const hash = await hashPassword('correct-password');
    const result = await verifyPassword('correct-password', hash);
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it('returns { valid: false } for wrong password', async () => {
    const hash = await hashPassword('correct-password');
    const result = await verifyPassword('wrong-password', hash);
    expect(result.valid).toBe(false);
  });

  it('returns { valid: false } for null/undefined/malformed storedHash', async () => {
    expect((await verifyPassword('pw', null)).valid).toBe(false);
    expect((await verifyPassword('pw', undefined)).valid).toBe(false);
    expect((await verifyPassword('pw', 'no-colon-here')).valid).toBe(false);
  });

  it('upgrades a legacy 1k-iteration hash (needsRehash = true)', async () => {
    const salt = crypto.randomBytes(16).toString('hex');
    const legacyHash = crypto.pbkdf2Sync('legacy-password', salt, 1_000, 64, 'sha512').toString('hex');
    const stored = `${salt}:${legacyHash}`;

    const result = await verifyPassword('legacy-password', stored);
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(true);
    expect(result.newHash).toBeDefined();

    // The new hash must verify with the original password
    const recheck = await verifyPassword('legacy-password', result.newHash);
    expect(recheck.valid).toBe(true);
    expect(recheck.needsRehash).toBe(false);
  });

  it('wrong password against legacy hash also returns false', async () => {
    const salt = crypto.randomBytes(16).toString('hex');
    const legacyHash = crypto.pbkdf2Sync('legacy-password', salt, 1_000, 64, 'sha512').toString('hex');
    const stored = `${salt}:${legacyHash}`;
    const result = await verifyPassword('wrong-password', stored);
    expect(result.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PendingRegistrations — no plain-text password on disk
// ─────────────────────────────────────────────────────────────────────────────
describe('PendingRegistrations password storage', () => {
  const email = 'hashing_test@example.com';
  const plainPassword = 'MySecretPassword!';

  it('stores a PBKDF2 hash, not the plain-text password', async () => {
    await upsertPendingRegistration(email, {
      username: email,
      password: plainPassword,
      code: '123456',
      expiresAt: Date.now() + 15 * 60 * 1000,
      inviteToken: null,
    });

    const pending = await getPendingRegistration(email);
    expect(pending).not.toBeNull();
    expect(pending.passwordHash).not.toBe(plainPassword);
    expect(pending.passwordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);

    const check = await verifyPassword(plainPassword, pending.passwordHash);
    expect(check.valid).toBe(true);
  });

  it('does not expose a "password" plain-text field', async () => {
    const pending = await getPendingRegistration(email);
    expect(pending).not.toBeNull();
    expect(pending.password).toBeUndefined();
    expect(pending.passwordHash).toBeDefined();
  });

  it('second upsert (resend scenario) stores fresh hash for same email', async () => {
    const before = await getPendingRegistration(email);
    const hashBefore = before.passwordHash;

    // Re-upsert (simulates re-registration)
    await upsertPendingRegistration(email, {
      username: email,
      password: plainPassword,
      code: '654321',
      expiresAt: Date.now() + 15 * 60 * 1000,
      inviteToken: null,
    });

    const after = await getPendingRegistration(email);
    // A fresh hash is still a valid PBKDF2 string
    expect(after.passwordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    // Different salt → different hash
    expect(after.passwordHash).not.toBe(hashBefore);
    // Still verifies against the same plain password
    const check = await verifyPassword(plainPassword, after.passwordHash);
    expect(check.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. updatePendingRegistrationCode — code rotation without double-hash
// ─────────────────────────────────────────────────────────────────────────────
describe('updatePendingRegistrationCode', () => {
  const email = 'resend_hash_test@example.com';

  beforeAll(async () => {
    await upsertPendingRegistration(email, {
      username: email,
      password: 'SomePassword123',
      code: '111111',
      expiresAt: Date.now() + 15 * 60 * 1000,
      inviteToken: null,
    });
  });

  it('rotates the code without altering the stored password hash', async () => {
    const before = await getPendingRegistration(email);
    const originalHash = before.passwordHash;

    await updatePendingRegistrationCode(email, {
      code: '999999',
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    const after = await getPendingRegistration(email);
    expect(after.code).toBe('999999');
    expect(after.code).not.toBe(before.code);
    // Hash byte-identical — not double-hashed
    expect(after.passwordHash).toBe(originalHash);
  });

  it('resets attempts counter to 0', async () => {
    const after = await getPendingRegistration(email);
    expect(after.attempts).toBe(0);
  });

  it('password still verifies after code rotation', async () => {
    const after = await getPendingRegistration(email);
    const check = await verifyPassword('SomePassword123', after.passwordHash);
    expect(check.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. createUserWithPrehashedPassword
// ─────────────────────────────────────────────────────────────────────────────
describe('createUserWithPrehashedPassword', () => {
  it('creates a user that can log in with the original password', async () => {
    const username = `prehash_user_${Math.random().toString(36).slice(2)}@example.com`;
    const rawPassword = 'OriginalPassword!';
    const hash = await hashPassword(rawPassword);

    const user = await createUserWithPrehashedPassword(username, hash);
    expect(user).toMatchObject({ username, role: expect.any(String) });

    const verified = await verifyUser(username, rawPassword);
    expect(verified).not.toBeNull();
    expect(verified.username).toBe(username);
  });

  it('throws if the username already exists', async () => {
    const username = `dup_prehash_${Math.random().toString(36).slice(2)}@example.com`;
    const hash = await hashPassword('pw');
    await createUserWithPrehashedPassword(username, hash);
    await expect(createUserWithPrehashedPassword(username, hash)).rejects.toThrow('Username already exists');
  });

  it('does NOT double-hash the provided hash', async () => {
    const username = `nodbl_${Math.random().toString(36).slice(2)}@example.com`;
    const rawPassword = 'NoDoubleHash!';
    const hash = await hashPassword(rawPassword);

    await createUserWithPrehashedPassword(username, hash);
    const verified = await verifyUser(username, rawPassword);
    expect(verified).not.toBeNull();
  });

  it('assigns free plan by default', async () => {
    const username = `plan_check_${Math.random().toString(36).slice(2)}@example.com`;
    const hash = await hashPassword('pw');
    const user = await createUserWithPrehashedPassword(username, hash);
    expect(user.plan).toBe('free');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Full end-to-end: register → resend → verify → login (production mode)
// ─────────────────────────────────────────────────────────────────────────────
describe('Full email verification flow (production mode)', () => {
  const email = `e2e_verify_${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'FullFlowPass123!';
  let verificationCode = null;

  it('POST /register returns verificationRequired=true for real email', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.verificationRequired).toBe(true);
  });

  it('pending record stores hashed password, not plain-text', async () => {
    const pending = await getPendingRegistration(email);
    expect(pending).not.toBeNull();
    verificationCode = pending.code;

    expect(pending.passwordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(pending.passwordHash).not.toBe(password);

    const check = await verifyPassword(password, pending.passwordHash);
    expect(check.valid).toBe(true);
  });

  it('POST /resend-verification rotates code without corrupting the hash', async () => {
    const before = await getPendingRegistration(email);
    const hashBefore = before.passwordHash;

    const res = await fetch(`${baseUrl}/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const after = await getPendingRegistration(email);
    expect(after.code).not.toBe(before.code);
    expect(after.passwordHash).toBe(hashBefore); // byte-identical
    verificationCode = after.code;
  });

  it('POST /verify-registration with wrong code returns 400', async () => {
    const res = await fetch(`${baseUrl}/verify-registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: '000000' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /verify-registration with correct code creates user and returns token', async () => {
    const res = await fetch(`${baseUrl}/verify-registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: verificationCode }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.token).toBeDefined();
    expect(data.username).toBe(email);
  });

  it('POST /login succeeds with original password after verification', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBeDefined();
  });

  it('POST /login fails with wrong password', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password: 'WrongPassword!' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /verify-registration rejects already-used code (pending deleted)', async () => {
    const res = await fetch(`${baseUrl}/verify-registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: verificationCode }),
    });
    expect(res.status).toBe(400);
  });
});
