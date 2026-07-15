/**
 * tests/batchDeedRoute.test.js
 *
 * Covers the batchDeed route use cases without triggering real AI processing:
 *  1. No auth → 401
 *  2. No files → 400
 *  3. Unsupported file format → 400 (code: UNSUPPORTED_FILE_FORMAT)
 *  4. File too large for plan → 400 (code: FILE_SIZE_LIMIT_EXCEEDED)
 *  5. Daily credit limit exceeded → 429 (code: DAILY_LIMIT_REACHED)
 *  6. Concurrent lock already held → 503
 *
 * The actual AI pipeline (runRepairPipeline, geminiVision) is mocked so tests
 * run instantly without network calls or GPU compute.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { switchDbPath } from '../services/db/core.js';
import { createUser } from '../services/db/users.js';
import { createSession } from '../services/db/sessions.js';
import authRouter from '../routes/auth.js';

// ── Mock heavy dependencies BEFORE importing the route ────────────────────────
vi.mock('../services/Scripting/repair.js', () => ({
  runRepairPipeline: vi.fn(async () => ({
    finalExtraction: { courses: [], classification: 'METES_BOUNDS', rawText: '' },
    finalTraverse: { closure: { linearError: 0, precisionRatio: '1:10000' }, areaAcres: 0, perimeter: 0 },
    status: 'PASS',
    repairStageUsed: 'Stage1: Mock',
    agentTurns: [],
    trustScore: 0.9,
    trustLevel: 'high',
    trustFlags: [],
    bustCourseIndex: null,
    solutionSteps: [],
    traverseError: null,
    originalExtraction: null,
  })),
}));

vi.mock('../services/Scripting/legalWriter.js', () => ({
  write: vi.fn(() => 'Mock legal description'),
}));

vi.mock('../services/geminiVision.js', () => ({
  getActiveProvider: vi.fn(() => 'gemini'),
  hasBoundaryKeywords: vi.fn(() => true),
}));

vi.mock('../services/docConversion.js', () => ({
  isWordDocument: vi.fn(() => false),
  convertToPdf: vi.fn(async (bytes) => bytes),
}));

vi.mock('../services/lockService.js', () => {
  let locked = false;
  const userLocks = new Map();
  return {
    // Global lock (kept for backward compat)
    acquire: vi.fn((name, type) => {
      if (locked) return false;
      locked = true;
      return true;
    }),
    release: vi.fn(() => { locked = false; }),
    status: vi.fn(() => ({ type: 'test', elapsedSec: 1 })),
    // Per-user lock
    acquirePerUser: vi.fn((userId) => {
      const key = String(userId);
      if (userLocks.has(key)) return false;
      userLocks.set(key, { startTime: Date.now() });
      return true;
    }),
    releasePerUser: vi.fn((userId) => { userLocks.delete(String(userId)); }),
    statusPerUser: vi.fn((userId) => {
      const info = userLocks.get(String(userId));
      return info ? Math.round((Date.now() - info.startTime) / 1000) : null;
    }),
    FifoSemaphore: class {
      constructor(n) { this.n = n; }
      async acquire() {}
      release() {}
    },
  };
});

// ── Import route AFTER mocking ────────────────────────────────────────────────
const { default: batchDeedRouter } = await import('../routes/batchDeed.js');

const TEST_DB = path.resolve('tests/batch_deed_route_test.db');
let app, server, baseUrl;
let freeToken, proToken, adminToken;
let freeUserId;

const createTestFile = (name = 'test.pdf', sizeBytes = 1000) => {
  const content = Buffer.alloc(sizeBytes, 'x');
  return { name, content };
};

const postBatch = async (token, files, extraOpts = {}) => {
  const form = new FormData();
  for (const f of files) {
    const blob = new Blob([f.content], { type: 'application/pdf' });
    form.append('images', blob, f.name);
  }
  const url = `${baseUrl}/api/batchdeed/process`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...extraOpts.headers,
    },
    body: form,
    signal: extraOpts.signal,
  });
  return response;
};

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  switchDbPath(TEST_DB);

  app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/batchdeed', batchDeedRouter);

  server = app.listen(0);
  baseUrl = `http://localhost:${server.address().port}`;

  const freeUser = await createUser(`free_bd_${Date.now()}`, 'Pass!', 'user', 'free');
  freeUserId = freeUser.id;
  freeToken = await createSession(freeUser.id);

  const proUser = await createUser(`pro_bd_${Date.now()}`, 'Pass!', 'user', 'pro');
  proToken = await createSession(proUser.id);

  const adminUser = await createUser(`admin_bd_${Date.now()}`, 'Pass!', 'admin', 'enterprise');
  adminToken = await createSession(adminUser.id);
});

afterAll(async () => {
  if (server) await new Promise(r => server.close(r));
  if (fs.existsSync(TEST_DB)) { try { fs.unlinkSync(TEST_DB); } catch {} }
  // Clean up any leftover upload dirs
  const uploadsDir = path.resolve('uploads');
  if (fs.existsSync(uploadsDir)) {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Auth guard
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/batchdeed/process — auth guard', () => {
  it('returns 401 when no token provided', async () => {
    const form = new FormData();
    form.append('images', new Blob(['x']), 'a.pdf');
    const res = await fetch(`${baseUrl}/api/batchdeed/process`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for malformed token', async () => {
    const form = new FormData();
    form.append('images', new Blob(['x']), 'a.pdf');
    const res = await fetch(`${baseUrl}/api/batchdeed/process`, {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid' },
      body: form,
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. No files
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/batchdeed/process — no files', () => {
  it('returns 400 when no files are uploaded', async () => {
    const form = new FormData(); // empty form (no files appended)
    const res = await fetch(`${baseUrl}/api/batchdeed/process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${proToken}` },
      body: form,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('No images');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Unsupported file format
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/batchdeed/process — unsupported file format', () => {
  it('returns 400 with UNSUPPORTED_FILE_FORMAT for .exe file', async () => {
    const res = await postBatch(proToken, [{ name: 'malware.exe', content: Buffer.from('MZ') }]);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('UNSUPPORTED_FILE_FORMAT');
  });

  it('returns 400 with UNSUPPORTED_FILE_FORMAT for .xml file', async () => {
    const res = await postBatch(proToken, [{ name: 'data.xml', content: Buffer.from('<root/>') }]);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('UNSUPPORTED_FILE_FORMAT');
  });

  it('accepts .pdf extension', async () => {
    const res = await postBatch(adminToken, [createTestFile('deed.pdf', 500)]);
    // 200 or streaming response — not 400 format error
    expect(res.status).not.toBe(400);
  });

  it('accepts .jpg extension', async () => {
    const res = await postBatch(adminToken, [createTestFile('scan.jpg', 500)]);
    expect(res.status).not.toBe(400);
  });

  it('accepts .txt extension', async () => {
    const res = await postBatch(adminToken, [createTestFile('deed.txt', 500)]);
    expect(res.status).not.toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Plan-based file size limits
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/batchdeed/process — file size limits', () => {
  const FREE_MAX = 0.5 * 1024 * 1024;   // 512 KB
  const BASIC_MAX = 1.0 * 1024 * 1024;  // 1 MB
  const PRO_MAX = 10.0 * 1024 * 1024;   // 10 MB

  it('free plan: file over 512 KB returns 400 FILE_SIZE_LIMIT_EXCEEDED', async () => {
    const oversized = createTestFile('big.pdf', FREE_MAX + 1);
    const res = await postBatch(freeToken, [oversized]);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('FILE_SIZE_LIMIT_EXCEEDED');
    expect(data.error).toContain('free');
  });

  it('free plan: file at exactly 512 KB is accepted (boundary)', async () => {
    const okFile = createTestFile('ok.pdf', FREE_MAX);
    const res = await postBatch(freeToken, [okFile]);
    // Should not be a size error — may be 200 or other non-400-size error
    if (res.status === 400) {
      const data = await res.json();
      expect(data.code).not.toBe('FILE_SIZE_LIMIT_EXCEEDED');
    }
  });

  it('pro plan: file at 5 MB is accepted', async () => {
    const midFile = createTestFile('medium.pdf', 5 * 1024 * 1024);
    const res = await postBatch(proToken, [midFile]);
    if (res.status === 400) {
      const data = await res.json();
      expect(data.code).not.toBe('FILE_SIZE_LIMIT_EXCEEDED');
    }
  });

  it('free plan: error message mentions the plan name', async () => {
    const oversized = createTestFile('huge.pdf', FREE_MAX + 100);
    const res = await postBatch(freeToken, [oversized]);
    const data = await res.json();
    expect(data.error.toLowerCase()).toContain('free');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Daily credit limit
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/batchdeed/process — daily credit limit', () => {
  it('returns 429 DAILY_LIMIT_REACHED when free user exhausts credits', async () => {
    // Exhaust the daily limit by importing the increment function directly
    const { incrementDailyUsage, checkDailyLimit } = await import('../services/db/users.js');
    // Free plan default is 5 solves/day; set usage to max
    const limit = await checkDailyLimit(freeUserId, 'free', 'user');
    if (limit.limit > 0) {
      await incrementDailyUsage(freeUserId, limit.limit);
    }

    const res = await postBatch(freeToken, [createTestFile('deed.pdf', 100)]);
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.code).toBe('DAILY_LIMIT_REACHED');
    expect(data.used).toBeGreaterThanOrEqual(limit.limit);
    expect(data.upgradeUrl).toBeDefined();
  });

  it('429 response includes limit and used fields', async () => {
    const res = await postBatch(freeToken, [createTestFile('deed.pdf', 100)]);
    if (res.status === 429) {
      const data = await res.json();
      expect(typeof data.used).toBe('number');
      expect(typeof data.limit).toBe('number');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Concurrent lock (per-user)
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/batchdeed/process — concurrent lock', () => {
  it('returns 503 when the same user already has a batch running', async () => {
    const { acquirePerUser } = await import('../services/lockService.js');
    // Force the per-user lock to be already held
    acquirePerUser.mockReturnValueOnce(false);

    const res = await postBatch(proToken, [createTestFile('deed.pdf', 100)]);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('already have a batch running');
  });
});
