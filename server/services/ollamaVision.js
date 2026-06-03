// ─── Ollama Vision Service ──────────────────────────────────────────────────
// Provides boundary extraction using a local Ollama instance.
// Automatically routes to the correct Ollama API based on model family:
//   • Vision models (gemma4, llava, …) → /api/chat  + image content blocks
//   • Text-only models (qwen, deepseek, …) → /api/generate + format:'json'
// Ollama API docs: https://github.com/ollama/ollama/blob/main/docs/api.md

import { fetch, Agent } from 'undici';

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MAX_RETRIES = 1;   // Reduced from 2 — failing fast is better than hanging SSE for 30+ min

// Per-model inference timeout — 30 minutes to support slow CPU hardware
const MODEL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
function modelTimeout(model) {
  return MODEL_TIMEOUT_MS;
}

// Reusable dispatcher — connect/headers/body timeouts stay long (model controls the limit)
const ollamaAgent = new Agent({
  connectTimeout: 30000,
  headersTimeout: 1800000,
  bodyTimeout: 1800000,
});

// ── Global Ollama concurrency semaphore ───────────────────────────────
// Ollama is single-threaded: concurrent requests queue behind each other,
// each consuming 30 min of wall time. Limit to 1 active inference at a time.
// Multiple batch routes can run in parallel but they wait HERE for Ollama.
let _ollamaActive = 0;
const _ollamaQueue = [];
const OLLAMA_MAX_CONCURRENT = 1;

function ollamaAcquire() {
  return new Promise(resolve => {
    if (_ollamaActive < OLLAMA_MAX_CONCURRENT) {
      _ollamaActive++;
      resolve();
    } else {
      _ollamaQueue.push(resolve);
    }
  });
}
function ollamaRelease() {
  if (_ollamaQueue.length > 0) {
    const next = _ollamaQueue.shift();
    next(); // keep _ollamaActive at 1
  } else {
    _ollamaActive--;
  }
}

// ── Model family detection ────────────────────────────────────────────────────
// Vision models support multimodal /api/chat with image content blocks.
// Text-only models use /api/generate with format:'json' for structured output.
const VISION_MODEL_PREFIXES = [
  'gemma4', 'llava', 'minicpm-v', 'bakllava', 'moondream', 'llava-phi', 'llava-llama',
];

function isVisionModel(model) {
  const lower = (model || '').toLowerCase();
  return VISION_MODEL_PREFIXES.some(p => lower.startsWith(p));
}

/** Public alias — used by geminiVision.js to determine routing */
export function isVisionCapable(model) { return isVisionModel(model); }

// ── Status helpers ────────────────────────────────────────────────────────────

/**
 * Check if Ollama is reachable and return available models.
 * @returns {Promise<{ online: boolean, models: string[], error?: string }>}
 */
export async function getStatus() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(3000),
      dispatcher: ollamaAgent,
    });
    if (!res.ok) return { online: false, models: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    return { online: true, models };
  } catch (ex) {
    return { online: false, models: [], error: ex.message };
  }
}

/**
 * Check if an OpenAI-compatible endpoint is reachable and return its model list.
 * Works with Ollama /v1, LM Studio, llama.cpp server, etc.
 * @param {string} baseUrl  e.g. "http://127.0.0.1:11434/v1"
 * @returns {Promise<{ online: boolean, models: string[], error?: string }>}
 */
export async function getStatusOpenAI(baseUrl) {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      dispatcher: ollamaAgent,
    });
    if (!res.ok) return { online: false, models: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.data || []).map(m => m.id).filter(Boolean);
    return { online: true, models };
  } catch (ex) {
    return { online: false, models: [], error: ex.message };
  }
}

// ── Vision model path: /api/chat with image content blocks ────────────────────

