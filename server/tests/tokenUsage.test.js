import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../services/db/core.js';
import { createUser, getAllUsers } from '../services/db/users.js';
import { logTokenUsage, getUserTokenStats } from '../services/db/tokenUsage.js';

import { init } from '../services/diagnosticsDb.js';

describe('AI Token Tracking & Telemetry tests', () => {
  let testUserId;
  const username = `test_token_user_${Date.now()}`;

  beforeAll(async () => {
    await init();
    // Create a temporary test user
    const user = createUser(username, 'TestPassword123!', 'user');
    testUserId = user.id;
  });

  it('successfully creates the TokenUsage table and verifies columns', () => {
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

  it('can log token usage and fetch aggregates per user', () => {
    // Log two separate AI submissions for the test user
    logTokenUsage({
      userId: testUserId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputTokens: 150,
      outputTokens: 350,
      totalTokens: 500,
      type: 'deed-solve'
    });

    logTokenUsage({
      userId: testUserId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputTokens: 200,
      outputTokens: 400,
      totalTokens: 600,
      type: 'plat-extraction'
    });

    // Retrieve stats
    const stats = getUserTokenStats(testUserId);
    expect(stats.inputTokens).toBe(350);
    expect(stats.outputTokens).toBe(750);
    expect(stats.totalTokens).toBe(1100);
  });

  it('returns aggregated token usage in getAllUsers list', () => {
    const users = getAllUsers();
    const target = users.find(u => u.id === testUserId);

    expect(target).toBeDefined();
    expect(target.totalTokens).toBe(1100);
  });

  it('correctly maps GOOGLE_CLIENT_ID configuration from environment', async () => {
    const { GOOGLE_CLIENT_ID } = await import('../config.js');
    expect(GOOGLE_CLIENT_ID).toBe(process.env.GOOGLE_CLIENT_ID || undefined);
  });
});
