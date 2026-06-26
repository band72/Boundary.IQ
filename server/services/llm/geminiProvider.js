// ─── Gemini Provider ─────────────────────────────────────────────────────────
// Extracted from geminiVision.js.

import { GEMINI_API_KEY, ALLOW_API_FALLBACK, OLLAMA_FALLBACK_MODEL } from '../../config.js';
import { createChildLogger } from '../../logger.js';

const log = createChildLogger('geminiProvider');

const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 3000;
const FETCH_TIMEOUT_MS = 90_000;

import { getGeminiApiKey } from '../db/context.js';

let _geminiApiKey = GEMINI_API_KEY || null;

/** Override at runtime (called from dispatcher.init) */
export function setGeminiKey(key) { _geminiApiKey = key; }
export function getGeminiKey()    { return getGeminiApiKey(_geminiApiKey); }

// ── Retry-aware POST ──────────────────────────────────────────────────────────
async function postWithRetry(url, payload, customHeaders = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...customHeaders },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.text();
    if (res.ok) return { status: res.status, body };
    if (res.status === 429) {
      const lowerBody = body.toLowerCase();
      if (lowerBody.includes('quota') || lowerBody.includes('billing') || lowerBody.includes('exceeded')) {
        log.warn({ status: res.status, body: body.slice(0, 200) }, 'Gemini quota/billing exceeded, fast-failing');
        return { status: res.status, body };
      }
    }
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      log.warn({ attempt: attempt + 1, max: MAX_RETRIES, delaySec: (delay / 1000).toFixed(1), status: res.status }, 'Gemini rate-limited, retrying');
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return { status: res.status, body };
  }
  throw new Error('Exceeded maximum retry attempts.');
}

// ── Core Gemini extraction ────────────────────────────────────────────────────
export async function extractViaGemini(buffer, mimeType, prompt, model) {
  const apiKey = getGeminiApiKey(_geminiApiKey);
  if (!apiKey) throw new Error('Gemini API key not configured.');

  const parts = [{ text: prompt }];
  if (mimeType !== 'text/plain') {
    parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };

  let url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const customHeaders = {};

  const isAccessToken = !apiKey.startsWith('AIzaSy') && !apiKey.startsWith('AQ.');
  if (isAccessToken) {
    customHeaders['Authorization'] = `Bearer ${apiKey}`;
  } else {
    url += `?key=${apiKey}`;
  }

  const { status, body } = await postWithRetry(url, payload, customHeaders);

  if (status < 200 || status >= 300) {
    log.error({ status, body: body.slice(0, 200) }, 'Gemini API error');
    throw new Error(`Gemini API returned ${status}: ${body}`);
  }

  const doc = JSON.parse(body);
  const rawText = doc?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Unexpected Gemini response structure.');
  return rawText;
}

// ── Quota / error classifier ──────────────────────────────────────────────────
export function isGeminiQuotaError(err) {
  return err.message.includes('429') || err.message.includes('403') || err.message.includes('401') ||
         err.message.includes('RESOURCE_EXHAUSTED') || err.message.includes('PERMISSION_DENIED') ||
         err.message.includes('UNAUTHENTICATED') || err.message.includes('API_KEY_SERVICE_BLOCKED') ||
         err.message.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED');
}

export function isNetworkOrTimeoutError(err) {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('timeout') ||
         msg.includes('abort') ||
         msg.includes('fetch') ||
         msg.includes('network') ||
         msg.includes('eai_again') ||
         msg.includes('econnrefused') ||
         msg.includes('enotfound');
}

