import { fetch } from 'undici';
import * as ollama from './ollamaVision.js';
import pdfParse from 'pdf-parse';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);
const pdfOcrCache = new Map();

/**
 * Extract digital text from a PDF buffer.
 */
async function extractTextFromPdf(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text ? data.text.trim() : '';
  } catch (err) {
    console.warn('PDF text extraction failed, falling back to image conversion:', err.message);
    return '';
  }
}

/**
 * Convert a PDF page to a PNG buffer using pdftoppm.
 */
async function convertPdfToPng(buffer) {
  const tempDir = path.join(os.tmpdir(), `biq_pdf_conv_${uuidv4().replace(/-/g, '')}`);
  await fs.mkdir(tempDir, { recursive: true });
  
  const tempPdfPath = path.join(tempDir, 'input.pdf');
  const tempPngPrefix = path.join(tempDir, 'output');
  const tempPngPath = tempPngPrefix + '.png';
  
  try {
    await fs.writeFile(tempPdfPath, buffer);
    
    console.log(`Converting PDF page to PNG via pdftoppm...`);
    await execFileAsync('pdftoppm', [
      '-png', '-singlefile', '-r', '150', tempPdfPath, tempPngPrefix
    ], { timeout: 300000 });
    
    const pngBytes = await fs.readFile(tempPngPath);
    console.log(`Successfully converted PDF to PNG image buffer (${(pngBytes.length / 1024).toFixed(1)} KB)`);
    return pngBytes;
  } finally {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Convert multiple pages of a PDF buffer to an array of PNG buffers using pdftoppm.
 */
async function convertPdfPagesToPngs(buffer, maxPages = 5) {
  const tempDir = path.join(os.tmpdir(), `biq_pdf_conv_${uuidv4().replace(/-/g, '')}`);
  await fs.mkdir(tempDir, { recursive: true });
  
  const tempPdfPath = path.join(tempDir, 'input.pdf');
  const tempPngPrefix = path.join(tempDir, 'output');
  
  try {
    await fs.writeFile(tempPdfPath, buffer);
    
    console.log(`Converting first ${maxPages} PDF pages to PNGs via pdftoppm...`);
    await execFileAsync('pdftoppm', [
      '-png', '-r', '150', '-f', '1', '-l', String(maxPages), tempPdfPath, tempPngPrefix
    ], { timeout: 300000 });
    
    const files = await fs.readdir(tempDir);
    const pngFiles = files.filter(f => f.startsWith('output-') && f.endsWith('.png'));
    
    // Sort numerically by page number
    pngFiles.sort((a, b) => {
      const numA = parseInt(a.match(/output-(\d+)\.png/)?.[1] || '0');
      const numB = parseInt(b.match(/output-(\d+)\.png/)?.[1] || '0');
      return numA - numB;
    });
    
    const results = [];
    for (const f of pngFiles) {
      const pageNum = parseInt(f.match(/output-(\d+)\.png/)?.[1] || '0');
      const pngPath = path.join(tempDir, f);
      const pngBytes = await fs.readFile(pngPath);
      results.push({ pageNum, buffer: pngBytes });
    }
    
    console.log(`Successfully converted ${results.length} pages to PNG.`);
    return results;
  } finally {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Provider Config (mutable at runtime via /api/settings/model) ────────────
let activeProvider = 'ollama';     // 'gemini' | 'ollama' | 'openai'
let activeModel = 'gemma3:4b';
let geminiApiKey = null;
let activeOpenAiBaseUrl = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

// ── Public Config API ───────────────────────────────────────────────────────

export function init(key) { geminiApiKey = key; }

export function getActiveProvider() { return activeProvider; }
export function getActiveModel() { return activeModel; }
export function getOpenAiBaseUrl() { return activeOpenAiBaseUrl; }

export function setProvider(provider, model, baseUrl) {
  if (!['gemini', 'ollama', 'openai'].includes(provider))
    throw new Error(`Invalid provider "${provider}". Use "gemini", "ollama", or "openai".`);
  activeProvider = provider;
  if (provider === 'gemini') {
    activeModel = model || 'gemini-3.5-flash';
  } else if (provider === 'ollama') {
    activeModel = model || 'gemma3:4b';
  } else {
    // openai-compatible
    activeModel = model || 'llama3';
    if (baseUrl) activeOpenAiBaseUrl = baseUrl;
  }
  console.log(`🔄 AI Provider switched to: ${activeProvider} / ${activeModel}${provider === 'openai' ? ` (${activeOpenAiBaseUrl})` : ''}`);
}

// ── Retry-aware POST (Gemini only) ──────────────────────────────────────────
async function postWithRetry(url, payload) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.text();

    if (res.ok) return { status: res.status, body };

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(`Gemini 429 rate-limit on attempt ${attempt + 1}/${MAX_RETRIES}. Retrying in ${delay.toFixed(0)} ms.`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    return { status: res.status, body };
  }
  throw new Error('Exceeded maximum retry attempts.');
}

// ── Gemini Extraction ───────────────────────────────────────────────────────
async function extractViaGemini(buffer, mimeType, prompt, model) {
  if (!geminiApiKey) throw new Error('Gemini API key not configured.');

  const parts = [{ text: prompt }];
  if (mimeType !== 'text/plain') {
    const b64 = buffer.toString('base64');
    parts.push({ inlineData: { mimeType, data: b64 } });
  }

  const payload = {
    contents: [{
      parts,
    }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  const { status, body } = await postWithRetry(url, payload);

  if (status < 200 || status >= 300) {
    console.error(`Gemini API error ${status}: ${body}`);
    throw new Error(`Gemini API returned ${status}: ${body}`);
  }

  const doc = JSON.parse(body);
  const rawText = doc?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Unexpected Gemini response structure.');
  return rawText;
}

function postProcessOcrText(text) {
  if (!text) return '';
  let cleaned = text;
  
  // Replace degree symbol transcribing errors (e.g. "S 010 09'" -> "S 01° 09'")
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})0\s+(\d{1,2})['']/g, '$1 $2° $3\'');
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})[oO-]\s*(\d{1,2})['']/g, '$1 $2° $3\'');
  
  // e.g. "North 01- 09'" -> "North 01° 09'"
  cleaned = cleaned.replace(/([Nn]orth|[Ss]outh|[Ee]ast|[Ww]est)\s*(\d{1,2})[oO0-]\s*(\d{1,2})['']/g, '$1 $2° $3\'');
  
  return cleaned;
}

