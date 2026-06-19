// ─── LLM Dispatcher ──────────────────────────────────────────────────────────
// Unified entry-point for all AI extraction. Manages active provider/model state
// and routes to the correct provider module.
// Extracted from geminiVision.js.

import * as ollama from '../ollamaVision.js';
import { extractViaGemini, setGeminiKey, isGeminiQuotaError, isNetworkOrTimeoutError } from './geminiProvider.js';
import { extractViaOpenAI } from './openaiProvider.js';
import {
  pdfOcrCache, computePdfHash, buildPdfCacheEntry, loadDiskCacheEntry,
  persistCacheEntry, extractTextFromPdf, convertPdfToPng, performLocalOcr,
} from './pdfProcessor.js';
import { hasBoundaryKeywords, pruneLongText, normalizeOcrText } from './ocrPostProcess.js';
import {
  ACTIVE_PROVIDER, ACTIVE_MODEL, OPENAI_BASE_URL,
  GEMINI_API_KEY, OCR_ENABLED,
} from '../../config.js';
import { createChildLogger } from '../../logger.js';

const log = createChildLogger('dispatcher');

// ── Mutable provider state (settable at runtime via /api/settings/model) ──────
let activeProvider   = ACTIVE_PROVIDER;
let activeModel      = ACTIVE_MODEL || (ACTIVE_PROVIDER === 'gemini' ? 'gemini-3.5-flash' : 'gemma4:26b');
let activeOpenAiBaseUrl = OPENAI_BASE_URL;

// ── Public config API ─────────────────────────────────────────────────────────

export function init(key) {
  if (key) {
    setGeminiKey(key);
    // Only automatically switch default provider if user has not explicitly requested a provider in .env
    if (!process.env.ACTIVE_PROVIDER) {
      activeProvider = 'gemini';
      activeModel = (ACTIVE_MODEL && ACTIVE_MODEL.startsWith('gemini')) ? ACTIVE_MODEL : 'gemini-3.5-flash';
      log.info({ provider: activeProvider, model: activeModel }, 'Gemini API key loaded — switched to gemini provider');
    } else if (activeProvider === 'gemini' && (!activeModel || !activeModel.startsWith('gemini'))) {
      // Prevent model/provider mismatch if user did set ACTIVE_PROVIDER=gemini but left ACTIVE_MODEL as a local model
      activeModel = 'gemini-3.5-flash';
    }
  }
}

export function getActiveProvider()  { return activeProvider; }
export function getActiveModel()     { return activeModel; }
export function getOpenAiBaseUrl()   { return activeOpenAiBaseUrl; }

export function setProvider(provider, model, baseUrl) {
  if (!['gemini', 'ollama', 'openai'].includes(provider)) {
    throw new Error(`Invalid provider "${provider}". Use "gemini", "ollama", or "openai".`);
  }
  activeProvider = provider;
  if (provider === 'gemini') {
    activeModel = model || 'gemini-3.5-flash';
  } else if (provider === 'ollama') {
    activeModel = model || 'gemma4:26b';
  } else {
    activeModel = model || 'llama3';
    if (baseUrl) activeOpenAiBaseUrl = baseUrl;
  }
  log.info({ provider: activeProvider, model: activeModel, baseUrl: provider === 'openai' ? activeOpenAiBaseUrl : undefined }, 'AI provider switched');
}

