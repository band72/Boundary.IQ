// ─── Text Extractor Service ───────────────────────────────────────────────────
// Extracts plain text from PDF, Word (via LibreOffice), and image documents.
// Handles caching, OCR fallback, and Word-to-PDF conversion.
//
// Extracted from server/routes/folderScan.js for testability and reuse.

import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import { convertToPdf, isWordDocument } from './docConversion.js';
import { ocrFile as ocrDaemonFile } from './ocrDaemon.js';
import { hasBoundaryKeywords } from './llm/ocrPostProcess.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('textExtractor');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the OCR cache directory path.
 * Respects the OCR_CACHE_DIR env var, then falls back to
 * ~/.config/BoundaryQC/OcrCache (XDG-compatible).
 */
function getOcrCacheDir() {
  if (process.env.OCR_CACHE_DIR) return process.env.OCR_CACHE_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'BoundaryQC', 'OcrCache');
}

// ── Text Extraction ───────────────────────────────────────────────────────────

/**
 * Ensure that extracted plain text is available for a given document,
 * reading from a per-folder `_extracted/` cache when possible, and
 * falling back to PDF text extraction or OCR daemon when needed.
 *
 * @param {string}  filePath   - Absolute path to the source document
 * @param {string}  fileName   - Basename of the document
 * @param {Buffer}  fileBytes  - Raw bytes of the document
 * @param {string}  validPath  - Folder that owns the `_extracted/` sub-directory
 * @param {boolean} [forceOcr] - When true, always run OCR even if cache exists
 * @returns {Promise<string>}  Extracted plain text, or '' on failure
 */
export async function ensureExtractedText(filePath, fileName, fileBytes, validPath, forceOcr = false) {
  const ext = path.extname(fileName).toLowerCase();

  // .txt files — read directly
  if (ext === '.txt') {
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
  }

  const base = path.parse(fileName).name;
  const extractedTxtPath = path.join(validPath, '_extracted', base + '.txt');

  // Return cached text if fresh enough and forceOcr is not set
  if (!forceOcr && fs.existsSync(extractedTxtPath)) {
    try {
      const cachedText = fs.readFileSync(extractedTxtPath, 'utf-8');
      if (cachedText && cachedText.trim().length >= 80) {
        return cachedText;
      }
    } catch {}
  }

  // Extract fresh text
  try {
    let text = '';

    if (ext === '.pdf' || isWordDocument(fileName)) {
      log.debug({ file: fileName, ext }, 'Extracting text via pdf-parse');
      const data = await pdfParse(fileBytes);
      text = data.text ? data.text.trim() : '';
    }

    // Fallback to OCR if digital text is empty or lacks boundary keywords
    if (forceOcr || !text || text.length < 80 || !hasBoundaryKeywords(text)) {
      const fileHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      const ocrCacheDir = getOcrCacheDir();
      const metaPath = path.join(ocrCacheDir, `${fileHash}.json`);

      if (!forceOcr && fs.existsSync(metaPath)) {
        // Disk OCR cache hit
        try {
          const metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (metaJson.combinedOcrText) {
            log.info({ file: fileName, hash: fileHash.slice(0, 8) }, 'Disk OCR cache hit');
            text = metaJson.combinedOcrText;
          }
        } catch (cacheErr) {
          log.warn({ err: cacheErr.message }, 'Failed to parse disk OCR cache entry');
        }
      } else {
        // Run OCR via persistent Python daemon
        try {
          log.info({ file: fileName }, 'Running OCR via persistent daemon');
          const ocrText = await ocrDaemonFile(filePath);
          text = (ocrText || '').trim();
          if (text) {
            if (!fs.existsSync(ocrCacheDir)) {
              fs.mkdirSync(ocrCacheDir, { recursive: true });
            }
            fs.writeFileSync(metaPath, JSON.stringify({ combinedOcrText: text, fileName }), 'utf8');
            log.info({ file: fileName, cacheFile: metaPath }, 'Saved OCR text to disk cache');
          }
        } catch (e) {
          log.error({ file: fileName, err: e.message }, 'OCR daemon failed');
        }
      }
    }

    if (text) {
      const extractedDir = path.join(validPath, '_extracted');
      if (!fs.existsSync(extractedDir)) {
        fs.mkdirSync(extractedDir, { recursive: true });
      }
      fs.writeFileSync(extractedTxtPath, text, 'utf-8');
      log.debug({ file: fileName, dest: extractedTxtPath }, 'Cached extracted text');
      return text;
    }
  } catch (err) {
    log.warn({ file: fileName, err: err.message }, 'Failed to extract/cache raw text');
  }

  return '';
}

/**
 * Convert a Word document to PDF bytes using LibreOffice, with a fallback to
 * any pre-extracted text file in the `_extracted/` subdirectory.
 *
 * @param {string} filePath   - Absolute path to the .doc / .docx file
 * @param {string} fileName   - Basename used to locate the fallback .txt
 * @param {Buffer} docBytes   - Raw bytes of the Word document
 * @returns {Promise<{bytes: Buffer, mime: string}>}
 */
export async function readWordDocWithFallback(filePath, fileName, docBytes) {
  try {
    const pdfBytes = await convertToPdf(docBytes, fileName);
    return { bytes: pdfBytes, mime: 'application/pdf' };
  } catch (err) {
    log.warn({ file: fileName, err: err.message }, 'LibreOffice conversion failed — checking pre-extracted text fallback');
    const base = path.parse(fileName).name;
    const dir = path.dirname(filePath);
    const extractedTxtPath = path.join(dir, '_extracted', base + '.txt');
    if (fs.existsSync(extractedTxtPath)) {
      log.info({ fallback: extractedTxtPath }, 'Found pre-extracted text fallback');
      const textBytes = fs.readFileSync(extractedTxtPath);
      return { bytes: textBytes, mime: 'text/plain' };
    }
    throw err;
  }
}
