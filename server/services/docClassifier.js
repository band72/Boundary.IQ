// ─── Document Classifier Service ─────────────────────────────────────────────
// Classifies deed/legal documents by filename and content to determine whether
// they should be processed, skipped, or handled as a specific deed type.
//
// Extracted from server/routes/folderScan.js for testability and reuse.

import path from 'path';
import fs from 'fs';
import * as plssParser from './plssParser.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('docClassifier');

// ── Supported file extensions ─────────────────────────────────────────────────
export const SUPPORTED_EXTS = new Set(['.pdf', '.doc', '.docx', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.gif']);

// ── Document type keyword lists ───────────────────────────────────────────────
export const BOUNDARY_KEYWORDS = [
  ' - WD', ' - SWD', ' - LWD', ' - QCD', 'Deed', 'Easement', 'Right of Way',
  'Monument Road', 'Deed of Dedication', 'Grant of Easement', 'Utility Easement',
  'Road', 'Blvd', 'Order of Taking', 'Closing of Pt',
];

export const SKIP_KEYWORDS = [
  // Legal instruments — no boundary geometry
  'Memo of Lease', 'Short Form Lease', 'Operating Agreement', 'Administrative Fine',
  'Adminstrative Fine', 'Lis Pendens', 'Bankruptcy', 'Letters of Administration',
  'Order Admitting Will', 'Petition for Administration', 'Memo of Management',
  'Memo of ROFR', 'Memo of Transfer', 'Affidavit', 'Aff-Cert', 'Electric Service',
  'Assign & Assump', 'REA Assign', 'Agreement Concerning Lease', 'Fourth Amendment',
  '2nd Amend', "Vendor_s Lien", 'Certificate', 'Contribution Agreement',
  'Utility Agreement', 'Dec of Expiration',
  // Title commitment / insurance documents — contain Schedule B legal descriptions
  // but the description pages are split out separately; the cover/index pages have no
  // traversable boundary and must be skipped to avoid wasting LLM quota.
  'Title Commitment', 'Title Committment', 'ALTA 2016', 'ALTA 2021', 'ALTA/NSPS',
  'County Commitment', 'Commitment Part',
  // NOTE: 'CERT', 'CERTIFICATION' intentionally NOT in this list —
  // a deed file may be named with CERT but still contain valid THENCE courses.
  'TITLE OPINION', 'ELEVATION CERT', 'FLOOD CERT', 'ENCROACHMENT',
];

// Metes-and-bounds indicator terms (used in PLSS intercept check)
const MB_TERMS = [
  'THENCE', 'DEGREES', 'MINUTES', 'SECONDS', 'FEET', '°', '*', "'", '"', 'FT', 'CHORD', 'RADIUS',
];

const LOT_BLOCK_KEYWORDS = [
  'PLAT BOOK', 'MAP BOOK', 'SUBDIVISION', 'CONDOMINIUM', 'ACCORDING TO THE PLAT',
  'RECORDED IN PLAT', 'PLAT THEREOF', 'PLAT OF',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Word-boundary-aware substring search (case-insensitive).
 * Returns true only when `word` is not surrounded by alphanumerics in `source`.
 */
export function containsWord(source, word) {
  let index = 0;
  const upperSource = source.toUpperCase();
  const upperWord = word.toUpperCase();
  while ((index = upperSource.indexOf(upperWord, index)) !== -1) {
    const prevOk = index === 0 || !/[a-zA-Z0-9]/.test(upperSource[index - 1]);
    const nextOk = index + upperWord.length >= upperSource.length || !/[a-zA-Z0-9]/.test(upperSource[index + upperWord.length]);
    if (prevOk && nextOk) return true;
    index += upperWord.length;
  }
  return false;
}

/**
 * Classify a document solely by its filename.
 * @param {string} fileName
 * @returns {'WARRANTY_DEED'|'QUIT_CLAIM_DEED'|'EASEMENT'|'DEDICATION'|'CONDEMNATION'|'ROAD_CLOSING'|'DEED'|'SKIP'}
 */
export function classifyByFilename(fileName) {
  const upper = fileName.toUpperCase();

  // ── Commitment / ALTA parcel-split override (checked BEFORE SKIP_KEYWORDS) ──
  // Files like "Title Commitment XYZ__A.pdf" are parcels extracted from a commitment
  // document and may contain real boundary THENCE courses.  They must be processed
  // as DEED rather than being skipped along with the raw commitment cover pages.
  const isParcelSplit = /__(A|B|C|D|E|F|G|H|I|J|K|L|M|N|[0-9]+|IN|EASEMENT|EXCEPTION)(_\d+)?\./i.test(fileName);
  const isCommitmentDoc = upper.includes('COMMITMENT') || upper.includes('COMMITTMENT') || upper.includes('ALTA ');
  if (isCommitmentDoc && isParcelSplit) return 'DEED';   // extracted parcel — process
  if (isCommitmentDoc && !isParcelSplit) return 'SKIP';  // cover/index page — skip

  // ── Standard SKIP keyword check ───────────────────────────────────────────
  for (const skip of SKIP_KEYWORDS) {
    if (upper.includes(skip.toUpperCase())) return 'SKIP';
  }
  if (containsWord(upper, 'WD') || containsWord(upper, 'SWD') || containsWord(upper, 'LWD')) return 'WARRANTY_DEED';
  if (containsWord(upper, 'QCD') || containsWord(upper, 'QC')) return 'QUIT_CLAIM_DEED';
  if (upper.includes('EASEMENT') || upper.includes('EAESMENT') || upper.includes('EASMENT')) return 'EASEMENT';
  if (upper.includes('DEED OF DEDICATION') || upper.includes('DEDICATION')) return 'DEDICATION';
  if (upper.includes('ORDER OF TAKING')) return 'CONDEMNATION';
  if (upper.includes('ROAD') || upper.includes('BLVD')) return 'ROAD_CLOSING';
  if (upper.includes('DEED') || upper.includes('GRANT')) return 'DEED';

  // Generic or unknown filenames — if it's a supported file type, try content analysis
  const ext = path.extname(fileName).toLowerCase();
  if (SUPPORTED_EXTS.has(ext)) return 'DEED';

  return 'SKIP';
}

/**
 * Classify a document by filename AND content (if pre-extracted text is available).
 * Content-based classification takes priority over filename-only for known ambiguous cases.
 *
 * @param {string} filePath - Absolute path to the source document
 * @param {string} fileName - Basename for classification
 * @returns {'WARRANTY_DEED'|'QUIT_CLAIM_DEED'|'EASEMENT'|'DEDICATION'|'CONDEMNATION'|'ROAD_CLOSING'|'DEED'|'SKIP'}
 */
export function getDocType(filePath, fileName) {
  const dir = path.dirname(filePath);
  const base = path.parse(fileName).name;
  const ext = path.extname(fileName).toLowerCase();

  let raw = '';
  if (ext === '.txt') {
    try { raw = fs.readFileSync(filePath, 'utf-8'); } catch {}
  } else {
    const extractedTxt = path.join(dir, '_extracted', base + '.txt');
    if (fs.existsSync(extractedTxt)) {
      try { raw = fs.readFileSync(extractedTxt, 'utf-8'); } catch {}
    }
  }

  if (raw) {
    try {
      const txt = raw.toUpperCase();

      // Filename-level skip takes priority — even if content contains THENCE
      const upperFileName = fileName.toUpperCase();
      for (const skip of SKIP_KEYWORDS) {
        if (upperFileName.includes(skip.toUpperCase())) {
          log.debug({ file: fileName, skip }, 'SKIP — filename matches skip keyword');
          return 'SKIP';
        }
      }

      // Hard skip: stub documents (cover pages, stamps, annotations)
      if (raw.trim().length < 80) {
        log.debug({ file: fileName, len: raw.trim().length }, 'SKIP — stub document');
        return 'SKIP';
      }

      // Hard skip: pure certification docs with no boundary geometry
      if ((txt.includes('DOES HEREBY CERTIFY') || txt.includes('I HEREBY CERTIFY') ||
           txt.includes('ALTA/ACSM') || txt.includes('ELEVATION CERTIFICATE') ||
           txt.includes('FLOOD INSURANCE')) && !txt.includes('THENCE')) {
        log.debug({ file: fileName }, 'SKIP — pure certification, no boundary courses');
        return 'SKIP';
      }

      // Hard skip: title commitment cover/index pages — they have SCHEDULE B text
      // but the parcel geometry is in __A/__B splits; the cover pages themselves have no THENCE.
      const isTitleCommitment =
        txt.includes('TITLE COMMITMENT') || txt.includes('TITLE COMMITTMENT') ||
        txt.includes('ALTA/NSPS') || txt.includes('TITLE INSURANCE COMPANY') ||
        (txt.includes('SCHEDULE A') && txt.includes('SCHEDULE B') && !txt.includes('THENCE'));
      if (isTitleCommitment && !txt.includes('THENCE')) {
        log.debug({ file: fileName }, 'SKIP — title commitment cover page, no THENCE courses');
        return 'SKIP';
      }

      // If content explicitly contains boundary geometry or PLSS info → DEED
      const isPlss = txt.includes('SECTION') || txt.includes('SEC.') ||
                     txt.includes('TOWNSHIP') || txt.includes('RANGE');
      if (txt.includes('THENCE') || txt.includes('BEGINNING AT') || isPlss) {
        return 'DEED';
      }
    } catch {}
  }

  // Word docs fallback — filename-only classification
  const isWord = ['.doc', '.docx'].includes(path.extname(fileName).toLowerCase());
  if (isWord) {
    const upper = fileName.toUpperCase();
    for (const skip of SKIP_KEYWORDS) {
      if (upper.includes(skip.toUpperCase())) return 'SKIP';
    }
    return 'DEED';
  }

  return classifyByFilename(fileName);
}

/**
 * Returns all supported files in a directory, sorted alphabetically.
 * @param {string} dirPath
 * @returns {string[]} Absolute file paths
 */
export function getSupportedFiles(dirPath) {
  return fs.readdirSync(dirPath)
    .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(dirPath, f));
}

/**
 * Infer the MIME type to send to the vision API from a file extension.
 * Word documents are treated as application/pdf (after LibreOffice conversion).
 * @param {string} fileName
 * @returns {string}
 */
export function inferMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.doc': 'application/pdf',
    '.docx': 'application/pdf',
    '.txt': 'text/plain',
  };
  return map[ext] || 'application/pdf';
}

