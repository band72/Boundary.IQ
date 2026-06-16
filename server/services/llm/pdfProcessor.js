// ─── PDF Processor ────────────────────────────────────────────────────────────
// PDF→text extraction, PDF→PNG conversion, local OCR pipeline.
// Extracted from geminiVision.js.

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import { OCR_CACHE_DIR, OCR_CACHE_MAX_ENTRIES, OCR_CACHE_TTL_DAYS } from '../../config.js';
import { createChildLogger } from '../../logger.js';
import { postProcessOcrText, hasBoundaryKeywords } from './ocrPostProcess.js';

const log = createChildLogger('pdfProcessor');
const execFileAsync = promisify(execFile);

// ── LRU Cache (no extra dep) ─────────────────────────────────────────────────
class LRUCache {
  constructor(maxSize) {
    this.max = maxSize;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, v);
  }
  has(k) { return this.map.has(k); }
}

export const pdfOcrCache = new LRUCache(OCR_CACHE_MAX_ENTRIES);

// ── Persistent disk OCR cache dir ─────────────────────────────────────────────
const _CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const _DEFAULT_OCR_CACHE = path.join(_CONFIG_DIR, 'BoundaryQC', 'OcrCache');

export function getOcrCacheDir() {
  return OCR_CACHE_DIR || _DEFAULT_OCR_CACHE;
}

// Ensure default dir exists on startup
const _initOcrCache = getOcrCacheDir();
if (!fsSync.existsSync(_initOcrCache)) {
  try { fsSync.mkdirSync(_initOcrCache, { recursive: true }); }
  catch (err) { log.warn({ err: err.message }, 'Failed to create persistent OCR cache directory'); }
}

// ── Python command detection ──────────────────────────────────────────────────
let cachedPythonCommand = null;

async function getPythonCommand() {
  if (cachedPythonCommand) return cachedPythonCommand;
  for (const cmd of ['python3', 'python']) {
    try { await execFileAsync(cmd, ['--version']); cachedPythonCommand = cmd; return cmd; }
    catch {}
  }
  log.warn('Neither python3 nor python found in PATH. Defaulting to python.');
  cachedPythonCommand = 'python';
  return 'python';
}