function pruneLongText(text) {
  if (!text || text.length < 6000) return text;
  
  const lower = text.toLowerCase();
  
  let earliestIdx = -1;
  
  // Find the first occurrence of the word "thence"
  const thenceMatch = text.match(/\bthence\b/i);
  if (thenceMatch) {
    earliestIdx = thenceMatch.index;
  }
  
  // Fallback/preamble indicators
  const indicators = [
    'commencing at',
    'commence at',
    'beginning at',
    'begin at'
  ];
  
  for (const ind of indicators) {
    const idx = lower.indexOf(ind);
    if (idx !== -1) {
      if (earliestIdx === -1 || idx < earliestIdx) {
        earliestIdx = idx;
      }
    }
  }

  // Lot & Block indicators to capture subdivision descriptions early
  const lotBlockIndicators = [
    /\b(?:lot|tract|parcel)\s+\d+/i,
    /\bblock\s+[a-z0-9]\b/i,
    /\bsubdivision\b/i,
    /\breplat\s+of\b/i,
    /\bplat\s+book\b/i
  ];
  for (const regex of lotBlockIndicators) {
    const match = text.match(regex);
    if (match) {
      if (earliestIdx === -1 || match.index < earliestIdx) {
        earliestIdx = match.index;
      }
    }
  }
  
  let startIdx = 0;
  if (earliestIdx !== -1) {
    // Keep 1200 characters before the match for context (preamble, parcel name, etc.)
    startIdx = Math.max(0, earliestIdx - 1200);
  }
  
  // Find trailing boundaries to strip exceptions/boilerplates that follow the legal description
  let endIdx = text.length;
  const trailingIndicators = [
    /^\s*schedule\s+b/im,
    /^\s*requirements/im,
    /^\s*exceptions\s+from\s+coverage/im,
    /^\s*exceptions:/im,
    /^\s*limitations\s+on\s+coverage/im,
    /^\s*exhibit\s+b/im
  ];
  
  const searchAreaStart = earliestIdx !== -1 ? earliestIdx : 0;
  const searchArea = lower.substring(searchAreaStart);
  
  let earliestEndIdx = -1;
  for (const regex of trailingIndicators) {
    const match = searchArea.match(regex);
    if (match) {
      const idx = match.index;
      if (earliestEndIdx === -1 || idx < earliestEndIdx) {
        earliestEndIdx = idx;
      }
    }
  }
  
  if (earliestEndIdx !== -1) {
    // Keep 100 characters of buffer for any end sentences
    endIdx = searchAreaStart + earliestEndIdx + 100;
    if (endIdx > text.length) endIdx = text.length;
  }
  
  if (startIdx > 0 || endIdx < text.length) {
    const sliced = text.substring(startIdx, endIdx);
    console.log(`✂️ Pruned long document text from ${text.length} to ${sliced.length} characters (start index: ${startIdx}, end index: ${endIdx}, match index: ${earliestIdx}).`);
    return sliced;
  }
  
  return text;
}

async function performLocalOcr(pngBuffer) {
  const tempImgPath = path.join(os.tmpdir(), `biq_ocr_${uuidv4().replace(/-/g, '')}.png`);
  try {
    await fs.writeFile(tempImgPath, pngBuffer);
    console.log(`Running local EasyOCR on converted PNG: ${tempImgPath}...`);
    
    const baseDir = process.cwd();
    const serverDir = fsSync.existsSync(path.join(baseDir, 'server')) ? path.join(baseDir, 'server') : baseDir;
    const ocrScriptPath = path.join(serverDir, 'services', 'ocr.py');
    
    const { stdout } = await execFileAsync('python3', [ocrScriptPath, tempImgPath], { timeout: 120000 });
    const rawOcr = stdout ? stdout.trim() : '';
    const ocrText = postProcessOcrText(rawOcr);
    console.log(`Local OCR extraction complete (${ocrText.length} characters).`);
    return ocrText;
  } catch (err) {
    console.warn(`Local OCR extraction failed:`, err.message);
    return '';
  } finally {
    try { await fs.unlink(tempImgPath); } catch {}
  }
}

function hasBoundaryKeywords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasDegrees = lower.includes('°') || lower.includes('*') || lower.includes('deg') || lower.includes('degree');
  const hasThence = lower.includes('thence');
  const hasPob = lower.includes('point of beginning') || lower.includes('p.o.b.') || lower.includes('pob') || lower.includes('commence');
  const hasFeet = lower.includes('feet') || lower.includes('foot') || lower.includes(' ft') || lower.includes('chs') || lower.includes('chains');
  const hasChords = lower.includes('chord') || lower.includes('curve') || lower.includes('radius');
  
  return (hasThence && (hasFeet || hasDegrees)) || hasPob || (hasChords && hasFeet);
}

// ── Ollama Extraction ───────────────────────────────────────────────────────
async function extractViaOllama(buffer, mimeType, prompt, model) {
  let activeBuffer = buffer;
  let activeMime = mimeType;
  let activePrompt = prompt;

  // Detect whether this model can process images
  const modelIsVision = ollama.isVisionCapable(model);

  if (mimeType === 'text/plain') {
    activeBuffer = Buffer.alloc(0);
    activeMime = 'image/png';
  } else if (mimeType === 'application/pdf') {
    const pdfHash = crypto.createHash('sha256').update(buffer).digest('hex');
    let cacheEntry = pdfOcrCache.get(pdfHash);
    
    if (!cacheEntry) {
      console.log(`Ollama PDF: Cache miss. Processing PDF (hash=${pdfHash})...`);
      const extractedText = await extractTextFromPdf(buffer);
      if (extractedText && extractedText.length > 50 && hasBoundaryKeywords(extractedText)) {
        let firstPageBuf = Buffer.alloc(0);
        if (modelIsVision) {
          try {
            firstPageBuf = await convertPdfToPng(buffer);
          } catch {}
        }
        cacheEntry = {
          isScanned: false,
          extractedText,
          combinedOcrText: '',
          firstPageBuffer: firstPageBuf
        };
      } else {
        console.log(`Ollama PDF: no digital text (${extractedText?.length ?? 0} chars) — converting pages 1 to 10 to PNG.`);
        const pages = await convertPdfPagesToPngs(buffer, 10);
        let combinedOcrText = '';
        let pagesWithKeywords = 0;
        let firstPageBuffer = pages[0]?.buffer || Buffer.alloc(0);
        
        if (pages.length === 0) {
          console.warn('Multi-page conversion returned no pages — falling back to single-page conversion.');
          try {
            const fallbackBuf = await convertPdfToPng(buffer);
            pages.push({ pageNum: 1, buffer: fallbackBuf });
            firstPageBuffer = fallbackBuf;
          } catch (convErr) {
            console.error('Single-page fallback conversion failed:', convErr.message);
          }
        }
        
        for (const page of pages) {
          const pageText = await performLocalOcr(page.buffer);
          if (pageText && pageText.length > 50) {
            if (hasBoundaryKeywords(pageText)) {
              console.log(`✓ Page ${page.pageNum} contains boundary keywords!`);
              combinedOcrText += `\n\n--- PAGE ${page.pageNum} LEGAL DESCRIPTION ---\n${pageText}`;
              pagesWithKeywords++;
              if (pagesWithKeywords === 1) {
                firstPageBuffer = page.buffer;
              }
            } else {
              console.log('Page ' + page.pageNum + ' does not appear to contain boundary geometry.');
              if (pagesWithKeywords === 0 && page.pageNum === 1) {
                combinedOcrText += `\n\n--- PAGE 1 TEXT (fallback) ---\n${pageText}`;
              }
            }
          }
        }
        cacheEntry = {
          isScanned: true,
          extractedText: '',
          combinedOcrText,
          firstPageBuffer
        };
      }
      pdfOcrCache.set(pdfHash, cacheEntry);
    } else {
      console.log(`⚡ Cache hit: Reusing OCR/text extraction for PDF (hash=${pdfHash})`);
    }

    // Now construct activePrompt and activeBuffer using the cacheEntry
    if (!cacheEntry.isScanned) {
      const extractedText = cacheEntry.extractedText;
      if (modelIsVision) {
        console.log(`Ollama PDF [CACHED]: vision model "${model}" — injecting text + PNG.`);
        activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted from PDF — use as primary source):\n=========================================\n${pruneLongText(extractedText)}`;
        activeBuffer = cacheEntry.firstPageBuffer;
        activeMime = 'image/png';
      } else {
        console.log(`Ollama PDF [CACHED]: text-only model "${model}" — text injection.`);
        activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${pruneLongText(extractedText)}`;
        activeBuffer = Buffer.alloc(0);
        activeMime = 'image/png';
      }
    } else {
      const combinedOcrText = cacheEntry.combinedOcrText;
      activeBuffer = cacheEntry.firstPageBuffer;
      activeMime = 'image/png';
      
      if (!modelIsVision) {
        if (combinedOcrText.trim().length > 50) {
          console.log(`Ollama PDF [CACHED]: text-only model "${model}" — injecting combined OCR text.`);
          activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted via combined local EasyOCR):\n=========================================\n${pruneLongText(combinedOcrText)}`;
          activeBuffer = Buffer.alloc(0);
        } else {
          console.warn('Ollama PDF [CACHED]: Insufficient text. Falling back to raw image.');
        }
      } else {
        if (combinedOcrText.trim().length > 50) {
          console.log(`Ollama PDF [CACHED]: vision model "${model}" — injecting combined OCR text + page PNG.`);
          activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted via combined local EasyOCR):\n=========================================\n${pruneLongText(combinedOcrText)}`;
        }
      }
    }
  }

  const { rawText } = await ollama.generate(activeBuffer, activeMime, model, activePrompt);
  if (!rawText) throw new Error('Ollama returned empty response.');
  return rawText;
}

