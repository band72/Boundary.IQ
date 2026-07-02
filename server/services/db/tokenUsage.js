import { query, now } from './core.js';

/**
 * Log token usage for an AI submission.
 */
export async function logTokenUsage({ userId, provider, model, inputTokens, outputTokens, totalTokens, type }) {
  await query(`
    INSERT INTO TokenUsage (UserId, Provider, Model, InputTokens, OutputTokens, TotalTokens, Type, Timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    userId || null,
    provider,
    model,
    inputTokens || 0,
    outputTokens || 0,
    totalTokens || 0,
    type || 'unknown',
    now()
  ]);
}

/**
 * Get aggregated token stats for a specific user.
 */
export async function getUserTokenStats(userId) {
  const res = await query(`
    SELECT
      COALESCE(SUM(InputTokens), 0) as inputTokens,
      COALESCE(SUM(OutputTokens), 0) as outputTokens,
      COALESCE(SUM(TotalTokens), 0) as totalTokens
    FROM TokenUsage
    WHERE UserId = ?
  `, [userId]);
  return res.rows[0] || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}
