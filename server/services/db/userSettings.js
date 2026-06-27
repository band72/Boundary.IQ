import { getDb } from './core.js';

export function getUserSettings(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM UserSettings WHERE UserId = ?').get(userId);
}

export function saveUserSettings(userId, settings) {
  const db = getDb();
  
  // Get existing settings to merge them
  const existing = getUserSettings(userId) || {};
  
  const activeProvider = settings.activeProvider !== undefined ? settings.activeProvider : existing.ActiveProvider;
  const activeModel = settings.activeModel !== undefined ? settings.activeModel : existing.ActiveModel;
  const openaiBaseUrl = settings.openaiBaseUrl !== undefined ? settings.openaiBaseUrl : existing.OpenaiBaseUrl;
  const allowApiFallback = settings.allowApiFallback !== undefined ? (settings.allowApiFallback ? 1 : 0) : (existing.AllowApiFallback ?? 1);
  const enforceNoSelfIntersection = settings.enforceNoSelfIntersection !== undefined ? (settings.enforceNoSelfIntersection ? 1 : 0) : (existing.EnforceNoSelfIntersection ?? 0);
  const geminiApiKey = settings.geminiApiKey !== undefined ? settings.geminiApiKey : existing.GeminiApiKey;
  const openaiApiKey = settings.openaiApiKey !== undefined ? settings.openaiApiKey : existing.OpenaiApiKey;
  const mapPanSensitivity = settings.mapPanSensitivity !== undefined ? parseFloat(settings.mapPanSensitivity) : (existing.MapPanSensitivity ?? 0.55);

  db.prepare(`
    INSERT INTO UserSettings (
      UserId, ActiveProvider, ActiveModel, OpenaiBaseUrl, 
      AllowApiFallback, EnforceNoSelfIntersection, GeminiApiKey, OpenaiApiKey, MapPanSensitivity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(UserId) DO UPDATE SET
      ActiveProvider = excluded.ActiveProvider,
      ActiveModel = excluded.ActiveModel,
      OpenaiBaseUrl = excluded.OpenaiBaseUrl,
      AllowApiFallback = excluded.AllowApiFallback,
      EnforceNoSelfIntersection = excluded.EnforceNoSelfIntersection,
      GeminiApiKey = excluded.GeminiApiKey,
      OpenaiApiKey = excluded.OpenaiApiKey,
      MapPanSensitivity = excluded.MapPanSensitivity
  `).run(
    userId, activeProvider, activeModel, openaiBaseUrl,
    allowApiFallback, enforceNoSelfIntersection, geminiApiKey, openaiApiKey, mapPanSensitivity
  );

  return getUserSettings(userId);
}