// ── OpenAI-Compatible Extraction ─────────────────────────────────────────
async function extractViaOpenAI(buffer, mimeType, prompt, model, baseUrl) {
  let userContent;

  if (mimeType === 'text/plain') {
    userContent = [
      { type: 'text', text: prompt },
    ];
  } else if (mimeType === 'application/pdf') {
    // Try text extraction first (same as Ollama path)
    const extractedText = await extractTextFromPdf(buffer);
    if (extractedText && extractedText.length > 50 && hasBoundaryKeywords(extractedText)) {
      console.log(`OpenAI-compat PDF: extracted ${extractedText.length} chars, using text-only mode.`);
      userContent = [
        { type: 'text', text: `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${pruneLongText(extractedText)}` },
      ];
    } else {
      console.log(`OpenAI-compat PDF: no digital text, converting to PNG.`);
      const pngBuffer = await convertPdfToPng(buffer);
      const b64 = pngBuffer.toString('base64');
      userContent = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ];
    }
  } else {
    // Image (PNG, JPEG, TIFF, etc.)
    const b64 = buffer.toString('base64');
    userContent = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
    ];
  }

  const payload = {
    model,
    messages: [{ role: 'user', content: userContent }],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  console.log(`OpenAI-compat request → ${url} [${model}]`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const bodyText = await res.text();

    if (!res.ok) {
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(`OpenAI-compat ${res.status} on attempt ${attempt + 1}. Retrying in ${delay.toFixed(0)} ms.`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`OpenAI-compatible endpoint returned ${res.status}: ${bodyText}`);
    }

    const doc = JSON.parse(bodyText);
    const rawText = doc?.choices?.[0]?.message?.content;
    if (!rawText) throw new Error('Unexpected OpenAI-compatible response structure.');
    console.log(`OpenAI-compat [${model}] returned ${rawText.length} chars.`);
    return rawText;
  }
  throw new Error('Exceeded maximum retry attempts for OpenAI-compatible endpoint.');
}

