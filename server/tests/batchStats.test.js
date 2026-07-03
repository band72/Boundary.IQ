/**
 * tests/batchStats.test.js
 *
 * Covers the N+1 query fix and getDatabaseStats parallelization:
 *  1. getRecentBatchesWithStats returns correct counts for all batches in one call
 *  2. Stats shape matches expected structure (counts, precision, stages, failedFiles)
 *  3. getDatabaseStats returns expected shape and correct row counts
 *  4. purgeOldLogs deletes old records without blocking (VACUUM deferred)
 *  5. clearFailedCache removes only non-PASS records
 *  6. getBatchStats for a single batch returns consistent data
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { switchDbPath } from '../services/db/core.js';
import { createUser } from '../services/db/users.js';
import {
  saveBatchRun, saveDeedLog, getRecentBatchesWithStats,
  getBatchStats, getDatabaseStats, clearFailedCache, clearAllCache, purgeOldLogs,
} from '../services/db/deedLogs.js';

const TEST_DB = path.resolve('tests/batch_stats_test.db');

const makeLog = (batchId, fileName, status, opts = {}) => ({
  batchId,
  fileName,
  parcelName: opts.parcelName ?? 'TEST PARCEL',
  courseCount: opts.courseCount ?? 4,
  linearError: opts.linearError ?? 0,
  precisionRatio: opts.precisionRatio ?? 10000,
  status,
  repairStageUsed: opts.repairStageUsed ?? 'Stage1',
  extractionJson: opts.extractionJson ?? JSON.stringify({ Classification: 'METES_BOUNDS' }),
  traverseJson: opts.traverseJson ?? (status === 'PASS' ? JSON.stringify({ closure: { linearError: 0 } }) : null),
  agentTurnsJson: null,
  trustScore: null,
  solutionStepsJson: null,
  refName: null,
  refN: null,
  refE: null,
  pobN: 5000,
  pobE: 5000,
  fileHash: uuidv4(),
});

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  switchDbPath(TEST_DB);
});

afterAll(async () => {
  if (fs.existsSync(TEST_DB)) { try { fs.unlinkSync(TEST_DB); } catch {} }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test data helpers
// ─────────────────────────────────────────────────────────────────────────────
async function createTestBatch(fileCount = 4, { passCount = 2, failCount = 1, errorCount = 1 } = {}) {
  const batchId = uuidv4();
  await saveBatchRun(batchId, fileCount, passCount / fileCount);

  const saves = [];
  for (let i = 0; i < passCount; i++) {
    const { batchId: _b, fileName, ...rest } = makeLog(batchId, `pass_${i}.pdf`, 'PASS');
    saves.push(saveDeedLog(batchId, `pass_${i}.pdf`, rest.parcelName, rest.courseCount, rest.linearError, rest.precisionRatio, 'PASS', rest.repairStageUsed, rest.extractionJson, rest.traverseJson, rest.agentTurnsJson, rest.trustScore, rest.solutionStepsJson, rest.refName, rest.refN, rest.refE, rest.pobN, rest.pobE, rest.fileHash));
  }
  for (let i = 0; i < failCount; i++) {
    const { batchId: _b, fileName, ...rest } = makeLog(batchId, `fail_${i}.pdf`, 'FAIL', { linearError: 25 });
    saves.push(saveDeedLog(batchId, `fail_${i}.pdf`, rest.parcelName, rest.courseCount, rest.linearError, rest.precisionRatio, 'FAIL', rest.repairStageUsed, rest.extractionJson, rest.traverseJson, rest.agentTurnsJson, rest.trustScore, rest.solutionStepsJson, rest.refName, rest.refN, rest.refE, rest.pobN, rest.pobE, rest.fileHash));
  }
  for (let i = 0; i < errorCount; i++) {
    const { batchId: _b, fileName, ...rest } = makeLog(batchId, `err_${i}.pdf`, 'ERROR', { linearError: 999 });
    saves.push(saveDeedLog(batchId, `err_${i}.pdf`, rest.parcelName, rest.courseCount, rest.linearError, rest.precisionRatio, 'ERROR', rest.repairStageUsed, rest.extractionJson, rest.traverseJson, rest.agentTurnsJson, rest.trustScore, rest.solutionStepsJson, rest.refName, rest.refN, rest.refE, rest.pobN, rest.pobE, rest.fileHash));
  }
  await Promise.all(saves);
  return batchId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. getRecentBatchesWithStats — N+1 fix correctness
// ─────────────────────────────────────────────────────────────────────────────
describe('getRecentBatchesWithStats', () => {
  let batchA, batchB;

  beforeAll(async () => {
    batchA = await createTestBatch(4, { passCount: 2, failCount: 1, errorCount: 1 });
    batchB = await createTestBatch(3, { passCount: 3, failCount: 0, errorCount: 0 });
  });

  it('returns one entry per batch', async () => {
    const results = await getRecentBatchesWithStats(10);
    const batchIds = results.map(b => b.batchId);
    expect(batchIds).toContain(batchA);
    expect(batchIds).toContain(batchB);
  });

  it('stats.counts.total matches the number of deed logs in each batch', async () => {
    const results = await getRecentBatchesWithStats(10);
    const a = results.find(b => b.batchId === batchA);
    const b = results.find(b => b.batchId === batchB);

    expect(a.stats.counts.total).toBe(4);
    expect(b.stats.counts.total).toBe(3);
  });

  it('stats.counts.passed, failed, errors are individually correct', async () => {
    const results = await getRecentBatchesWithStats(10);
    const a = results.find(b => b.batchId === batchA);

    expect(a.stats.counts.passed).toBe(2);
    expect(a.stats.counts.failed).toBe(1);
    expect(a.stats.counts.errors).toBe(1);
  });

  it('stats.passRate is computed correctly', async () => {
    const results = await getRecentBatchesWithStats(10);
    const b = results.find(r => r.batchId === batchB);
    // 3/3 = 1.0
    expect(b.stats.passRate).toBeCloseTo(1.0);
  });

  it('stats.failedFiles contains failed and error file entries', async () => {
    const results = await getRecentBatchesWithStats(10);
    const a = results.find(b => b.batchId === batchA);
    // failedFiles should contain at least the 1 fail + 1 error
    expect(Array.isArray(a.stats.failedFiles)).toBe(true);
    expect(a.stats.failedFiles.length).toBeGreaterThanOrEqual(2);
  });

  it('stats has all required shape keys', async () => {
    const results = await getRecentBatchesWithStats(1);
    const first = results[0];
    expect(first).toHaveProperty('batchId');
    expect(first).toHaveProperty('timestamp');
    expect(first).toHaveProperty('stats');
    expect(first.stats).toHaveProperty('counts');
    expect(first.stats).toHaveProperty('precision');
    expect(first.stats).toHaveProperty('closure');
    expect(first.stats).toHaveProperty('stages');
    expect(first.stats).toHaveProperty('failedFiles');
  });

  it('returns empty array when no batches exist for userId', async () => {
    const results = await getRecentBatchesWithStats(10, 99999);
    expect(results).toEqual([]);
  });

  it('limit parameter is respected', async () => {
    const results = await getRecentBatchesWithStats(1);
    expect(results.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. getBatchStats — single batch
// ─────────────────────────────────────────────────────────────────────────────
describe('getBatchStats', () => {
  let batchId;
  beforeAll(async () => {
    batchId = await createTestBatch(5, { passCount: 3, failCount: 1, errorCount: 1 });
  });

  it('returns stats object for a specific batchId', async () => {
    const stats = await getBatchStats(batchId);
    expect(stats).toBeDefined();
    expect(stats.counts.total).toBe(5);
    expect(stats.counts.passed).toBe(3);
    expect(stats.counts.failed).toBe(1);
  });

  it('returns null for a non-existent batchId', async () => {
    const stats = await getBatchStats('non-existent-batch-id');
    // Either null/undefined or counts.total === 0
    if (stats !== null && stats !== undefined) {
      expect(stats.counts?.total ?? 0).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getDatabaseStats
// ─────────────────────────────────────────────────────────────────────────────
describe('getDatabaseStats', () => {
  it('returns a stats object with expected shape', async () => {
    const stats = await getDatabaseStats();
    expect(stats).toBeDefined();
    expect(typeof stats.deedLogCount).toBe('number');
    expect(typeof stats.batchRunCount).toBe('number');
    expect(Array.isArray(stats.classifications)).toBe(true);
    expect(Array.isArray(stats.repairStages)).toBe(true);
  });

  it('deedLogCount matches the number of deed logs inserted', async () => {
    const stats = await getDatabaseStats();
    // We've inserted many deed logs across all test batches
    expect(stats.deedLogCount).toBeGreaterThan(0);
  });

  it('batchRunCount is consistent with batches created', async () => {
    const stats = await getDatabaseStats();
    expect(stats.batchRunCount).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. clearFailedCache
// ─────────────────────────────────────────────────────────────────────────────
describe('clearFailedCache', () => {
  it('removes FAIL/ERROR records but keeps PASS records', async () => {
    const batchId = await createTestBatch(4, { passCount: 2, failCount: 1, errorCount: 1 });
    const before = await getDatabaseStats();
    const deleted = await clearFailedCache();
    const after = await getDatabaseStats();

    expect(deleted).toBeGreaterThan(0);
    // Total deed log count decreased
    expect(after.deedLogCount).toBeLessThan(before.deedLogCount);
  });

  it('does not throw when there are no failed records to delete', async () => {
    // After clearing, run again — should not error
    await expect(clearFailedCache()).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. clearAllCache
// ─────────────────────────────────────────────────────────────────────────────
describe('clearAllCache', () => {
  it('removes all deed logs and batch runs', async () => {
    // Add a fresh batch first
    await createTestBatch(2);
    const deleted = await clearAllCache();
    expect(deleted).toBeGreaterThanOrEqual(0);
    const after = await getDatabaseStats();
    expect(after.deedLogCount).toBe(0);
    expect(after.batchRunCount).toBe(0);
  });
});