// ── Ollama extraction (handles PDF cache) ─────────────────────────────────────
async function extractViaOllama(buffer, mimeType, prompt, model) {
  let activeBuffer = buffer;
  let activeMime   = mimeType;
  let activePrompt = prompt;

  const modelIsVision = ollama.isVisionCapable(model);

  if (mimeType === 'text/plain') {
    activeBuffer = Buffer.alloc(0);
    activeMime   = 'image/png';
  } else if (mimeType === 'application/pdf') {
    const pdfHash = computePdfHash(buffer);

    // 1. Check in-memory LRU cache
    let cacheEntry = pdfOcrCache.get(pdfHash);

    // 2. Check disk cache (with TTL)
    if (!cacheEntry) {
      cacheEntry = loadDiskCacheEntry(pdfHash);
      if (cacheEntry) {
        log.info({ hash: pdfHash.slice(0, 8) }, 'Disk cache hit — loading OCR entry');
        pdfOcrCache.set(pdfHash, cacheEntry);
      }
    }

    // 3. Miss — build from scratch
    if (!cacheEntry) {
      log.info({ hash: pdfHash.slice(0, 8) }, 'Cache miss — processing PDF');
      cacheEntry = await buildPdfCacheEntry(buffer, pdfHash, modelIsVision);
      pdfOcrCache.set(pdfHash, cacheEntry);
      persistCacheEntry(pdfHash, cacheEntry);
    } else {
      log.info({ hash: pdfHash.slice(0, 8) }, 'Cache hit — reusing extraction');
    }

    // Route using cache entry
    if (!cacheEntry.isScanned) {
      log.info('Digitally-born PDF — text-only mode');
      activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted from PDF — use as primary source):\n=========================================\n${pruneLongText(normalizeOcrText(cacheEntry.extractedText))}`;
      activeBuffer = Buffer.alloc(0);
      activeMime   = 'image/png';
    } else {
      const ocrText = normalizeOcrText(cacheEntry.combinedOcrText || '');
      if (ocrText && ocrText.trim().length > 50) {
        log.info('Scanned PDF with OCR — text-only mode');
        activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted via combined local EasyOCR):\n=========================================\n${pruneLongText(ocrText)}`;
        activeBuffer = Buffer.alloc(0);
        activeMime   = 'image/png';
      } else if (!modelIsVision) {
        log.warn({ model }, 'Text-only model with insufficient OCR — short-circuiting');
        return JSON.stringify({
          Classification: 'LOT_BLOCK', PreambleFound: false, IsOpenEnded: false,
          MentalMapSummary: 'Insufficient OCR text for text-only model processing.',
          Segments: [],
        });
      } else {
        log.warn('Insufficient OCR — falling back to raw image');
        activeBuffer = cacheEntry.firstPageBuffer;
        activeMime   = 'image/png';
      }
    }
  }

  const { rawText } = await ollama.generate(activeBuffer, activeMime, model, activePrompt);
  if (!rawText) throw new Error('Ollama returned empty response.');
  return rawText;
}

// ── Unified dispatcher ────────────────────────────────────────────────────────
function shouldRunOcrForImage(mimeType, provider, model) {
  if (!mimeType || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return false;
  if (OCR_ENABLED) return true;
  if (provider === 'ollama' && !ollama.isVisionCapable(model)) return true;
  if (provider === 'openai') return true;
  return false;
}

export async function extractRaw(buffer, mimeType, prompt) {
  const provider = activeProvider;
  const model    = activeModel;

  let activePrompt = prompt;
  let activeBuffer = buffer;
  let activeMime   = mimeType;

  if (mimeType === 'text/plain') {
    const textContent = normalizeOcrText(buffer.toString('utf-8'));
    activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${pruneLongText(textContent)}`;
  } else if (shouldRunOcrForImage(mimeType, provider, model)) {
    log.info({ model, mimeType }, 'Performing local OCR on image file');
    const ocrText = await performLocalOcr(buffer);
    activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted via local EasyOCR):\n=========================================\n${pruneLongText(ocrText)}`;
    activeBuffer = Buffer.alloc(0);
    activeMime = 'image/png';
  }

  log.info({ provider, model, bufferKb: (activeBuffer.length / 1024).toFixed(0) }, 'AI extract started');

  if (provider === 'ollama') return extractViaOllama(activeBuffer, activeMime, activePrompt, model);
  if (provider === 'openai') return extractViaOpenAI(activeBuffer, activeMime, activePrompt, model, activeOpenAiBaseUrl);

  // Gemini with Ollama fallback on quota, timeout, or network connection errors
  try {
    return await extractViaGemini(activeBuffer, activeMime, activePrompt, model);
  } catch (err) {
    const allowFallback = process.env.ALLOW_API_FALLBACK !== 'false';
    const isQuota = isGeminiQuotaError(err);
    const isNetOrTimeout = isNetworkOrTimeoutError(err);
    if (allowFallback && (isQuota || isNetOrTimeout)) {
      const fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || 'gemma4:26b';
      const reason = isQuota ? 'quota/denied' : 'timeout/network error';
      log.warn({ err: err.message.slice(0, 80), fallback: fallbackModel, reason }, `Gemini API call failed (${reason}) — falling back to Ollama`);
      return extractViaOllama(activeBuffer, activeMime, activePrompt, fallbackModel);
    }
    throw err;
  }
}