// ── Unified Dispatcher ──────────────────────────────────────────────────────
async function extractRaw(buffer, mimeType, prompt) {
  const provider = activeProvider;
  const model = activeModel;

  let activePrompt = prompt;
  if (mimeType === 'text/plain') {
    const textContent = buffer.toString('utf-8');
    activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${pruneLongText(textContent)}`;
  }

  console.log(`AI Extract → provider=${provider}, model=${model}, bufferSize=${(buffer.length / 1024).toFixed(0)} KB`);

  if (provider === 'ollama') {
    return extractViaOllama(buffer, mimeType, activePrompt, model);
  }
  if (provider === 'openai') {
    return extractViaOpenAI(buffer, mimeType, activePrompt, model, activeOpenAiBaseUrl);
  }
  return extractViaGemini(buffer, mimeType, activePrompt, model);
}

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC API — identical signatures as before
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract boundary courses from an image/PDF buffer.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<object>} PlatExtractResult
 */
async function generateConceptualAnalysisFallback(docText) {
  const provider = activeProvider;
  const model = activeModel;
  
  const fallbackPrompt = `You are an expert Professional Land Surveyor. Analyze the following legal description text and extract a concise summary.
1. Identify the Lot number, Block number, and Subdivision name (if present).
2. Note standard lot size assumptions: standard residential lots are typically 0.15 acres (6,500 sq ft); commercial/subdivision tracts (e.g. Tract 1) are 1-5+ acres; government lots are 10-50 acres.
3. Estimate the size of any described easement/parcel/corridor and compare it to the standard lot size.

LEGAL DESCRIPTION TEXT:
${pruneLongText(docText)}

Return your response in this EXACT JSON format:
{
  "Description": "Detailed textual breakdown of the lots, blocks, or tracts mentioned.",
  "ParentTractSizeEstimate": "Estimated parent tract size (e.g. '3.2 acres')",
  "LotSizeEstimate": "Standard lot size assumption (e.g. '0.15 acres')",
  "RelativeComparison": "Comparison of relative sizes (e.g. 'The 1.098 acre road easement is equivalent to about 7 standard residential lots')"
}
Return ONLY valid JSON. No conversational text or markdown fences.`;

  console.log(`💡 Running fallback analysis LLM call via ${provider}/${model}...`);
  let rawText = '';
  try {
    if (provider === 'ollama') {
      const { rawText: ot } = await ollama.generate(Buffer.alloc(0), 'text/plain', model, fallbackPrompt);
      rawText = ot;
    } else if (provider === 'openai') {
      rawText = await extractViaOpenAI(Buffer.alloc(0), 'text/plain', fallbackPrompt, model, activeOpenAiBaseUrl);
    } else {
      rawText = await extractViaGemini(Buffer.alloc(0), 'text/plain', fallbackPrompt, model);
    }

    // Clean think tags and parse JSON
    const cleanText = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const start = cleanText.indexOf('{');
    const end = cleanText.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      const jsonStr = cleanText.substring(start, end + 1);
      return JSON.parse(jsonStr);
    }
  } catch (err) {
    console.warn('⚠️ Failed to parse fallback conceptual analysis:', err.message);
  }
  return {
    Description: rawText.substring(0, 500) || "Unable to extract description.",
    ParentTractSizeEstimate: "unknown",
    LotSizeEstimate: "0.15 acres",
    RelativeComparison: "unknown"
  };
}

export async function extractBoundary(buffer, mimeType, feedback = null) {
  let prompt = buildExtractionPrompt();
  if (feedback) {
    prompt += `\n\n=========================================\nCRITICAL RE-READ DIRECTIONS FROM THE SUPERVISOR / GEOMETRY ENGINE:\n=========================================\n${feedback}\n\nRe-read the original document and correct the segments list carefully based on this feedback.`;
  }
  const rawText = await extractRaw(buffer, mimeType, prompt);

  console.log(`${activeProvider} raw extraction:`, rawText.substring(0, 200) + '...');

  let { courses, classification, preambleFound, isOpenEnded, cleanJson, mentalMapSummary, conceptualAnalysis } = parseStructuredResponse(rawText);

  // Fallback: if LOT_BLOCK or courses is empty, and conceptualAnalysis is missing, run the targeted fallback LLM parser
  if ((classification === 'LOT_BLOCK' || courses.length === 0) && !conceptualAnalysis) {
    console.log('💡 ConceptualAnalysis is missing in raw JSON response. Executing lightweight fallback generator...');
    try {
      let docText = '';
      if (mimeType === 'text/plain') {
        docText = buffer.toString('utf-8');
      } else if (mimeType === 'application/pdf') {
        const pdfHash = crypto.createHash('sha256').update(buffer).digest('hex');
        const cached = pdfOcrCache.get(pdfHash);
        if (cached) {
          docText = (cached.extractedText || '') + '\n' + (cached.combinedOcrText || '');
        }
      }
      if (docText) {
        conceptualAnalysis = await generateConceptualAnalysisFallback(docText);
      }
    } catch (fallbackErr) {
      console.warn('⚠️ Conceptual analysis fallback generation failed:', fallbackErr.message);
    }
  }

  return {
    rawJson: cleanJson,
    courses,
    message: `Extracted ${courses.length} courses using ${activeProvider}/${activeModel}. Classification: ${classification}.`,
    classification,
    preambleFound,
    isOpenEnded: !!isOpenEnded,
    mentalMapSummary: mentalMapSummary || null,
    conceptualAnalysis: conceptualAnalysis || null
  };
}

/**
 * Stage 3: AI Misclosure Repair.
 */
export async function extractMisclosureRepair(buffer, mimeType, badExtraction, badTraverse) {
  const errorVector = `LinearError=${badTraverse.closure.linearError.toFixed(4)}ft, ` +
    `ErrorN=${badTraverse.closure.errorNorthing.toFixed(4)}, ` +
    `ErrorE=${badTraverse.closure.errorEasting.toFixed(4)}, ` +
    `Precision=${badTraverse.closure.precisionRatio}`;

  const repairPrompt = `You are an elite Professional Land Surveyor performing a MISCLOSURE REPAIR operation.
The boundary traverse below FAILED to close with the following error:
${errorVector}

The current extracted JSON segments are:
${badExtraction.rawJson}

Your task:
1. Study the original plat image carefully.
2. Identify which specific segment(s) contain transcription errors causing the closure failure.
3. Apply Quadrant Inversion (flip N↔S or E↔W) to any reversed bearings.
4. Correct any distances that appear to have OCR transcription errors (e.g., 1234.56 transcribed as 134.56).
5. Return the COMPLETE corrected segment list — same format as the input but with corrections applied.

Return ONLY the corrected JSON object (same schema as original extraction).`;

  const rawText = await extractRaw(buffer, mimeType, repairPrompt);

  console.log('Stage 3 Repair raw output:', rawText.substring(0, 200) + '...');
  const { courses, classification, preambleFound, isOpenEnded, cleanJson } = parseStructuredResponse(rawText);
  return {
    rawJson: cleanJson, courses,
    message: `Stage 3 AI Repair (${activeProvider}/${activeModel}): ${courses.length} courses. Classification: ${classification}.`,
    classification, preambleFound, isOpenEnded: !!isOpenEnded,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  JSON Parser (unchanged)
// ═══════════════════════════════════════════════════════════════════════════

function findDescriptionsRecursive(val, results = new Set()) {
  if (!val) return;
  if (typeof val === 'object') {
    const descKeys = ['description', 'Description', 'extracted_description', 'extractedDescription', 'text', 'Text', 'legal_description', 'legalDescription'];
    for (const k of descKeys) {
      if (typeof val[k] === 'string' && val[k].trim().length > 10) {
        results.add(val[k].trim());
      }
    }
    for (const k of Object.keys(val)) {
      if (typeof val[k] === 'object' && val[k] !== null) {
        findDescriptionsRecursive(val[k], results);
      }
    }
  }
}

export function parseFromTextFallback(text) {
  if (!text) return null;
  // Strip backslashes and collapse whitespace
  const normalizedText = text.replace(/\\/g, '').replace(/\s+/g, ' ');
  const parts = normalizedText.split(/\bthence\b/i);
  if (parts.length < 2) return null;

  const courses = [];
  // Skip parts[0] as it is the commencement/POB preamble
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    if (part.length < 8) continue;

    // Skip commencement course if it returns to POB before the final segment
    const isCommencement = (i < parts.length - 1) && 
      /to\s+(?:the\s+)?(?:point\s+of\s+beginning|p\.?\s*o\.?\s*b\.?)/i.test(part);
    if (isCommencement) {
      console.log(`Skipping commencement course: "${part.slice(0, 60)}..."`);
      continue;
    }

    // Clean part to remove next segment curve introduction keywords (like "to the point of curvature of a curve...")
    const cleanPart = part.replace(/\bto\s+(?:a|the)\s+(?:point\s+of\s+curvature|point\s+of\s+curve|pc|p\.c\.|beginning\s+of\s+(?:a|the)\s+curve)\b.*/is, '').trim();

    let bearing = null;
    const bearingMatch = cleanPart.match(/([NSns]\s*\d{1,3}\s*[\u00B0°\-]?\s*\d{1,2}\s*['\-]?\s*\d{1,2}(?:\.\d+)?\s*["\s]*[EWew])/)
      || cleanPart.match(/\b(North|South|East|West|N|S|E|W)\s*(\d{1,3})\s*[\u00B0°\-]?\s*(\d{1,2})\s*['\-]?\s*(\d{1,2}(?:\.\d+)?)\s*["\s]*(East|West|E|W)\b/i)
      || cleanPart.match(/\b(NORTHERLY|SOUTHERLY|EASTERLY|WESTERLY|NORTHEASTERLY|NORTHWESTERLY|SOUTHEASTERLY|SOUTHWESTERLY)\b/i);

    let remaining = cleanPart;
    if (bearingMatch) {
      bearing = bearingMatch[0].trim();
      remaining = cleanPart.replace(bearingMatch[0], '');
    }

    const distMatch = remaining.match(/([\d,]+\.\d+)/)
      || remaining.match(/([\d,]+\.?\d*)\s*(?:feet|foot|ft|meters|m)\b/i)
      || remaining.match(/([\d,]+\.?\d*)/);

    let distance = distMatch ? parseFloat(distMatch[1].replace(/,/g, '')) : null;

    if (bearing) {
      bearing = bearing
        .replace(/\bNorth\b/gi, 'N')
        .replace(/\bSouth\b/gi, 'S')
        .replace(/\bEast\b/gi, 'E')
        .replace(/\bWest\b/gi, 'W')
        .replace(/\s+/g, '');
    }

    // Detect if curve with flexible pattern support
    const radiusMatch = cleanPart.match(/radius\s+(?:of\s+)?([\d,]+\.?\d*)/i);
    const arcMatch = cleanPart.match(/(?:arc\s+distance|arc\s+length|arc|length|distance)\s+(?:of\s+)?([\d,]+\.?\d*)/i);
    const chordBrgMatch = cleanPart.match(/chord\s*bearing\s+(?:and\s+distance\s+)?(?:of\s+)?((?:[NSns]|North|South)\s*\d{1,3}[\d°\-\s'"\.\u00B0]+(?:[EWew]|East|West)\b|\b[A-Za-z]+\b)/i)
      || cleanPart.match(/bearing\s+(?:of\s+)?((?:[NSns]|North|South)\s*\d{1,3}[\d°\-\s'"\.\u00B0]+(?:[EWew]|East|West)\b|\b[A-Za-z]+\b)/i);
    const chordDistMatch = cleanPart.match(/chord\s*(?:bearing\s+and\s+)?distance\s+(?:of\s+)?(?:[NSns]|North|South|East|West)?[^,]{1,50}?,?\s*([\d,]+\.?\d*)\s*(?:feet|foot|ft)?/i)
      || cleanPart.match(/chord\s*(?:bearing\s+and\s+)?distance\s+(?:of\s+)?([\d,]+\.?\d*)/i)
      || cleanPart.match(/chord\s+(?:of\s+)?([\d,]+\.?\d*)/i);
    const dirMatch = cleanPart.match(/(?:curve\s+to\s+the|concave|direction)\s*([A-Za-z]+)/i);

    const isCurve = /curve|arc|radius/i.test(cleanPart) && (radiusMatch || arcMatch || chordBrgMatch);

    if (isCurve) {
      let chordBearing = chordBrgMatch ? chordBrgMatch[1].trim() : null;
      if (chordBearing && /^[a-z]+$/i.test(chordBearing) && !/^(north|south|east|west|northerly|southerly|easterly|westerly|northeasterly|northwesterly|southeasterly|southwesterly|ne|se|sw|nw)$/i.test(chordBearing)) {
        chordBearing = null;
      }
      if (chordBearing) {
        chordBearing = chordBearing
          .replace(/\bNorth\b/gi, 'N')
          .replace(/\bSouth\b/gi, 'S')
          .replace(/\bEast\b/gi, 'E')
          .replace(/\bWest\b/gi, 'W')
          .replace(/\s+/g, '');
      } else {
        chordBearing = bearing;
      }

      let chordDistance = chordDistMatch ? parseFloat(chordDistMatch[1].replace(/,/g, '')) : null;
      if (chordDistance == null) {
        chordDistance = distance;
      }

      courses.push({
        type: 'Curve',
        bearing: null,
        distance: null,
        delta: null,
        radius: radiusMatch ? parseFloat(radiusMatch[1].replace(/,/g, '')) : null,
        arcLength: arcMatch ? parseFloat(arcMatch[1].replace(/,/g, '')) : null,
        curveDirection: dirMatch ? dirMatch[1].trim() : null,
        chordBearing,
        chordDistance,
        isUnknown: !radiusMatch && !arcMatch && !chordBearing,
      });
    } else {
      courses.push({
        type: 'Line',
        bearing,
        distance,
        isUnknown: !bearing || distance == null,
      });
    }
  }

  return courses.length >= 2 ? { courses, classification: 'METES_BOUNDS', preambleFound: false, isOpenEnded: false, cleanJson: text, mentalMapSummary: null } : null;
}

function parseStructuredResponse(raw) {
  let cleanJson = raw.trim();
  
  // Find the first index of '<think', '<thought', '{', or '['
  const startMatch = cleanJson.match(/<(?:think|thought)|[{\[]/);
  if (startMatch && startMatch.index > 0) {
    cleanJson = cleanJson.substring(startMatch.index);
  }
  
  // Strip Ollama/DeepSeek reasoning think tags if present
  if (cleanJson.includes('<think>')) {
    cleanJson = cleanJson.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  if (cleanJson.includes('<thought>')) {
    cleanJson = cleanJson.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  }
  
  // Try direct parsing first
  try {
    const root = JSON.parse(cleanJson);
    if (root) {
      try {
        return getStructureFromRoot(root, cleanJson);
      } catch (structErr) {
        const resultSet = new Set();
        findDescriptionsRecursive(root, resultSet);
        const descs = Array.from(resultSet);
        if (descs.length > 0) {
          const fallbackResult = parseFromTextFallback(descs[0]);
          if (fallbackResult) {
            console.log(`💡 JSON structure missing standard keys, but successfully extracted ${fallbackResult.courses.length} courses from nested description.`);
            return fallbackResult;
          }
        }
        throw structErr;
      }
    }
  } catch (err) {
    // If direct parse fails, try to extract from markdown code blocks
    let m = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m) {
      const extracted = m[1].trim();
      try {
        const root = JSON.parse(extracted);
        if (root) {
          try {
            return getStructureFromRoot(root, extracted);
          } catch (structErr) {
            const resultSet = new Set();
            findDescriptionsRecursive(root, resultSet);
            const descs = Array.from(resultSet);
            if (descs.length > 0) {
              const fallbackResult = parseFromTextFallback(descs[0]);
              if (fallbackResult) return fallbackResult;
            }
            throw structErr;
          }
        }
      } catch (err2) {}
    }
    
    // If still fails, locate the first '{' and last '}'
    const startIdx = cleanJson.indexOf('{');
    const endIdx = cleanJson.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const extractedPos = cleanJson.substring(startIdx, endIdx + 1);
      try {
        const root = JSON.parse(extractedPos);
        if (root) {
          try {
            return getStructureFromRoot(root, extractedPos);
          } catch (structErr) {
            const resultSet = new Set();
            findDescriptionsRecursive(root, resultSet);
            const descs = Array.from(resultSet);
            if (descs.length > 0) {
              const fallbackResult = parseFromTextFallback(descs[0]);
              if (fallbackResult) return fallbackResult;
            }
            throw structErr;
          }
        }
      } catch (err3) {}
    }
  }

  // Fallback parsing logic
  try {
    let fallbackJson = cleanJson;
    if (fallbackJson.startsWith('```')) fallbackJson = fallbackJson.split('\n').slice(1).join('\n');
    if (fallbackJson.endsWith('```')) fallbackJson = fallbackJson.substring(0, fallbackJson.lastIndexOf('```'));
    fallbackJson = fallbackJson.trim();
    const root = JSON.parse(fallbackJson);
    try {
      return getStructureFromRoot(root, fallbackJson);
    } catch (structErr) {
      const resultSet = new Set();
      findDescriptionsRecursive(root, resultSet);
      const descs = Array.from(resultSet);
      if (descs.length > 0) {
        const fallbackResult = parseFromTextFallback(descs[0]);
        if (fallbackResult) return fallbackResult;
      }
      throw structErr;
    }
  } catch (finalErr) {
    try {
      const fallbackResult = parseFromTextFallback(raw);
      if (fallbackResult) {
        console.log(`💡 JSON parsing failed completely, but extracted ${fallbackResult.courses.length} courses via paragraph parser fallback on raw text.`);
        return fallbackResult;
      }
    } catch (err) {
      console.warn('Paragraph parser fallback failed:', err.message);
    }

    console.error('======================================================');
    console.error('🚨 JSON PARSING FAILED FOR RAW TEXT:');
    console.error('------------------------------------------------------');
    console.error(raw);
    console.error('======================================================');
    throw finalErr;
  }
}

