// ─── OpenAI-Compatible Provider ──────────────────────────────────────────────
// Extracted from geminiVision.js. Works with Ollama /v1, LM Studio, llama.cpp.

import { OPENAI_BASE_URL } from '../../config.js';
import { createChildLogger } from '../../logger.js';
import { extractTextFromPdf, convertPdfToPng } from './pdfProcessor.js';
import { hasBoundaryKeywords, pruneLongText } from './ocrPostProcess.js';
import { getOpenaiApiKey, getOpenAiBaseUrl } from '../db/context.js';

const log = createChildLogger('openaiProvider');

const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 3000;
const FETCH_TIMEOUT_MS = 90_000;

export async function extractViaOpenAI(buffer, mimeType, prompt, model, baseUrl = OPENAI_BASE_URL) {
  const resolvedBaseUrl = getOpenAiBaseUrl(baseUrl);
  let userContent;

  if (mimeType === 'text/plain') {
    userContent = [{ type: 'text', text: prompt }];
  } else if (mimeType === 'application/pdf') {
    const extractedText = await extractTextFromPdf(buffer);
    if (extractedText && extractedText.length > 50 && hasBoundaryKeywords(extractedText)) {
      log.info({ chars: extractedText.length }, 'OpenAI-compat PDF: using text-only mode');
      userContent = [{
        type: 'text',
        text: `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${pruneLongText(extractedText)}`,
      }];
    } else {
      log.info('OpenAI-compat PDF: no digital text, converting to PNG');
      const pngBuffer = await convertPdfToPng(buffer);
      userContent = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBuffer.toString('base64')}` } },
      ];
    }
  } else {
    userContent = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } },
    ];
  }

  const payload = {
    model,
    messages: [{ role: 'user', content: userContent }],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  const url = `${resolvedBaseUrl.replace(/\/$/, '')}/chat/completions`;
  log.info({ url, model }, 'OpenAI-compat request');

  const headers = { 'Content-Type': 'application/json' };
  const apiKey = getOpenaiApiKey();
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        log.warn({ attempt: attempt + 1, status: res.status, delayMs: delay.toFixed(0) }, 'OpenAI-compat retrying');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`OpenAI-compatible endpoint returned ${res.status}: ${bodyText}`);
    }
    const doc = JSON.parse(bodyText);
    const rawText = doc?.choices?.[0]?.message?.content;
    if (!rawText) throw new Error('Unexpected OpenAI-compatible response structure.');
    log.info({ model, chars: rawText.length }, 'OpenAI-compat extraction complete');

    // Log token usage to database
    try {
      const inputTokens = doc?.usage?.prompt_tokens || 0;
      const outputTokens = doc?.usage?.completion_tokens || 0;
      const totalTokens = doc?.usage?.total_tokens || 0;

      import('../db/tokenUsage.js').then(({ logTokenUsage }) => {
        import('../db/context.js').then(({ getStore }) => {
          const store = getStore();
          logTokenUsage({
            userId: store?.userId,
            provider: 'openai',
            model,
            inputTokens,
            outputTokens,
            totalTokens,
            type: store?.aiRequestType || 'extraction',
          });
        }).catch(() => {});
      }).catch(() => {});
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to log token usage to DB');
    }

    return rawText;
  }
  throw new Error('Exceeded maximum retry attempts for OpenAI-compatible endpoint.');
}
