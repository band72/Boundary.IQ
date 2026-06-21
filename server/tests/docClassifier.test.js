// ─── docClassifier.test.js ────────────────────────────────────────────────────
// Unit tests for the document classifier service.
// Covers: filename-based classification, SKIP keyword matching, word boundary
// matching (containsWord), and the PLSS intercept decision logic.

import { describe, it, expect, vi } from 'vitest';
import {
  containsWord,
  classifyByFilename,
  SKIP_KEYWORDS,
  SUPPORTED_EXTS,
  inferMimeType,
  parsePrecisionRatio,
} from '../services/docClassifier.js';

// ── containsWord ──────────────────────────────────────────────────────────────
describe('containsWord', () => {
  it('matches exact isolated token', () => {
    expect(containsWord('12345 - WD.doc', 'WD')).toBe(true);
  });

  it('does NOT match token embedded in longer word', () => {
    // "WOOD" contains "WD"? No — boundary check prevents this.
    expect(containsWord('WOOD DEED.doc', 'WD')).toBe(false);
  });

  it('matches QCD at the end of a filename', () => {
    expect(containsWord('SMITH - QCD.pdf', 'QCD')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(containsWord('smith qcd', 'QCD')).toBe(true);
  });

  it('returns false for empty source', () => {
    expect(containsWord('', 'QCD')).toBe(false);
  });
});

// ── classifyByFilename ────────────────────────────────────────────────────────
describe('classifyByFilename', () => {
  it('classifies warranty deed files as WARRANTY_DEED', () => {
    expect(classifyByFilename('123 Main St - WD.pdf')).toBe('WARRANTY_DEED');
    expect(classifyByFilename('SALE_SWD_2023.pdf')).toBe('WARRANTY_DEED');
  });

  it('classifies quit claim deed files as QUIT_CLAIM_DEED', () => {
    expect(classifyByFilename('Jones - QCD.doc')).toBe('QUIT_CLAIM_DEED');
  });

  it('classifies easement files as EASEMENT', () => {
    expect(classifyByFilename('utility easement.pdf')).toBe('EASEMENT');
    expect(classifyByFilename('EAESMENT_2024.pdf')).toBe('EASEMENT');
  });

  it('classifies dedication files as DEDICATION', () => {
    expect(classifyByFilename('Deed of Dedication Riverside Dr.pdf')).toBe('DEDICATION');
  });

  it('classifies road files as ROAD_CLOSING', () => {
    expect(classifyByFilename('hwy_132_road_access.pdf')).toBe('ROAD_CLOSING');
  });

  it('classifies DEED files as DEED', () => {
    expect(classifyByFilename('parcel grant deed.pdf')).toBe('DEED');
  });

  it('returns SKIP for known non-boundary instrument types', () => {
    expect(classifyByFilename('Monthly Memo of Lease.pdf')).toBe('SKIP');
    expect(classifyByFilename('John Doe Affidavit.pdf')).toBe('SKIP');
    expect(classifyByFilename('ELEVATION CERT 2023.pdf')).toBe('SKIP');
  });

  it('returns DEED for unknown but supported extension files', () => {
    expect(classifyByFilename('random_document.pdf')).toBe('DEED');
    expect(classifyByFilename('survey.png')).toBe('DEED');
  });

  it('returns SKIP for unsupported extensions', () => {
    expect(classifyByFilename('spreadsheet.xlsx')).toBe('SKIP');
  });
});

// ── SKIP_KEYWORDS list ────────────────────────────────────────────────────────
describe('SKIP_KEYWORDS list', () => {
  it('contains known non-boundary instrument types', () => {
    expect(SKIP_KEYWORDS).toContain('Affidavit');
    expect(SKIP_KEYWORDS).toContain('Lis Pendens');
    expect(SKIP_KEYWORDS).toContain('Bankruptcy');
    expect(SKIP_KEYWORDS).toContain('ENCROACHMENT');
  });

  it('does NOT contain CERT or CERTIFICATION (deeds can include these)', () => {
    expect(SKIP_KEYWORDS).not.toContain('CERT');
    expect(SKIP_KEYWORDS).not.toContain('CERTIFICATION');
  });
});

// ── SUPPORTED_EXTS ────────────────────────────────────────────────────────────
describe('SUPPORTED_EXTS', () => {
  it('includes standard deed file types', () => {
    expect(SUPPORTED_EXTS.has('.pdf')).toBe(true);
    expect(SUPPORTED_EXTS.has('.doc')).toBe(true);
    expect(SUPPORTED_EXTS.has('.docx')).toBe(true);
    expect(SUPPORTED_EXTS.has('.txt')).toBe(true);
  });

  it('does NOT include unsupported file types', () => {
    expect(SUPPORTED_EXTS.has('.xlsx')).toBe(false);
    expect(SUPPORTED_EXTS.has('.exe')).toBe(false);
  });
});

// ── inferMimeType ─────────────────────────────────────────────────────────────
describe('inferMimeType', () => {
  it('returns image/jpeg for .jpg and .jpeg', () => {
    expect(inferMimeType('photo.jpg')).toBe('image/jpeg');
    expect(inferMimeType('photo.jpeg')).toBe('image/jpeg');
  });

  it('returns image/png for .png', () => {
    expect(inferMimeType('scan.png')).toBe('image/png');
  });

  it('returns text/plain for .txt', () => {
    expect(inferMimeType('deed.txt')).toBe('text/plain');
  });

  it('returns application/pdf for .doc and .docx (LibreOffice converts them)', () => {
    expect(inferMimeType('deed.doc')).toBe('application/pdf');
    expect(inferMimeType('deed.docx')).toBe('application/pdf');
  });

  it('defaults to application/pdf for unknown extensions', () => {
    expect(inferMimeType('deed.unknown')).toBe('application/pdf');
  });
});

// ── parsePrecisionRatio ───────────────────────────────────────────────────────
describe('parsePrecisionRatio', () => {
  it('parses a standard precision ratio string', () => {
    expect(parsePrecisionRatio('1:12,345')).toBeCloseTo(12345, 0);
  });

  it('handles the ∞ infinity case', () => {
    expect(parsePrecisionRatio('1:∞ (Perfect)')).toBeGreaterThan(999999990);
  });

  it('returns 0 for null or undefined', () => {
    expect(parsePrecisionRatio(null)).toBe(0);
    expect(parsePrecisionRatio(undefined)).toBe(0);
    expect(parsePrecisionRatio('')).toBe(0);
  });

  it('returns 0 for unparseable strings', () => {
    expect(parsePrecisionRatio('not a ratio')).toBe(0);
  });
});
