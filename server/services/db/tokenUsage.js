import { getDb, now } from './core.js';

/**
 * Log token usage for an AI submission.
 */
export function logTokenUsage({ userId, provider, model, inputTokens, outputTokens, totalTokens, type }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO TokenUsage (UserId, Provider, Model, InputTokens, OutputTokens, TotalTokens, Type, Timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId || null,
    provider,
    model,
    inputTokens || 0,
    outputTokens || 0,
    totalTokens || 0,
    type || 'unknown',
    now()
  );
}

/**
 * Get aggregated token stats for a specific user.
 */
export function getUserTokenStats(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT
      COALESCE(SUM(InputTokens), 0) as inputTokens,
      COALESCE(SUM(OutputTokens), 0) as outputTokens,
      COALESCE(SUM(TotalTokens), 0) as totalTokens
    FROM TokenUsage
    WHERE UserId = ?
  `).get(userId) || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}