// ── pdftoppm with PyMuPDF fallback ────────────────────────────────────────────
async function runPdfToPpm(args, timeout) {
  try {
    await execFileAsync('pdftoppm', args, { timeout });
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    log.info('pdftoppm not found in PATH. Attempting PyMuPDF Python fallback...');
    const pyCmd = await getPythonCommand();
    const baseDir = process.cwd();
    const serverDir = fsSync.existsSync(path.join(baseDir, 'server')) ? path.join(baseDir, 'server') : baseDir;
    const scriptPath = path.join(serverDir, 'services', 'pdf_to_png.py');
    const isSingleFile = args.includes('-singlefile');
    const rIdx = args.indexOf('-r');
    const dpi = rIdx !== -1 ? args[rIdx + 1] : '150';
    const tempPdfPath = args[args.length - 2];
    const tempPngPrefix = args[args.length - 1];
    const lIdx = args.indexOf('-l');
    const maxPages = lIdx !== -1 ? args[lIdx + 1] : '5';
    await execFileAsync(pyCmd, [scriptPath, tempPdfPath, tempPngPrefix, dpi, maxPages, isSingleFile ? 'true' : 'false'], {
      timeout,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    return true;
  }
}

// ── PDF → text ────────────────────────────────────────────────────────────────
export async function extractTextFromPdf(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text ? data.text.trim() : '';
  } catch (err) {
    log.warn({ err: err.message }, 'PDF text extraction failed, falling back to image conversion');
    return '';
  }
}

// ── PDF → single PNG ──────────────────────────────────────────────────────────
export async function convertPdfToPng(buffer) {
  const tempDir = path.join(os.tmpdir(), `biq_pdf_conv_${uuidv4().replace(/-/g, '')}`);
  await fs.mkdir(tempDir, { recursive: true });
  const tempPdfPath = path.join(tempDir, 'input.pdf');
  const tempPngPrefix = path.join(tempDir, 'output');
  const tempPngPath = tempPngPrefix + '.png';
  try {
    await fs.writeFile(tempPdfPath, buffer);
    log.debug('Converting PDF page to PNG via pdftoppm...');
    await runPdfToPpm(['-png', '-singlefile', '-r', '150', tempPdfPath, tempPngPrefix], 300000);
    const pngBytes = await fs.readFile(tempPngPath);
    log.debug({ kb: (pngBytes.length / 1024).toFixed(1) }, 'PDF→PNG conversion complete');
    return pngBytes;
  } finally {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ── PDF → multiple PNGs ───────────────────────────────────────────────────────
export async function convertPdfPagesToPngs(buffer, maxPages = 5) {
  const tempDir = path.join(os.tmpdir(), `biq_pdf_conv_${uuidv4().replace(/-/g, '')}`);
  await fs.mkdir(tempDir, { recursive: true });
  const tempPdfPath = path.join(tempDir, 'input.pdf');
  const tempPngPrefix = path.join(tempDir, 'output');
  try {
    await fs.writeFile(tempPdfPath, buffer);
    log.debug({ maxPages }, 'Converting PDF pages to PNGs via pdftoppm...');
    await runPdfToPpm(['-png', '-r', '150', '-f', '1', '-l', String(maxPages), tempPdfPath, tempPngPrefix], 300000);
    const files = await fs.readdir(tempDir);
    const pngFiles = files
      .filter(f => f.startsWith('output-') && f.endsWith('.png'))
      .sort((a, b) => parseInt(a.match(/output-(\d+)\.png/)?.[1] || '0') - parseInt(b.match(/output-(\d+)\.png/)?.[1] || '0'));
    const results = [];
    for (const f of pngFiles) {
      const pageNum = parseInt(f.match(/output-(\d+)\.png/)?.[1] || '0');
      results.push({ pageNum, buffer: await fs.readFile(path.join(tempDir, f)) });
    }
    log.info({ pages: results.length }, 'PDF pages converted to PNG');
    return results;
  } finally {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Local EasyOCR ─────────────────────────────────────────────────────────────
export async function performLocalOcr(pngBuffer) {
  const tempImgPath = path.join(os.tmpdir(), `biq_ocr_${uuidv4().replace(/-/g, '')}.png`);
  try {
    await fs.writeFile(tempImgPath, pngBuffer);
    const baseDir = process.cwd();
    const serverDir = fsSync.existsSync(path.join(baseDir, 'server')) ? path.join(baseDir, 'server') : baseDir;
    const ocrScriptPath = path.join(serverDir, 'services', 'ocr.py');
    const pyCmd = await getPythonCommand();
    const { stdout } = await execFileAsync(pyCmd, [ocrScriptPath, tempImgPath], {
      timeout: 120000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const rawOcr = stdout ? stdout.trim() : '';
    const ocrText = postProcessOcrText(rawOcr);
    log.info({ chars: ocrText.length }, 'Local OCR extraction complete');
    return ocrText;
  } catch (err) {
    log.warn({ err: err.message }, 'Local OCR extraction failed');
    return '';
  } finally {
    try { await fs.unlink(tempImgPath); } catch {}
  }
}

// ── Disk cache TTL check ──────────────────────────────────────────────────────
function isCacheStale(metaPath) {
  try {
    const { mtimeMs } = fsSync.statSync(metaPath);
    const ageMs = Date.now() - mtimeMs;
    const ttlMs = OCR_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
    return ageMs > ttlMs;
  } catch {
    return false;
  }
}

// ── Build PDF cache entry (miss path) ─────────────────────────────────────────
export async function buildPdfCacheEntry(buffer, pdfHash, modelIsVision) {
  const extractedText = await extractTextFromPdf(buffer);
  if (extractedText && extractedText.length > 50 && hasBoundaryKeywords(extractedText)) {
    let firstPageBuf = Buffer.alloc(0);
    if (modelIsVision) {
      try { firstPageBuf = await convertPdfToPng(buffer); } catch {}
    }
    return { isScanned: false, extractedText, combinedOcrText: '', firstPageBuffer: firstPageBuf };
  }

  log.info({ hash: pdfHash.slice(0, 8) }, 'No digital text — OCR scanning pages 1-10');
  const pages = await convertPdfPagesToPngs(buffer, 10);
  if (pages.length === 0) {
    log.warn('Multi-page conversion returned no pages — falling back to single-page conversion');
    try {
      const fallbackBuf = await convertPdfToPng(buffer);
      pages.push({ pageNum: 1, buffer: fallbackBuf });
    } catch (convErr) {
      log.error({ err: convErr.message }, 'Single-page fallback conversion failed');
    }
  }

  let combinedOcrText = '';
  let pagesWithKeywords = 0;
  let firstPageBuffer = pages[0]?.buffer || Buffer.alloc(0);
  for (const page of pages) {
    const pageText = await performLocalOcr(page.buffer);
    if (pageText && pageText.length > 50) {
      if (hasBoundaryKeywords(pageText)) {
        log.debug({ page: page.pageNum }, 'Page contains boundary keywords');
        combinedOcrText += `\n\n--- PAGE ${page.pageNum} LEGAL DESCRIPTION ---\n${pageText}`;
        pagesWithKeywords++;
        if (pagesWithKeywords === 1) firstPageBuffer = page.buffer;
      } else if (pagesWithKeywords === 0 && page.pageNum === 1) {
        combinedOcrText += `\n\n--- PAGE 1 TEXT (fallback) ---\n${pageText}`;
      }
    }
  }
  return { isScanned: true, extractedText: '', combinedOcrText, firstPageBuffer };
}

// ── Persist cache entry to disk ───────────────────────────────────────────────
export function persistCacheEntry(pdfHash, cacheEntry) {
  try {
    const ocrDir = getOcrCacheDir();
    if (!fsSync.existsSync(ocrDir)) fsSync.mkdirSync(ocrDir, { recursive: true });
    const metaPath = path.join(ocrDir, `${pdfHash}.json`);
    const pngPath  = path.join(ocrDir, `${pdfHash}_page1.png`);
    fsSync.writeFileSync(metaPath, JSON.stringify({
      isScanned: cacheEntry.isScanned,
      extractedText: cacheEntry.extractedText,
      combinedOcrText: cacheEntry.combinedOcrText,
    }, null, 2), 'utf8');
    if (cacheEntry.firstPageBuffer?.length > 0) {
      fsSync.writeFileSync(pngPath, cacheEntry.firstPageBuffer);
    }
    log.info({ hash: pdfHash.slice(0, 8) }, 'Persisted OCR cache entry to disk');
  } catch (writeErr) {
    log.warn({ err: writeErr.message }, 'Failed to write persistent OCR cache');
  }
}

// ── Load cache entry from disk ────────────────────────────────────────────────
export function loadDiskCacheEntry(pdfHash) {
  const ocrDir = getOcrCacheDir();
  try {
    const metaPath = path.join(ocrDir, `${pdfHash}.json`);
    const pngPath  = path.join(ocrDir, `${pdfHash}_page1.png`);
    if (!fsSync.existsSync(metaPath)) return null;
    if (isCacheStale(metaPath)) {
      log.info({ hash: pdfHash.slice(0, 8) }, 'Disk OCR cache entry is stale — will re-process');
      return null;
    }
    const metaJson = JSON.parse(fsSync.readFileSync(metaPath, 'utf8'));
    let firstPageBuffer = Buffer.alloc(0);
    if (fsSync.existsSync(pngPath)) firstPageBuffer = fsSync.readFileSync(pngPath);
    return {
      isScanned: metaJson.isScanned,
      extractedText: postProcessOcrText(metaJson.extractedText || ''),
      combinedOcrText: postProcessOcrText(metaJson.combinedOcrText || ''),
      firstPageBuffer,
    };
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to load from persistent OCR cache');
    return null;
  }
}

// ── Compute PDF hash ──────────────────────────────────────────────────────────
export function computePdfHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
