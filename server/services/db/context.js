import { AsyncLocalStorage } from 'async_hooks';
import {
  ACTIVE_PROVIDER, ACTIVE_MODEL, OPENAI_BASE_URL,
  ALLOW_API_FALLBACK, GEMINI_API_KEY, MAP_PAN_SENSITIVITY,
} from '../../config.js';

export const userSettingsStore = new AsyncLocalStorage();

export function getStore() {
  return userSettingsStore.getStore();
}

export function getActiveProvider(defaultVal = ACTIVE_PROVIDER) {
  const store = userSettingsStore.getStore();
  if (store?.activeProvider) return store.activeProvider;
  return defaultVal;
}

export function getActiveModel(defaultVal = ACTIVE_MODEL) {
  const store = userSettingsStore.getStore();
  if (store?.activeModel) return store.activeModel;
  return defaultVal || (ACTIVE_PROVIDER === 'gemini' ? 'gemini-3.5-flash' : 'gemma4:26b');
}

export function getOpenAiBaseUrl(defaultVal = OPENAI_BASE_URL) {
  const store = userSettingsStore.getStore();
  if (store?.openaiBaseUrl) return store.openaiBaseUrl;
  return defaultVal;
}

export function getAllowApiFallback(defaultVal = process.env.ALLOW_API_FALLBACK !== 'false') {
  const store = userSettingsStore.getStore();
  if (store?.allowApiFallback !== undefined) return store.allowApiFallback;
  return defaultVal;
}

export function getEnforceNoSelfIntersection(defaultVal = process.env.ENFORCE_NO_SELF_INTERSECTION === 'true') {
  const store = userSettingsStore.getStore();
  if (store?.enforceNoSelfIntersection !== undefined) return store.enforceNoSelfIntersection;
  return defaultVal;
}

export function getMapPanSensitivity(defaultVal = MAP_PAN_SENSITIVITY) {
  const store = userSettingsStore.getStore();
  if (store?.mapPanSensitivity !== undefined) return store.mapPanSensitivity;
  return defaultVal;
}

export function getGeminiApiKey(defaultVal = process.env.GEMINI_API_KEY || GEMINI_API_KEY) {
  const store = userSettingsStore.getStore();
  if (store?.geminiApiKey) return store.geminiApiKey;
  return defaultVal;
}

export function getOpenaiApiKey(defaultVal = process.env.OPENAI_API_KEY || '') {
  const store = userSettingsStore.getStore();
  if (store?.openaiApiKey) return store.openaiApiKey;
  return defaultVal;
}
