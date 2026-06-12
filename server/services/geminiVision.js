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

let cachedPythonCommand = null;
async function getPythonCommand() {
  if (cachedPythonCommand) return cachedPythonCommand;
  try {
    await execFileAsync('python3', ['--version']);
    cachedPythonCommand = 'python3';
  } catch (err) {
    try {
      await execFileAsync('python', ['--version']);
      cachedPythonCommand = 'python';
    } catch (err2) {
      console.warn('⚠️ Neither python3 nor python found in PATH. Defaulting to python.');
      cachedPythonCommand = 'python';
    }
  }
  return cachedPythonCommand;
}

async function runPdfToPpm(args, timeout) {
  try {
    await execFileAsync('pdftoppm', args, { timeout });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('pdftoppm not found in PATH. Attempting PyMuPDF Python fallback...');
      const pyCmd = await getPythonCommand();
      const baseDir = process.cwd();
      const serverDir = fsSync.existsSync(path.join(baseDir, 'server')) ? path.join(baseDir, 'server') : baseDir;
      const scriptPath = path.join(serverDir, 'services', 'pdf_to_png.py');
      
      let isSingleFile = args.includes('-singlefile');
      let rIdx = args.indexOf('-r');
      let dpi = rIdx !== -1 ? args[rIdx + 1] : '150';
      
      let tempPdfPath = args[args.length - 2];
      let tempPngPrefix = args[args.length - 1];
      
      let maxPages = '5';
      let lIdx = args.indexOf('-l');
      if (lIdx !== -1) {
        maxPages = args[lIdx + 1];
      }
      
      await execFileAsync(pyCmd, [
        scriptPath, tempPdfPath, tempPngPrefix, dpi, maxPages, isSingleFile ? 'true' : 'false'
      ], { 
        timeout,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      return true;
    }
    throw err;
  }
}

// Persistent Disk OCR Cache for Scanned PDFs
// Path is configurable at runtime via OCR_CACHE_DIR env var (Settings → Paths & Directories).
const _CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const _DEFAULT_OCR_CACHE = path.join(_CONFIG_DIR, 'BoundaryQC', 'OcrCache');
function getOcrCacheDir() {
  return process.env.OCR_CACHE_DIR || _DEFAULT_OCR_CACHE;
}
// Ensure default dir exists on startup (custom dir is created lazily on first write)
const _initOcrCache = getOcrCacheDir();
if (!fsSync.existsSync(_initOcrCache)) {
  try {
    fsSync.mkdirSync(_initOcrCache, { recursive: true });
  } catch (err) {
    console.warn('Failed to create persistent OCR cache directory:', err.message);
  }
}

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
    await runPdfToPpm([
      '-png', '-singlefile', '-r', '150', tempPdfPath, tempPngPrefix
    ], 300000);
    
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
    await runPdfToPpm([
      '-png', '-r', '150', '-f', '1', '-l', String(maxPages), tempPdfPath, tempPngPrefix
    ], 300000);
    
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
let activeProvider = process.env.ACTIVE_PROVIDER || 'ollama';     // 'gemini' | 'ollama' | 'openai'
let activeModel = process.env.ACTIVE_MODEL || (process.env.ACTIVE_PROVIDER === 'gemini' ? 'gemini-3.5-flash' : 'gemma4:26b');
let geminiApiKey = null;
let activeOpenAiBaseUrl = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 3000;

// ── Public Config API ───────────────────────────────────────────────────────

export function init(key) {
  geminiApiKey = key;
  if (key && !process.env.ACTIVE_PROVIDER) {
    activeProvider = 'gemini';
    activeModel = process.env.ACTIVE_MODEL || 'gemini-3.5-flash';
    console.log(`💡 Gemini API key loaded. Automatically set default provider to: gemini / ${activeModel}`);
  }
}

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
    activeModel = model || 'gemma4:26b';
  } else {
    // openai-compatible
    activeModel = model || 'llama3';
    if (baseUrl) activeOpenAiBaseUrl = baseUrl;
  }
  console.log(`🔄 AI Provider switched to: ${activeProvider} / ${activeModel}${provider === 'openai' ? ` (${activeOpenAiBaseUrl})` : ''}`);
}

// ── Retry-aware POST (Gemini only) ──────────────────────────────────────────
const FETCH_TIMEOUT_MS = 90_000; // 90 s — prevents infinite hang on API stall