export function isPlaceholderHallucination(courses) {
  if (!courses || courses.length === 0) return false;

  let matchCount = 0;
  for (const c of courses) {
    const bearingStr = (c.bearing || c.chordBearing || '').toString().toUpperCase();
    const dist = c.distance ?? c.chordDistance ?? 0;

    // Check 1: 150.25 and 45°22'10"
    if (Math.abs(dist - 150.25) < 0.01 && (bearingStr.includes("45°22") || bearingStr.includes("45D22") || bearingStr.includes("45.37") || bearingStr.includes("45°22'10\""))) {
      matchCount++;
    }
    // Check 2: 57.84 and Northerly/00°00'00"
    if (Math.abs(dist - 57.84) < 0.01 && (bearingStr.includes("NORTHERLY") || bearingStr.includes("00°00") || bearingStr.includes("0°00") || bearingStr.includes("00.00"))) {
      matchCount++;
    }
    // Check 3: 89.02 and 13°22'54" or deflection 13.3819
    if (Math.abs(dist - 89.02) < 0.01 && (bearingStr.includes("13°22") || bearingStr.includes("13D22") || c.deflectionAngle === 13.3819)) {
      matchCount++;
    }
    // Check 4: Curve R=200 and Delta=12.3015 or radius=150/100/80 and delta=10.3015/8.3015/6.3015
    if (c.type === 'Curve' &&
        (Math.abs((c.radius || 0) - 200) < 0.01 || Math.abs((c.radius || 0) - 150) < 0.01 || Math.abs((c.radius || 0) - 100) < 0.01 || Math.abs((c.radius || 0) - 80) < 0.01) &&
        (Math.abs((c.delta || 0) - 12.3015) < 0.001 || Math.abs((c.delta || 0) - 10.3015) < 0.001 || Math.abs((c.delta || 0) - 8.3015) < 0.001 || Math.abs((c.delta || 0) - 6.3015) < 0.001)) {
      matchCount++;
    }
    // Check 5: Curve chord distance 42.88 or 38.88/30.88/20.88/10.88
    if (c.type === 'Curve' &&
        (Math.abs((c.chordDistance || 0) - 42.88) < 0.01 || Math.abs((c.chordDistance || 0) - 38.88) < 0.01 || Math.abs((c.chordDistance || 0) - 30.88) < 0.01 || Math.abs((c.chordDistance || 0) - 20.88) < 0.01 || Math.abs((c.chordDistance || 0) - 10.88) < 0.01)) {
      matchCount++;
    }
  }

  return matchCount >= 2;
}