/**
 * Parse a precision ratio string (e.g. "1:12,345" or "1:∞ (Perfect)") to a numeric value.
 * Returns 0 if unparseable.
 * @param {string} precisionStr
 * @returns {number}
 */
export function parsePrecisionRatio(precisionStr) {
  if (!precisionStr) return 0;
  try {
    const parts = precisionStr.split(':');
    if (parts.length > 1) {
      const val = parseFloat(parts[1].replace(/,/g, '').replace('∞', '999999999').trim());
      if (!isNaN(val)) return val;
    }
  } catch {}
  return 0;
}

/**
 * Determine whether the document text should be handled by the offline PLSS
 * parser rather than routing to the LLM.
 *
 * Returns false for:
 *  - Subdivision / lot-block plats (contain PLAT BOOK, SUBDIVISION, etc.)
 *  - Metes-and-bounds descriptions (≥3 M&B indicator terms present)
 *  - Texts that don't parse as valid PLSS
 *
 * @param {string} text
 * @returns {boolean}
 */
export function shouldInterceptPLSS(text) {
  if (!text) return false;
  const upper = text.toUpperCase();

  // Subdivision plat reference → do not intercept as PLSS
  if (LOT_BLOCK_KEYWORDS.some(kw => upper.includes(kw))) return false;
  if (/\bBLOCK\s+([A-Z]|\d+)\b/i.test(text)) return false;

  // Metes-and-bounds deed → needs LLM processing
  let mbCount = 0;
  for (const term of MB_TERMS) {
    if (upper.includes(term)) mbCount++;
  }
  if (mbCount >= 3) return false;

  // Check if it parses as valid PLSS
  const plss = plssParser.parsePlss(text);
  return !!plss;
}
