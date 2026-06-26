import { AsyncLocalStorage } from 'async_hooks';
import {
  ACTIVE_PROVIDER, ACTIVE_MODEL, OPENAI_BASE_URL,
  ALLOW_API_FALLBACK, GEMINI_API_KEY,
} from '../../config.js';

export const userSettingsStore = new AsyncLocalStorage();

export function getStore() {
  return userSettingsStore.getStore();
}

export function getActiveProvider() {
  const store = userSettingsStore.getStore();
  if (store?.activeProvider) return store.activeProvider;
  return ACTIVE_PROVIDER;
}

export function getActiveModel() {
  const store = userSettingsStore.getStore();
  if (store?.activeModel) return store.activeModel;
  return ACTIVE_MODEL || (ACTIVE_PROVIDER === 'gemini' ? 'gemini-3.5-flash' : 'gemma4:26b');
}

export function getOpenAiBaseUrl() {
  const store = userSettingsStore.getStore();
  if (store?.openaiBaseUrl) return store.openaiBaseUrl;
  return OPENAI_BASE_URL;
}

export function getAllowApiFallback() {
  const store = userSettingsStore.getStore();
  if (store?.allowApiFallback !== undefined) return store.allowApiFallback;
  return ALLOW_API_FALLBACK !== false;
}

export function getEnforceNoSelfIntersection() {
  const store = userSettingsStore.getStore();
  if (store?.enforceNoSelfIntersection !== undefined) return store.enforceNoSelfIntersection;
  return process.env.ENFORCE_NO_SELF_INTERSECTION === 'true';
}

export function getGeminiApiKey() {
  const store = userSettingsStore.getStore();
  if (store?.geminiApiKey) return store.geminiApiKey;
  return GEMINI_API_KEY;
}

export function getOpenaiApiKey() {
  const store = userSettingsStore.getStore();
  if (store?.openaiApiKey) return store.openaiApiKey;
  return process.env.OPENAI_API_KEY || '';
}