function constructFullBearing(bearing, direction) {
  if (!bearing || typeof bearing !== 'string') return bearing;
  let cleanBrg = bearing.trim();
  // If the bearing already starts with N/S/E/W/North/South/East/West, don't prepend direction
  if (/^[NSnsEWew]|^North|^South|^East|^West/i.test(cleanBrg)) {
    return cleanBrg;
  }
  if (direction && typeof direction === 'string') {
    const dir = direction.trim();
    if (/^(North|South|East|West|N|S|E|W)/i.test(dir)) {
      return dir + ' ' + cleanBrg;
    }
  }
  return cleanBrg;
}

function getStructureFromRoot(root, cleanJson) {
  // Container format: { "Classification": "...", "Segments": [...] }
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    let segments = root.Segments || root.segments || root.boundary || root.Boundary || root.legs || root.Legs || root.courses || root.Courses;
    let isOpenEnded = root.IsOpenEnded === true || root.isOpenEnded === true || root.isOpenEnded === 'true';

    // Support case where segments is an array of parcels instead of flat segments
    if (Array.isArray(segments) && segments.length > 0 && 
        (segments[0].Segments || segments[0].segments || segments[0].boundary || segments[0].Boundary || segments[0].legs || segments[0].Legs || segments[0].courses || segments[0].Courses)) {
      console.log(`💡 Detected multi-parcel structure mapped to "segments" array key.`);
      const firstParcel = segments[0];
      segments = firstParcel.Segments || firstParcel.segments || firstParcel.boundary || firstParcel.Boundary || firstParcel.legs || firstParcel.Legs || firstParcel.courses || firstParcel.Courses;
      if (firstParcel.IsOpenEnded !== undefined || firstParcel.isOpenEnded !== undefined) {
        isOpenEnded = (firstParcel.IsOpenEnded === true || firstParcel.isOpenEnded === true);
      }
    }

    // Support multi-parcel results from advanced models where Segments is null but Parcels array exists
    const parcels = root.Parcels || root.parcels;
    if ((!segments || segments.length === 0) && parcels && Array.isArray(parcels) && parcels.length > 0) {
      console.log(`💡 Detected "Parcels" array in root. Extracting first parcel: "${parcels[0].ParcelId || parcels[0].parcelId || 'unnamed'}"`);
      segments = parcels[0].Segments || parcels[0].segments || parcels[0].boundary || parcels[0].Boundary || parcels[0].legs || parcels[0].Legs || parcels[0].courses || parcels[0].Courses;
      if (parcels[0].IsOpenEnded !== undefined || parcels[0].isOpenEnded !== undefined) {
        isOpenEnded = parcels[0].IsOpenEnded === true || parcels[0].isOpenEnded === true;
      }
    }

    const classification = root.Classification || root.classification || 'LOT_BLOCK';
    const preambleFound = root.PreambleFound === true || root.preambleFound === true;
    const mentalMapSummary = root.MentalMapSummary || root.mentalMapSummary || null;
    const conceptualAnalysis = root.ConceptualAnalysis || root.conceptualAnalysis || null;
    let courses = segments ? parseSegmentArray(segments) : [];

    if (isPlaceholderHallucination(courses)) {
      console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
      courses = [];
    }

    return { courses, classification, preambleFound, isOpenEnded, cleanJson, mentalMapSummary, conceptualAnalysis };
  }

  // Legacy flat array
  if (Array.isArray(root)) {
    if (root.length > 0 && (root[0].legs || root[0].segments || root[0].Legs || root[0].Segments || root[0].boundary || root[0].Boundary || root[0].courses || root[0].Courses)) {
      console.log(`💡 Detected array of parcels in root array. Extracting first parcel: "${root[0].name || root[0].ParcelId || 'unnamed'}"`);
      const firstParcel = root[0];
      const segments = firstParcel.legs || firstParcel.segments || firstParcel.Legs || firstParcel.Segments || firstParcel.boundary || firstParcel.Boundary || firstParcel.courses || firstParcel.Courses;
      let courses = parseSegmentArray(segments);
      if (isPlaceholderHallucination(courses)) {
        console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
        courses = [];
      }
      return { courses, classification: 'METES_BOUNDS', preambleFound: false, isOpenEnded: false, cleanJson, mentalMapSummary: null, conceptualAnalysis: null };
    }

    let courses = parseSegmentArray(root);

    if (isPlaceholderHallucination(courses)) {
      console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
      courses = [];
    }

    return { courses, classification: 'METES_BOUNDS', preambleFound: false, isOpenEnded: false, cleanJson, mentalMapSummary: null, conceptualAnalysis: null };
  }

  throw new Error('Response root is neither an object with Segments nor an array.');
}