async function postWithRetry(url, payload) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.text();

    if (res.ok) return { status: res.status, body };

    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(`Gemini ${res.status} on attempt ${attempt + 1}/${MAX_RETRIES}. Retrying in ${(delay/1000).toFixed(1)}s...`);
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

export function postProcessOcrText(text) {
  if (!text) return '';
  let cleaned = text;
  
  // ── Unicode normalization (Word typographic fonts + OCR artifacts) ──────────
  // Unicode prime marks → standard DMS punctuation
  cleaned = cleaned.replace(/\u2032/g, "'");   // U+2032 PRIME → minutes
  cleaned = cleaned.replace(/\u2033/g, '"');   // U+2033 DOUBLE PRIME → seconds
  cleaned = cleaned.replace(/\u2034/g, '"');   // U+2034 TRIPLE PRIME → seconds
  cleaned = cleaned.replace(/\u02B9/g, "'");   // MODIFIER LETTER PRIME
  cleaned = cleaned.replace(/\u02BA/g, '"');   // MODIFIER LETTER DOUBLE PRIME
  // Smart quotes → standard ASCII
  cleaned = cleaned.replace(/[\u2018\u2019\u201A\u02BC\u00B4]/g, "'");
  cleaned = cleaned.replace(/[\u201C\u201D\u201E]/g, '"');
  // Greek capital lookalikes → ASCII (appear in OCR of all-caps Word docs)
  cleaned = cleaned.replace(/\u039D/g, 'N');   // Ν → N
  cleaned = cleaned.replace(/\u0391/g, 'A');   // Α → A
  cleaned = cleaned.replace(/\u039F/g, 'O');   // Ο → O
  cleaned = cleaned.replace(/\u0395/g, 'E');   // Ε → E
  cleaned = cleaned.replace(/\u0397/g, 'H');   // Η → H
  cleaned = cleaned.replace(/\u039A/g, 'K');   // Κ → K
  cleaned = cleaned.replace(/\u039C/g, 'M');   // Μ → M
  cleaned = cleaned.replace(/\u03A1/g, 'R');   // Ρ → R
  cleaned = cleaned.replace(/\u03A4/g, 'T');   // Τ → T
  cleaned = cleaned.replace(/\u03A5/g, 'Y');   // Υ → Y
  cleaned = cleaned.replace(/\u03A7/g, 'X');   // Χ → X
  cleaned = cleaned.replace(/\u03A9/g, 'W');   // Ω → W

  // Standardize double single-quotes to double quotes
  cleaned = cleaned.replace(/'\s*'/g, '"');
  cleaned = cleaned.replace(/''/g, '"');

  // Replace asterisks used as degree symbols
  cleaned = cleaned.replace(/(\d{1,3})\s*\*/g, '$1°');

  // Correct hyphens in bearing notations with degrees-minutes-seconds (e.g., N 45-12-30 E -> N 45° 12\' 30" E)
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*([EWew])/g, '$1 $2° $3\' $4" $5');
  cleaned = cleaned.replace(/([Nn]orth|[Ss]outh)\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*([Ee]ast|[Ww]est)/g, '$1 $2° $3\' $4" $5');

  // Correct hyphens in bearing notations with degrees & minutes only (e.g., N 45-12 E -> N 45° 12\' E)
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})\s*-\s*(\d{1,2})\s*([EWew])/g, '$1 $2° $3\' $4');
  cleaned = cleaned.replace(/([Nn]orth|[Ss]outh)\s*(\d{1,2})\s*-\s*(\d{1,2})\s*([Ee]ast|[Ww]est)/g, '$1 $2° $3\' $4');

  // Replace degree symbol transcribing errors (e.g. "S 010 09'" -> "S 01° 09'")
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})0\s+(\d{1,2})['"]/g, '$1 $2° $3\'');
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})[oO-]\s*(\d{1,2})['"]/g, '$1 $2° $3\'');
  
  // e.g. "North 01- 09'" -> "North 01° 09'"
  cleaned = cleaned.replace(/([Nn]orth|[Ss]outh|[Ee]ast|[Ww]est)\s*(\d{1,2})[oO0-]\s*(\d{1,2})['"]/g, '$1 $2° $3\'');
  
  return cleaned;
}

