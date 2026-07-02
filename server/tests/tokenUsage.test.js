import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, switchDbPath } from '../services/db/core.js';
import { createUser, getAllUsers } from '../services/db/users.js';
import { logTokenUsage, getUserTokenStats } from '../services/db/tokenUsage.js';
import path from 'path';
import fs from 'fs';

describe('AI Token Tracking & Telemetry tests', () => {
  let testUserId;
  const TEST_DB_PATH = path.resolve('tests/token_usage_test.db');
  const username = `test_token_user_${Date.now()}`;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
    }
    switchDbPath(TEST_DB_PATH);
    // Create a temporary test user
    const user = await createUser(username, 'TestPassword123!', 'user');
    testUserId = user.id;
  });

  afterAll(async () => {
    const db = getDb();
    if (db) {
      db.close();
    }
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
      if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
    } catch (err) {}
  });


  it('successfully creates the TokenUsage table and verifies columns', async () => {
    const db = getDb();
    const info = db.prepare("PRAGMA table_info(TokenUsage)").all();
    const columns = info.map(c => c.name);

    expect(columns).toContain('Id');
    expect(columns).toContain('UserId');
    expect(columns).toContain('Provider');
    expect(columns).toContain('Model');
    expect(columns).toContain('InputTokens');
    expect(columns).toContain('OutputTokens');
    expect(columns).toContain('TotalTokens');
    expect(columns).toContain('Type');
    expect(columns).toContain('Timestamp');
  });

  it('can log token usage and fetch aggregates per user', async () => {
    // Log two separate AI submissions for the test user
    await logTokenUsage({
      userId: testUserId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputTokens: 150,
      outputTokens: 350,
      totalTokens: 500,
      type: 'deed-solve'
    });

    await logTokenUsage({
      userId: testUserId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputTokens: 200,
      outputTokens: 400,
      totalTokens: 600,
      type: 'plat-extraction'
    });

    // Retrieve stats
    const stats = await getUserTokenStats(testUserId);
    expect(stats.inputTokens).toBe(350);
    expect(stats.outputTokens).toBe(750);
    expect(stats.totalTokens).toBe(1100);
  });

  it('returns aggregated token usage in getAllUsers list', async () => {
    const users = await getAllUsers();
    const target = users.find(u => u.id === testUserId);

    expect(target).toBeDefined();
    expect(target.totalTokens).toBe(1100);
  });

  it('correctly maps GOOGLE_CLIENT_ID configuration from environment', async () => {
    const { GOOGLE_CLIENT_ID } = await import('../config.js');
    expect(GOOGLE_CLIENT_ID).toBe(process.env.GOOGLE_CLIENT_ID || undefined);
  });

  it('can associate BatchRuns with a UserId and query stats', async () => {
    const { saveBatchRun, getDb } = await import('../services/diagnosticsDb.js');
    const batchId = `test_batch_${Date.now()}`;
    
    // Save batch run for the test user
    await saveBatchRun(batchId, 3, 0.9, testUserId);

    const db = getDb();
    const row = db.prepare('SELECT UserId FROM BatchRuns WHERE BatchId = ?').get(batchId);
    expect(row).toBeDefined();
    expect(row.UserId).toBe(testUserId);
  });
});