function parseSegmentArray(arr) {
  return arr.map(el => {
    const type = el.Type || el.type || 'Line';
    const isUnknown = el.IsUnknown === true || el.isUnknown === true;

    if (type.toLowerCase() === 'curve' || type.toLowerCase() === 'arc') {
      let chordBearing = el.chordBearing || el.ChordBearing || el.chord_bearing || null;
      let curveDirection = el.curveDirection || el.Direction || el.CurveDirection || el.curve_direction || el.direction || el.Direction || null;
      chordBearing = constructFullBearing(chordBearing, curveDirection);
      if (chordBearing && typeof chordBearing === 'string') {
        chordBearing = chordBearing.trim()
          .replace(/\bNorth\b/gi, 'N')
          .replace(/\bSouth\b/gi, 'S')
          .replace(/\bEast\b/gi, 'E')
          .replace(/\bWest\b/gi, 'W')
          .replace(/\s+/g, '');
      }
      return {
        type: 'Curve',
        bearing: null,
        distance: null,
        delta: getNum(el, 'delta', 'Delta'),
        radius: getNum(el, 'radius', 'Radius'),
        arcLength: getNum(el, 'arcLength', 'ArcLength', 'arc_length', 'arcLength', 'arc_distance', 'arcDistance'),
        curveDirection,
        chordBearing,
        chordDistance: getNum(el, 'chordDistance', 'ChordDistance', 'chord_distance', 'chordDistance'),
        isUnknown,
      };
    }

    // Line / Leg
    let bearing = el.bearing || el.Bearing || null;
    let direction = el.direction || el.Direction || null;
    bearing = constructFullBearing(bearing, direction);
    if (bearing && typeof bearing === 'string') {
      bearing = bearing.trim()
        .replace(/\bNorth\b/gi, 'N')
        .replace(/\bSouth\b/gi, 'S')
        .replace(/\bEast\b/gi, 'E')
        .replace(/\bWest\b/gi, 'W')
        .replace(/\s+/g, '');
    }
    if (!bearing && el.Quad) {
      const deg = el.Degrees ?? 0;
      const min = el.Minutes ?? 0;
      const sec = el.Seconds ?? 0;
      bearing = `${el.Quad[0]}${Math.floor(deg)}°${Math.floor(min)}'${(sec || 0).toFixed(1)}"${el.Quad.length > 1 ? el.Quad[1] : ''}`;
    }

    // Deflection angle courses — preserve the two deflection fields for resolveDeflectionAngles()
    const deflectionAngle     = getNum(el, 'deflectionAngle', 'DeflectionAngle') ?? null;
    const deflectionDirection = el.deflectionDirection || el.DeflectionDirection || null;

    const course = {
      type: 'Line',
      bearing,
      distance: getNum(el, 'distance', 'Distance'),
      delta: null, radius: null, arcLength: null,
      curveDirection: null, chordBearing: null, chordDistance: null,
      isUnknown,
    };

    if (deflectionAngle !== null && deflectionDirection) {
      course.deflectionAngle     = deflectionAngle;
      course.deflectionDirection = deflectionDirection.toString().toUpperCase();
      course.bearing             = null; // will be resolved by resolveDeflectionAngles()
    }

    return course;
  });
}