async function generateVisionChat(buffer, model, prompt) {
  // Ollama native /api/chat format:
  //   messages[].content  = plain string (the text prompt)
  //   messages[].images   = array of base64-encoded image strings (no data URI prefix)
  // Note: do NOT use OpenAI-style content-block arrays — Ollama rejects them with 400.
  const message = { role: 'user', content: prompt };
  if (buffer && buffer.length > 0) {
    message.images = [buffer.toString('base64')];
  }

  const payload = {
    model,
    messages: [message],
    stream: false,
    options: { temperature: 0.1, num_predict: 8192, num_ctx: 16384 },
    // NOTE: Do NOT set format:'json' — vision models may not honor it and it
    // can suppress the entire response. Rely on prompt instructions instead.
  };


  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(modelTimeout(model)),
        dispatcher: ollamaAgent,
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 404) {
          throw new Error(`Model "${model}" not found. Pull it with: ollama pull ${model}`);
        }
        if (attempt < MAX_RETRIES) {
          console.warn(`Ollama /chat ${res.status} on attempt ${attempt + 1}. Retrying…`);
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Ollama /api/chat returned ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const rawText = data.message?.content || '';
      if (!rawText.trim()) {
        throw new Error('Ollama returned empty response string.');
      }
      console.log(`Ollama vision [${model}] /chat → ${rawText.length} chars in ${((data.total_duration || 0) / 1e9).toFixed(1)}s`);
      return { rawText };
    } catch (ex) {
      if (ex.name === 'TimeoutError') {
        throw new Error(`Ollama /chat timed out. Model "${model}" may be too large for your hardware.`);
      }
      if (attempt === MAX_RETRIES) throw ex;
      console.warn(`Ollama /chat attempt ${attempt + 1} failed: ${ex.message}. Retrying…`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Exceeded maximum retry attempts for Ollama /api/chat.');
}

// ── Text-only model path: /api/generate with format:'json' ───────────────────

async function generateTextOnly(prompt, model) {
  const isReasoning = model.toLowerCase().includes('deepseek') || model.toLowerCase().includes('r1') || model.toLowerCase().includes('reasoning');
  const payload = {
    model,
    prompt,
    stream: false,
    options: { temperature: 0.1, num_predict: 8192, num_ctx: 16384 }
  };
  if (!isReasoning) {
    payload.format = 'json';
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(modelTimeout(model)),
        dispatcher: ollamaAgent,
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 404) {
          throw new Error(`Model "${model}" not found. Pull it with: ollama pull ${model}`);
        }
        if (attempt < MAX_RETRIES) {
          console.warn(`Ollama /generate ${res.status} on attempt ${attempt + 1}. Retrying…`);
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Ollama /api/generate returned ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const rawText = data.response || '';
      if (!rawText.trim()) {
        throw new Error('Ollama returned empty response string.');
      }
      console.log(`Ollama text [${model}] /generate → ${rawText.length} chars in ${((data.total_duration || 0) / 1e9).toFixed(1)}s`);
      return { rawText };
    } catch (ex) {
      if (ex.name === 'TimeoutError') {
        throw new Error(`Ollama /generate timed out. Model "${model}" may be too large for your hardware.`);
      }
      if (attempt === MAX_RETRIES) throw ex;
      console.warn(`Ollama /generate attempt ${attempt + 1} failed: ${ex.message}. Retrying…`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Exceeded maximum retry attempts for Ollama /api/generate.');
}

/**
 * Resolves a requested model name to one of the actually installed Ollama models.
 * E.g. "qwen2.5-coder:1.5b" -> "qwen2.5-coder:latest"
 */
async function resolveModelAlias(requestedModel) {
  try {
    const status = await getStatus();
    if (!status.online || !status.models || status.models.length === 0) {
      return requestedModel;
    }
    
    // If exact match exists, use it
    if (status.models.includes(requestedModel)) {
      return requestedModel;
    }
    
    // Try to find a fuzzy match
    const reqClean = requestedModel.toLowerCase().replace(/[:\-_]/g, '');
    const reqBase = requestedModel.split(':')[0].toLowerCase();
    
    // Sort models so that closer matches or 'latest' come first
    const sortedModels = [...status.models].sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      if (aLower.includes('latest') && !bLower.includes('latest')) return -1;
      if (!aLower.includes('latest') && bLower.includes('latest')) return 1;
      return 0;
    });

    for (const model of sortedModels) {
      const mLower = model.toLowerCase();
      const mClean = mLower.replace(/[:\-_]/g, '');
      const mBase = model.split(':')[0].toLowerCase();
      
      // Match base name or cleaned names
      if (mClean === reqClean || mBase === reqBase || reqClean.includes(mClean) || mClean.includes(reqClean)) {
        console.log(`[Ollama Model Resolve] Resolving requested model "${requestedModel}" to installed alias "${model}"`);
        return model;
      }
    }
  } catch (err) {
    console.warn('[Ollama Model Resolve] Resolution failed, using original name:', err.message);
  }
  return requestedModel;
}

// ── Unified entry-point ───────────────────────────────────────────────────────

/**
 * Route to the correct Ollama API based on model family.
 * @param {Buffer}  buffer   — image buffer (empty Buffer for text-only)
 * @param {string}  mimeType — e.g. 'image/png' or 'application/pdf'
 * @param {string}  model    — Ollama model name e.g. 'gemma4:e2b'
 * @param {string}  prompt   — extraction prompt (text already injected for PDFs)
 * @returns {Promise<{ rawText: string }>}
 */
export async function generate(buffer, mimeType, model, prompt) {
  const hasImage = buffer && buffer.length > 0;
  const resolvedModel = await resolveModelAlias(model);
  const vision = isVisionModel(resolvedModel);

  await ollamaAcquire();
  try {
    if (hasImage && vision) {
      console.log(`Ollama routing → /api/chat  [vision model: ${resolvedModel}]`);
      return await generateVisionChat(buffer, resolvedModel, prompt);
    }

    if (hasImage && !vision) {
      console.warn(`Ollama: text-only model "${resolvedModel}" received an image buffer it cannot process. Falling back to text-only prompt.`);
    }

    console.log(`Ollama routing → /api/generate [text model: ${resolvedModel}]`);
    return await generateTextOnly(prompt, resolvedModel);
  } finally {
    ollamaRelease();
  }
}

/**
 * Alias for compatibility — same as generate().
 */
export async function generateWithImage(buffer, mimeType, model, prompt) {
  return generate(buffer, mimeType, model, prompt);
}
