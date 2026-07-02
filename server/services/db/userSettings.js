import { query } from './core.js';

export async function getUserSettings(userId) {
  const res = await query('SELECT * FROM UserSettings WHERE UserId = ?', [userId]);
  return res.rows[0] || null;
}

export async function saveUserSettings(userId, settings) {
  // Get existing settings to merge them
  const existing = await getUserSettings(userId) || {};

  const activeProvider = settings.activeProvider !== undefined ? settings.activeProvider : existing.ActiveProvider;
  const activeModel = settings.activeModel !== undefined ? settings.activeModel : existing.ActiveModel;
  const openaiBaseUrl = settings.openaiBaseUrl !== undefined ? settings.openaiBaseUrl : existing.OpenaiBaseUrl;
  const allowApiFallback = settings.allowApiFallback !== undefined ? (settings.allowApiFallback ? 1 : 0) : (existing.AllowApiFallback ?? 1);
  const enforceNoSelfIntersection = settings.enforceNoSelfIntersection !== undefined ? (settings.enforceNoSelfIntersection ? 1 : 0) : (existing.EnforceNoSelfIntersection ?? 0);
  const geminiApiKey = settings.geminiApiKey !== undefined ? settings.geminiApiKey : existing.GeminiApiKey;
  const openaiApiKey = settings.openaiApiKey !== undefined ? settings.openaiApiKey : existing.OpenaiApiKey;
  const mapPanSensitivity = settings.mapPanSensitivity !== undefined ? parseFloat(settings.mapPanSensitivity) : (existing.MapPanSensitivity ?? 0.55);

  await query(`
    INSERT INTO UserSettings (
      UserId, ActiveProvider, ActiveModel, OpenaiBaseUrl, 
      AllowApiFallback, EnforceNoSelfIntersection, GeminiApiKey, OpenaiApiKey, MapPanSensitivity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(UserId) DO UPDATE SET
      ActiveProvider = EXCLUDED.ActiveProvider,
      ActiveModel = EXCLUDED.ActiveModel,
      OpenaiBaseUrl = EXCLUDED.OpenaiBaseUrl,
      AllowApiFallback = EXCLUDED.AllowApiFallback,
      EnforceNoSelfIntersection = EXCLUDED.EnforceNoSelfIntersection,
      GeminiApiKey = EXCLUDED.GeminiApiKey,
      OpenaiApiKey = EXCLUDED.OpenaiApiKey,
      MapPanSensitivity = EXCLUDED.MapPanSensitivity
  `, [
    userId, activeProvider, activeModel, openaiBaseUrl,
    allowApiFallback, enforceNoSelfIntersection, geminiApiKey, openaiApiKey, mapPanSensitivity
  ]);

  return getUserSettings(userId);
}