function getNum(el, ...keys) {
  for (const k of keys) {
    if (el[k] != null) {
      const v = el[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string') { const n = parseFloat(v); if (!isNaN(n)) return n; }
    }
  }
  return null;
}

// ── Extraction Prompt ───────────────────────────────────────────────────────
export function buildExtractionPrompt() {
  return `You are an elite, highly experienced Professional Land Surveyor and Computational Geometer.
Your core directive is to translate this unstructured land document (deed, map, or plat image)
into a mathematically perfect, logically sequential boundary traverse formatted as JSON.

=========================================
STEP 0 — DOCUMENT CLASSIFICATION
=========================================
First, classify the document into EXACTLY ONE of:
  - METES_BOUNDS     : Contains bearing + distance traverse calls (standard deed).
  - SECTION_BREAKDOWN: Pure PLSS aliquot description, no custom bearings.
  - QUALIFIED_PLSS   : Aliquot + road/line clip offset ("that part of...").
  - HYBRID           : PLSS location context + custom metes-and-bounds perimeter calls.
  - LOT_BLOCK        : Subdivision lot reference (Lot X, Block Y, Plat Name).
  - PLAT             : Full recorded plat image with multiple lots.

Also detect if a preamble is present (ends with "more particularly described" or similar).
Strip preamble text — extract ONLY the geometric boundary calls.

Also identify if the legal description represents an open-ended linear feature (such as an easement centerline, road right-of-way, or standard corridor strip) rather than a closed parcel loop. Set IsOpenEnded to true if it is an open-ended path, or false if it is a closed loop property boundary (even if there are small closure errors).

=========================================
STEP 1 — MENTAL MAP PRE-ANALYSIS
=========================================
Before generating JSON, perform these checks:
  a) Count the total number of segments (lines + curves) forming the PRIMARY boundary.
  b) Describe the general shape: "East side runs ~N, North side runs ~W," etc.
  c) Confirm path does NOT cross itself (no bow-tie). If it does, correct it now.
  d) Identify the Point of Beginning (POB) and confirm your last segment closes back to it.

=========================================
CORE MATHEMATICAL & DRAFTING RULES
=========================================

RULE 1 — TOPOLOGICAL SEQUENCE (Head-to-Tail):
  Physically re-trace the perimeter CLOCKWISE from POB. Verify Segment[N].endpoint
  geometrically touches Segment[N+1].startpoint. If a gap or backtrack is detected,
  automatically re-order the segment array until the path is continuous and returns to POB.

RULE 2 — BOW-TIE (Self-Intersection) PREVENTION:
  A property boundary can NEVER cross its own path. Project coordinate geometry using
  vector cross-products. If lines cross, flip the N/S or E/W quadrant of the offending
  bearing using Quadrant Inversion until no crossings exist.

RULE 3 — QUADRANT INVERSION:
  Place a mental crosshair at your current node. If the printed bearing points 180° AWAY
  from the actual line progression direction, invert both quadrants: N↔S and E↔W.
  Example: "N 45°22'10" E" becomes "S 45°22'10" W". Do NOT double-reverse.

RULE 4 — CURVE DIRECTION (Left vs. Right):
  Imagine driving a vehicle CLOCKWISE along the chord bearing:
  - Arc bows OUT to the LEFT of the driver (away from lot center) → "Left"
  - Arc bows OUT to the RIGHT of the driver (toward lot center) → "Right"
  Standard exterior rounded corners in a clockwise traverse are always Right turns.
  Cuts into the property interior are Left turns.

RULE 5 — EXPLICIT CHORD DATA (No Pixel Estimation):
  For ALL curve segments, you MUST extract the explicit CHORD BEARING and CHORD DISTANCE
  from the plat's curve table. NEVER estimate distances from pixel dimensions.
  Also extract: Delta (central angle), Radius, Arc Length.
  Hunt for hidden L-tag deflection curves (L1, L2, etc.) between straight segments.

RULE 6 — MEANDER BOUNDARIES:
  If a segment follows a meandering waterway or irregular line with no bearing given,
  set "IsUnknown": true. Do NOT fabricate a bearing. The system will mathematically
  solve the straight-line tie vector using inverse gap computation.

RULE 7 — DECOY ELIMINATION:
  IGNORE: dashed easement lines, setback lines, radial tie lines to circle centers,
  curve tables belonging to adjacent parcels. Only trace the HEAVY outer boundary.
  Before generating JSON, physically count boundary lines and state each quadrant direction
  to avoid transcribing decoy tables from adjacent lots.

RULE 7b — COMMENCEMENT RUNS ELIMINATION:
  IGNORE any "THENCE" clauses or course descriptions that occur BEFORE the actual "POINT OF BEGINNING" or "TO THE POINT OF BEGINNING" (these are commencement or reference runs leading TO the POB, not boundary lines). Only extract courses that describe the actual property boundary starting FROM the Point of Beginning.

RULE 8 — STRICT JSON FORMATTING:
  No leading zeros on integers. No unescaped newlines inside strings.
  No trailing commas. Bearing strings must use degree symbol (°), apostrophe ('), and
  quote (") for DMS. Format: "N45°30'00\\\"E".

RULE 9 — STRIP DEED / OPEN-ENDED SURVEY LINE:
  BEFORE extracting segments, scan the text for these definitive signals:
    Signal A: "a strip of land" or "strip of land X feet in width"
    Signal B: "point of termination" (the line terminates; it does NOT close back to POB)
    Signal C: "herein described survey line"
  If Signal A + Signal B are both present (or Signal C alone):
    \u2192 Set "IsOpenEnded": true
    \u2192 Set "Classification": "OPEN_ENDED"
    \u2192 Extract only the CENTERLINE courses (bearing + distance from POB to termination)
    \u2192 Set MentalMapSummary to describe the corridor width and direction
    \u2192 Do NOT include a closing course back to POB
  WHY: Strip parcels define a corridor of specified WIDTH along a centerline. The centerline
  runs point-to-point and never closes. Forcing closure produces a false linear error.

RULE 10 — DEFLECTION ANGLE COURSES:
  Some older deeds describe a change in direction as a DEFLECTION ANGLE rather than a compass bearing.
  These look like: "THENCE AT A DEFLECTION ANGLE TO THE LEFT OF 13°22'55\", a distance of 89.02 feet"
  or: "THENCE DEFLECTING RIGHT 45°00'00\", 200.00 feet to..."
  A deflection angle is a RELATIVE turn from the current direction of travel:
    LEFT  = counter-clockwise turn (the street or line bends to the left)
    RIGHT = clockwise turn (the street or line bends to the right)
  For these courses you MUST:
    \u2192 Set "Bearing": null (DO NOT guess a compass bearing)
    \u2192 Set "DeflectionAngle": the angle in decimal degrees (e.g. 13.3819 for 13°22'55")
    \u2192 Set "DeflectionDirection": "LEFT" or "RIGHT"
    \u2192 Set "Distance": the stated distance as usual
    \u2192 Set "IsUnknown": false
  The COGO engine will compute the correct absolute bearing automatically using the incoming course direction.
  WARNING: Do NOT convert deflection angles to compass bearings yourself — the relative/absolute
  transformation requires knowing the prior course direction, which only the COGO engine has.

RULE 11 — CARDINAL DIRECTION COURSES:
  Some older deeds use direction words without a precise bearing: "THENCE NORTHERLY 150 feet"
  or "THENCE WESTERLY AND ALONG OAK STREET 57.08 feet".
  For these courses:
    \u2192 Set "Bearing": the cardinal word as a string, e.g. "NORTHERLY", "WESTERLY", "SOUTHEASTERLY"
    \u2192 The COGO engine will resolve these to exact cardinal azimuths (N=0°, W=270°, etc.)
  Do NOT fabricate a precise DMS bearing (like N00°00'00"E) when the deed only says "northerly".

=========================================
OUTPUT JSON SCHEMA
=========================================
Return ONLY a valid JSON object in this EXACT format. No markdown fences, no explanation.

{
  "Classification": "METES_BOUNDS",
  "PreambleFound": false,
  "IsOpenEnded": false,
  "MentalMapSummary": "8 segments: East side runs NW, North side runs SW...",
  "Segments": [
    {
      "Type": "Line",
      "Bearing": "N45°22'10\\"E",
      "Distance": 150.25,
      "IsUnknown": false
    },
    {
      "Type": "Line",
      "Bearing": "NORTHERLY",
      "Distance": 57.84,
      "IsUnknown": false
    },
    {
      "Type": "Line",
      "Bearing": null,
      "DeflectionAngle": 13.3819,
      "DeflectionDirection": "LEFT",
      "Distance": 89.02,
      "IsUnknown": false
    },
    {
      "Type": "Curve",
      "Direction": "Right",
      "Radius": 200.00,
      "Delta": 12.3015,
      "ArcLength": 43.02,
      "ChordBearing": "N51°15'30\\"E",
      "ChordDistance": 42.88,
      "IsUnknown": false
    }
  ],
  "ReferencedParcelName": null,
  "Parcels": null,
  "ConceptualAnalysis": {
    "Description": "Thorough text analysis of the lots, blocks, or tracts mentioned in the deed, identifying the parent tract and subdivision lot/block hierarchy.",
    "ParentTractSizeEstimate": "Estimated or calculated size of the parent tract (e.g. '3.2 acres', '40 acres', or 'unknown').",
    "LotSizeEstimate": "Standard lot size assumption based on location/context (e.g. '0.15 acres' or 'unknown').",
    "RelativeComparison": "Comparison of the size of the subject parcel/easement to standard lots (e.g. 'The 1.098 acre easement is equivalent to about 7 standard residential lots')."
  }
}

IMPORTANT: Segments array must be in CLOCKWISE order starting with the first course
AFTER the POB, ending with the last course that returns TO the POB.
Do NOT include the POB itself as a segment.

REFERENCED PARCEL: If the boundary calls reference an ADJACENT or EXCEPTION parcel
(e.g. "LESS AND EXCEPT Lot 5", "along the boundary of Parcel B", "as described in Book 12, Page 34"),
set ReferencedParcelName to the name/reference of that parcel (e.g. "Lot 5, Block 2, Plat Book 12").
Otherwise set it to null.

MULTI-PARCEL: If the document contains MULTIPLE separate boundary loops
(e.g. "PARCEL A:...PARCEL B:...", or multiple BEGINNING AT blocks), set Parcels to an array:
[
  { "ParcelId": "A", "IsOpenEnded": false, "Segments": [...] },
  { "ParcelId": "B", "IsOpenEnded": true,  "Segments": [...] }
]
For strip deed parcels within a multi-parcel doc, set IsOpenEnded=true on that parcel entry.
and set Segments to the first parcel's segments only.
Otherwise set Parcels to null.

RULE 12 — NO PLACEHOLDER HALLUCINATION:
Under no circumstances should you ever return the exact example segments (e.g., N45°22'10"E, 150.25', etc.) shown in the output schema. If you cannot find any valid boundary courses or metes-and-bounds traverse calls in the document, you MUST return an empty segments array ("Segments": []) and set the classification to "LOT_BLOCK" or "PLAT" as appropriate. In this case, you MUST also populate the "ConceptualAnalysis" field with a thorough analysis of the subdivision lot/block hierarchy, estimating parent tract and lot sizes to provide relative perspective.

RULE 13 — TITLE COMMITMENTS & EXHIBITS:
If the text contains title commitment headers, commitment numbers, or references to "Exhibit A" or "Schedule A" (e.g. "OLD REPUBLIC INSURANCE", "Commitment Number", "Exhibit A"), you MUST ignore the document metadata (do not return "See Exhibit A"). Instead, locate the metes-and-bounds description starting with "more particularly described as follows" or "Begin at" on that page, and extract the bearings and distances into the Segments array.`;
}