// ── State name / abbreviation lookup table ───────────────────────────────────
const STATE_ABBREVS = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia',
  HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa',
  KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland',
  MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi',
  MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire',
  NJ:'New Jersey', NM:'New Mexico', NY:'New York', NC:'North Carolina',
  ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania',
  RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota', TN:'Tennessee',
  TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia', WA:'Washington',
  WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming', DC:'District of Columbia',
};
const STATE_NAMES_UPPER = new Set(Object.values(STATE_ABBREVS).map(s => s.toUpperCase()));

/**
 * Scrape county and state from raw OCR/deed text when LLM extraction misses them.
 * Handles patterns like:
 *   "Smith County"            → { county: "Smith County", state: null }
 *   "County of Smith"         → { county: "Smith County", state: null }
 *   "State of Texas"          → { county: null, state: "Texas" }
 *   "Smith County, Texas"     → { county: "Smith County", state: "Texas" }
 *   ", TX" or "(TX)"          → { county: null, state: "Texas" }
 *
 * @param {string} text  Raw OCR or deed text
 * @returns {{ county: string|null, state: string|null }}
 */
export function inferCountyStateFromText(text) {
  if (!text || typeof text !== 'string') return { county: null, state: null };

  let county = null;
  let state  = null;

  // ── County patterns ──────────────────────────────────────────────────────
  // Pattern A: "<Name> County" (most common US form)
  const countyA = text.match(/\b([A-Z][a-zA-Z]{1,25}(?:\s+[A-Z][a-zA-Z]{1,25})?)\s+County\b/);
  if (countyA) {
    const raw = countyA[1].trim();
    const STOPWORDS = /^(this|said|the|a|an|each|any|that|such|my|our|your|their|which|what|above|following)$/i;
    if (!STOPWORDS.test(raw)) {
      county = raw + ' County';
    }
  }

  // Pattern B: "County of <Name>"
  if (!county) {
    const countyB = text.match(/\bCounty\s+of\s+([A-Z][a-zA-Z]{2,25}(?:\s+[A-Z][a-zA-Z]{2,25})?)\b/);
    if (countyB) {
      county = countyB[1].trim() + ' County';
    }
  }

  // ── State patterns ───────────────────────────────────────────────────────
  // Pattern C: "State of <Name>"
  const stateC = text.match(/\bState\s+of\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/);
  if (stateC) {
    const candidate = stateC[1].trim();
    if (STATE_NAMES_UPPER.has(candidate.toUpperCase())) {
      state = candidate;
    }
  }

  // Pattern D: known state name appearing after county reference: "Smith County, Texas"
  if (!state) {
    const stateD = text.match(/\bCounty\s*,\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/);
    if (stateD) {
      const candidate = stateD[1].trim();
      if (STATE_NAMES_UPPER.has(candidate.toUpperCase())) {
        state = candidate;
      }
    }
  }

  // Pattern E: 2-letter state abbreviation in typical deed/survey context
  // e.g. ", TX" or "(TX)" near county or survey term
  if (!state) {
    const stateE = text.match(/(?:County|Survey|Township|Section|Range|Tract|Parcel)[^A-Z]{0,30}\b([A-Z]{2})\b/);
    if (stateE && STATE_ABBREVS[stateE[1]]) {
      state = STATE_ABBREVS[stateE[1]];
    }
  }

  return { county: county || null, state: state || null };
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
    
    const pyCmd = await getPythonCommand();
    const { stdout } = await execFileAsync(pyCmd, [ocrScriptPath, tempImgPath], { 
      timeout: 120000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
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

export function hasBoundaryKeywords(text) {
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
    
    // Check disk-based persistent cache if not in memory
    if (!cacheEntry) {
      const _ocrDir = getOcrCacheDir();
      try {
        const metaPath = path.join(_ocrDir, `${pdfHash}.json`);
        const pngPath = path.join(_ocrDir, `${pdfHash}_page1.png`);
        if (fsSync.existsSync(metaPath)) {
          console.log(`💾 Disk Cache Hit: Loading persistent OCR text for PDF (hash=${pdfHash})`);
          const metaJson = JSON.parse(fsSync.readFileSync(metaPath, 'utf8'));
          let firstPageBuffer = Buffer.alloc(0);
          if (fsSync.existsSync(pngPath)) {
            firstPageBuffer = fsSync.readFileSync(pngPath);
          }
          cacheEntry = {
            isScanned: metaJson.isScanned,
            extractedText: postProcessOcrText(metaJson.extractedText || ''),
            combinedOcrText: postProcessOcrText(metaJson.combinedOcrText || ''),
            firstPageBuffer
          };
          pdfOcrCache.set(pdfHash, cacheEntry);

        }
      } catch (cacheErr) {
        console.warn('Failed to load from persistent OCR cache:', cacheErr.message);
      }
    }
    
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
      
      // Save cache entry in memory and write to disk
      pdfOcrCache.set(pdfHash, cacheEntry);
      try {
        const _ocrDir = getOcrCacheDir();
        if (!fsSync.existsSync(_ocrDir)) fsSync.mkdirSync(_ocrDir, { recursive: true });
        const metaPath = path.join(_ocrDir, `${pdfHash}.json`);
        const pngPath = path.join(_ocrDir, `${pdfHash}_page1.png`);
        
        fsSync.writeFileSync(metaPath, JSON.stringify({
          isScanned: cacheEntry.isScanned,
          extractedText: cacheEntry.extractedText,
          combinedOcrText: cacheEntry.combinedOcrText
        }, null, 2), 'utf8');
        
        if (cacheEntry.firstPageBuffer && cacheEntry.firstPageBuffer.length > 0) {
          fsSync.writeFileSync(pngPath, cacheEntry.firstPageBuffer);
        }
        console.log(`💾 Persisted OCR cache entry to disk for PDF (hash=${pdfHash})`);
      } catch (writeErr) {
        console.warn('Failed to write persistent OCR cache:', writeErr.message);
      }
    } else {
      console.log(`⚡ Cache hit: Reusing OCR/text extraction for PDF (hash=${pdfHash})`);
    }

    // Now construct activePrompt and activeBuffer using the cacheEntry
    if (!cacheEntry.isScanned) {
      const extractedText = cacheEntry.extractedText;
      console.log(`Ollama PDF [CACHED]: digitally-born PDF (no scan) — running in text-only mode for speed.`);
      activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted from PDF — use as primary source):\n=========================================\n${pruneLongText(extractedText)}`;
      activeBuffer = Buffer.alloc(0);
      activeMime = 'image/png';
    } else {
      const combinedOcrText = cacheEntry.combinedOcrText;
      if (combinedOcrText && combinedOcrText.trim().length > 50) {
        console.log(`Ollama PDF [CACHED]: scanned PDF with local OCR — running in text-only mode for speed.`);
        activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted via combined local EasyOCR):\n=========================================\n${pruneLongText(combinedOcrText)}`;
        activeBuffer = Buffer.alloc(0);
        activeMime = 'image/png';
      } else {
        if (!modelIsVision) {
          console.warn(`⚠️ Ollama PDF: model "${model}" is text-only and PDF (hash=${pdfHash}) has insufficient OCR text. Short-circuiting to empty output to avoid slow hallucination/error.`);
          return JSON.stringify({
            Classification: "LOT_BLOCK",
            PreambleFound: false,
            IsOpenEnded: false,
            MentalMapSummary: "Insufficient OCR text for text-only model processing.",
            Segments: []
          });
        }
        console.warn('Ollama PDF [CACHED]: Insufficient OCR text. Falling back to raw image.');
        activeBuffer = cacheEntry.firstPageBuffer;
        activeMime = 'image/png';
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
  try {
    return await extractViaGemini(buffer, mimeType, activePrompt, model);
  } catch (err) {
    const allowFallback = process.env.ALLOW_API_FALLBACK !== 'false';
    const isQuotaOrDenied = err.message.includes('429') || err.message.includes('403') || 
                            err.message.includes('RESOURCE_EXHAUSTED') || err.message.includes('PERMISSION_DENIED');
    if (allowFallback && isQuotaOrDenied) {
      const fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || 'gemma4:26b';
      console.warn(`⚠️ Gemini API extraction failed (${err.message.slice(0, 80)}...). Falling back to local Ollama model (${fallbackModel})...`);
      return await extractViaOllama(buffer, mimeType, activePrompt, fallbackModel);
    }
    throw err;
  }
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
      try {
        rawText = await extractViaGemini(Buffer.alloc(0), 'text/plain', fallbackPrompt, model);
      } catch (err) {
        const allowFallback = process.env.ALLOW_API_FALLBACK !== 'false';
        const isQuotaOrDenied = err.message.includes('429') || err.message.includes('403') || 
                                err.message.includes('RESOURCE_EXHAUSTED') || err.message.includes('PERMISSION_DENIED');
        if (allowFallback && isQuotaOrDenied) {
          const fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || 'gemma4:26b';
          console.warn(`⚠️ Gemini conceptual fallback failed (${err.message.slice(0, 80)}...). Routing to local Ollama (${fallbackModel})...`);
          const { rawText: ot } = await ollama.generate(Buffer.alloc(0), 'text/plain', fallbackModel, fallbackPrompt);
          rawText = ot;
        } else {
          throw err;
        }
      }
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

  let { courses, classification, preambleFound, isOpenEnded, cleanJson, mentalMapSummary, conceptualAnalysis, referencePointName, commencementSegments, originalLegalDesc } = parseStructuredResponse(rawText);

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
      if (docText && docText.trim().length > 15) {
        conceptualAnalysis = await generateConceptualAnalysisFallback(docText);
      } else {
        conceptualAnalysis = "Insufficient text for conceptual analysis.";
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
    conceptualAnalysis: conceptualAnalysis || null,
    referencePointName: referencePointName || null,
    commencementSegments: commencementSegments || [],
    originalLegalDesc: originalLegalDesc || null
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
  const { courses, classification, preambleFound, isOpenEnded, cleanJson, originalLegalDesc } = parseStructuredResponse(rawText);
  return {
    rawJson: cleanJson, courses,
    message: `Stage 3 AI Repair (${activeProvider}/${activeModel}): ${courses.length} courses. Classification: ${classification}.`,
    classification, preambleFound, isOpenEnded: !!isOpenEnded,
    originalLegalDesc: originalLegalDesc || badExtraction.originalLegalDesc || null
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

  return courses.length >= 2 ? {
    courses,
    classification: 'METES_BOUNDS',
    preambleFound: false,
    isOpenEnded: false,
    cleanJson: text,
    mentalMapSummary: null,
    referencePointName: null,
    commencementSegments: []
  } : null;
}
function cleanInvalidJsonValues(jsonStr) {
  const lines = jsonStr.split(/\r?\n/);
  const cleanedLines = lines.map(line => {
    // Match "key": value, or "key": value
    const match = line.match(/^(\s*)"([^"]+)"\s*:\s*([\s\S]+?)\s*(,?)\s*$/);
    if (!match) return line;

    const indent = match[1];
    const key = match[2];
    const val = match[3].trim();
    const comma = match[4] || '';

    // Ignore structural lines
    if (val === '{' || val === '[' || val === '}' || val === ']') {
      return line;
    }

    // If it starts with " and ends with ", check for unescaped double quotes inside
    if (val.startsWith('"') && val.endsWith('"')) {
      let internal = val.slice(1, -1);
      // Escape all unescaped double quotes inside
      internal = internal.replace(/(?<!\\)"/g, '\\"');
      return `${indent}"${key}": "${internal}"${comma}`;
    }

    // If it starts with ' and ends with ', convert to double quotes and escape internal double quotes
    if (val.startsWith("'") && val.endsWith("'")) {
      let internal = val.slice(1, -1);
      internal = internal.replace(/(?<!\\)"/g, '\\"');
      return `${indent}"${key}": "${internal}"${comma}`;
    }

    // Check if it's a valid JSON constant or number
    const isConstant = ['true', 'false', 'null', 'undefined'].includes(val);
    const isNumber = /^-?\d+\.?\d*(?:[eE][-+]?\d+)?$/.test(val);
    let finalVal = val;

    if (isNumber) {
      finalVal = val.replace(/^(-?)0+(?=\d)/, '$1');
    }

    if (isConstant || isNumber) {
      return `${indent}"${key}": ${finalVal}${comma}`;
    }

    // Escape any unescaped double quotes in the value, then wrap in double quotes
    let cleanVal = val;
    cleanVal = cleanVal.replace(/(?<!\\)"/g, '\\"');

    return `${indent}"${key}": "${cleanVal}"${comma}`;
  });

  return cleanedLines.join('\n');
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
  
  // Clean JSON comments and trailing commas (DeepSeek-R1 / local LLM output sanitization)
  cleanJson = cleanJson.replace(/\/\/[^\n]*/g, '');
  cleanJson = cleanJson.replace(/\/\*[\s\S]*?\*\//g, '');
  cleanJson = cleanJson.replace(/,\s*([}\]])/g, '$1');
  cleanJson = cleanJson.trim();

  // Robustly quote any unquoted property values
  cleanJson = cleanInvalidJsonValues(cleanJson);

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

    const referencePointName = root.ReferencePointName || root.referencePointName || null;
    const rawCommSegments = root.CommencementSegments || root.commencementSegments || [];
    const commencementSegments = Array.isArray(rawCommSegments) ? parseSegmentArray(rawCommSegments) : [];

    const classification = root.Classification || root.classification || 'LOT_BLOCK';
    const preambleFound = root.PreambleFound === true || root.preambleFound === true;
    const mentalMapSummary = root.MentalMapSummary || root.mentalMapSummary || null;
    const conceptualAnalysis = root.ConceptualAnalysis || root.conceptualAnalysis || null;
    const originalLegalDesc = root.OriginalLegalDescription || root.originalLegalDescription || root.originalDeedText || root.OriginalDeedText || null;
    let courses = segments ? parseSegmentArray(segments) : [];

    if (isPlaceholderHallucination(courses)) {
      console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
      courses = [];
    }

    return { courses, classification, preambleFound, isOpenEnded, cleanJson, mentalMapSummary, conceptualAnalysis, referencePointName, commencementSegments, originalLegalDesc };
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
      return { courses, classification: 'METES_BOUNDS', preambleFound: false, isOpenEnded: false, cleanJson, mentalMapSummary: null, conceptualAnalysis: null, originalLegalDesc: null };
    }

    let courses = parseSegmentArray(root);

    if (isPlaceholderHallucination(courses)) {
      console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
      courses = [];
    }

    return { courses, classification: 'METES_BOUNDS', preambleFound: false, isOpenEnded: false, cleanJson, mentalMapSummary: null, conceptualAnalysis: null, originalLegalDesc: null };
  }

  throw new Error('Response root is neither an object with Segments nor an array.');
}

function parseSegmentArray(arr) {
  if (!arr || !Array.isArray(arr)) {
    console.warn('⚠️ parseSegmentArray received a non-array:', typeof arr, arr);
    return [];
  }
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
      const deltaVal = getNum(el, 'delta', 'Delta');
      const radiusVal = getNum(el, 'radius', 'Radius');
      const arcLengthVal = getNum(el, 'arcLength', 'ArcLength', 'arc_length', 'arcLength', 'arc_distance', 'arcDistance');
      const chordDistanceVal = getNum(el, 'chordDistance', 'ChordDistance', 'chord_distance', 'chordDistance');
      const hasChord = chordBearing && chordDistanceVal != null && chordDistanceVal !== 0;
      const hasParams = radiusVal != null && (deltaVal != null || arcLengthVal != null);
      const isUnknownReal = (hasChord || hasParams) ? false : isUnknown;

      return {
        type: 'Curve',
        bearing: null,
        distance: null,
        delta: deltaVal,
        radius: radiusVal,
        arcLength: arcLengthVal,
        curveDirection,
        chordBearing,
        chordDistance: chordDistanceVal,
        isUnknown: isUnknownReal,
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

    const distanceVal = getNum(el, 'distance', 'Distance');
    const hasLineProps = bearing && distanceVal != null && distanceVal !== 0;
    const hasDeflectProps = deflectionAngle != null && distanceVal != null && distanceVal !== 0;
    const isUnknownReal = (hasLineProps || hasDeflectProps) ? false : isUnknown;

    const course = {
      type: 'Line',
      bearing,
      distance: distanceVal,
      delta: null, radius: null, arcLength: null,
      curveDirection: null, chordBearing: null, chordDistance: null,
      isUnknown: isUnknownReal,
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
  b) Count the number of "thence" calls in the boundary description (excluding commencement). Every "thence" call in the boundary description MUST correspond to exactly one segment in your JSON Segments list. Do not omit, skip, or merge courses.
  c) Describe the general shape: "East side runs ~N, North side runs ~W," etc.
  d) Confirm path does NOT cross itself (no bow-tie). If it does, correct it now.
  e) Identify the Point of Beginning (POB) and confirm your last segment closes back to it.

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
  If a segment follows a meandering waterway, creek, river boundary, shoreline, road
  centerline, or other irregular line with no defined bearing and/or distance, set
  "IsUnknown": true and set bearing/distance to null. Do NOT fabricate or guess a bearing
  or distance. The system will mathematically solve the straight-line tie vector using
  inverse gap computation.

RULE 7 — DECOY ELIMINATION:
  IGNORE: dashed easement lines, setback lines, radial tie lines to circle centers,
  curve tables belonging to adjacent parcels. Only trace the HEAVY outer boundary.
  Before generating JSON, physically count boundary lines and state each quadrant direction
  to avoid transcribing decoy tables from adjacent lots.

RULE 7b — COMMENCEMENT RUNS & REFERENCES:
  IDENTIFY the Point of Reference (POR) (e.g., the section corner, subdivision corner, or benchmark mentioned in the text) and any commencement/reference runs leading from that Reference Point (POR) to the Point of Beginning (POB).
  - Populate the "ReferencePointName" field with the name or description of the Point of Reference (e.g. "the Southeast corner of Section 12"). If none is mentioned, set it to null.
  - Extract any commencement courses (bearings + distances) leading from the Reference Point (POR) to the Point of Beginning (POB) and populate them in the "CommencementSegments" array.
  - Do NOT include these commencement courses in the main "Segments" array. The main "Segments" array MUST only contain the property boundary courses starting FROM the Point of Beginning (POB) to keep the closure calculation correct.
  TIP: If a boundary course refers to a bearing from a commencement run (e.g. "continue the aforementioned bearing" or "along said Westerly boundary line"), resolve and extract that bearing for the boundary course, even though the commencement run itself is ignored in the JSON Segments list.

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

RULE 12 — DUAL DESCRIPTION / SAME PROPERTY REDESCRIBED:
  Some deeds contain TWO complete descriptions of the same property — e.g., an original
  deed description followed by "THIS IS THE SAME PROPERTY AS DESCRIBED IN [SURVEY]..." or
  "DESCRIBED AS FOLLOWS: FROM THE [point]..." (a second set of traverse calls).
  Signals to watch for:
    - "THIS IS THE SAME PROPERTY AS DESCRIBED IN..."
    - "BEING THE SAME LANDS AS DESCRIBED IN..."
    - A second "FROM THE [CORNER]" commence + "POINT OF BEGINNING" traverse after
      the first one has already closed.
    - "DESCRIBED AS FOLLOWS:" appearing twice in the document.
  When you detect this pattern:
    → Extract ONLY the SECOND (most recent, usually more precise) description.
    → The second description typically follows a surveyor's job reference (e.g., "Job No. 110750").
    → Ignore the first description entirely — it is superseded.
  WHY: The two descriptions are for the same parcel. Extracting both or mixing them
  will produce phantom extra courses that do not close.

RULE 13 — MULTI-PARCEL DEED (PARCEL 1, PARCEL 2, etc.):
  Some deeds describe multiple separate parcels under "PARCEL 1:", "PARCEL 2:", etc.
  Each parcel is a separate closed traverse.
  → Extract ONLY "PARCEL 1" (the first labeled parcel) unless the file explicitly
    asks for a different parcel.
  → Set Classification to "METES_BOUNDS" or "HYBRID" as appropriate for that parcel.
  → Set MentalMapSummary to describe only Parcel 1's shape.
  WHY: Concatenating two separate traverses creates an uncloseable polygon.

=========================================
OUTPUT JSON SCHEMA
=========================================
Return ONLY a valid JSON object in this EXACT format. No markdown fences, no explanation.

{
  "Classification": "METES_BOUNDS",
  "PreambleFound": false,
  "IsOpenEnded": false,
  "MentalMapSummary": "8 segments: East side runs NW, North side runs SW...",
  "OriginalLegalDescription": "The exact original, uncorrected legal description text isolated from the document (excluding title commitment headers, page numbers, and unrelated boilerplate, but keeping the exact metes-and-bounds text word-for-word).",
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
  "ReferencePointName": "Southeast corner of Section 12",
  "CommencementSegments": [
    {
      "Type": "Line",
      "Bearing": "N00°02'10\\"W",
      "Distance": 330.15,
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
