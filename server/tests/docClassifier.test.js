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
  it('matches exact isolated token', async () => {
    expect(containsWord('12345 - WD.doc', 'WD')).toBe(true);
  });

  it('does NOT match token embedded in longer word', async () => {
    // "WOOD" contains "WD"? No — boundary check prevents this.
    expect(containsWord('WOOD DEED.doc', 'WD')).toBe(false);
  });

  it('matches QCD at the end of a filename', async () => {
    expect(containsWord('SMITH - QCD.pdf', 'QCD')).toBe(true);
  });

  it('is case-insensitive', async () => {
    expect(containsWord('smith qcd', 'QCD')).toBe(true);
  });

  it('returns false for empty source', async () => {
    expect(containsWord('', 'QCD')).toBe(false);
  });
});

// ── classifyByFilename ────────────────────────────────────────────────────────
describe('classifyByFilename', () => {
  it('classifies warranty deed files as WARRANTY_DEED', async () => {
    expect(classifyByFilename('123 Main St - WD.pdf')).toBe('WARRANTY_DEED');
    expect(classifyByFilename('SALE_SWD_2023.pdf')).toBe('WARRANTY_DEED');
  });

  it('classifies quit claim deed files as QUIT_CLAIM_DEED', async () => {
    expect(classifyByFilename('Jones - QCD.doc')).toBe('QUIT_CLAIM_DEED');
  });

  it('classifies easement files as EASEMENT', async () => {
    expect(classifyByFilename('utility easement.pdf')).toBe('EASEMENT');
    expect(classifyByFilename('EAESMENT_2024.pdf')).toBe('EASEMENT');
  });

  it('classifies dedication files as DEDICATION', async () => {
    expect(classifyByFilename('Deed of Dedication Riverside Dr.pdf')).toBe('DEDICATION');
  });

  it('classifies road files as ROAD_CLOSING', async () => {
    expect(classifyByFilename('hwy_132_road_access.pdf')).toBe('ROAD_CLOSING');
  });

  it('classifies DEED files as DEED', async () => {
    expect(classifyByFilename('parcel grant deed.pdf')).toBe('DEED');
  });

  it('returns SKIP for known non-boundary instrument types', async () => {
    expect(classifyByFilename('Monthly Memo of Lease.pdf')).toBe('SKIP');
    expect(classifyByFilename('John Doe Affidavit.pdf')).toBe('SKIP');
    expect(classifyByFilename('ELEVATION CERT 2023.pdf')).toBe('SKIP');
  });

  it('returns DEED for unknown but supported extension files', async () => {
    expect(classifyByFilename('random_document.pdf')).toBe('DEED');
    expect(classifyByFilename('survey.png')).toBe('DEED');
  });

  it('returns SKIP for unsupported extensions', async () => {
    expect(classifyByFilename('spreadsheet.xlsx')).toBe('SKIP');
  });
});

// ── SKIP_KEYWORDS list ────────────────────────────────────────────────────────
describe('SKIP_KEYWORDS list', () => {
  it('contains known non-boundary instrument types', async () => {
    expect(SKIP_KEYWORDS).toContain('Affidavit');
    expect(SKIP_KEYWORDS).toContain('Lis Pendens');
    expect(SKIP_KEYWORDS).toContain('Bankruptcy');
    expect(SKIP_KEYWORDS).toContain('ENCROACHMENT');
  });

  it('does NOT contain CERT or CERTIFICATION (deeds can include these)', async () => {
    expect(SKIP_KEYWORDS).not.toContain('CERT');
    expect(SKIP_KEYWORDS).not.toContain('CERTIFICATION');
  });
});

// ── SUPPORTED_EXTS ────────────────────────────────────────────────────────────
describe('SUPPORTED_EXTS', () => {
  it('includes standard deed file types', async () => {
    expect(SUPPORTED_EXTS.has('.pdf')).toBe(true);
    expect(SUPPORTED_EXTS.has('.doc')).toBe(true);
    expect(SUPPORTED_EXTS.has('.docx')).toBe(true);
    expect(SUPPORTED_EXTS.has('.txt')).toBe(true);
  });

  it('does NOT include unsupported file types', async () => {
    expect(SUPPORTED_EXTS.has('.xlsx')).toBe(false);
    expect(SUPPORTED_EXTS.has('.exe')).toBe(false);
  });
});

// ── inferMimeType ─────────────────────────────────────────────────────────────
describe('inferMimeType', () => {
  it('returns image/jpeg for .jpg and .jpeg', async () => {
    expect(inferMimeType('photo.jpg')).toBe('image/jpeg');
    expect(inferMimeType('photo.jpeg')).toBe('image/jpeg');
  });

  it('returns image/png for .png', async () => {
    expect(inferMimeType('scan.png')).toBe('image/png');
  });

  it('returns text/plain for .txt', async () => {
    expect(inferMimeType('deed.txt')).toBe('text/plain');
  });

  it('returns application/pdf for .doc and .docx (LibreOffice converts them)', async () => {
    expect(inferMimeType('deed.doc')).toBe('application/pdf');
    expect(inferMimeType('deed.docx')).toBe('application/pdf');
  });

  it('defaults to application/pdf for unknown extensions', async () => {
    expect(inferMimeType('deed.unknown')).toBe('application/pdf');
  });
});

// ── parsePrecisionRatio ───────────────────────────────────────────────────────
describe('parsePrecisionRatio', () => {
  it('parses a standard precision ratio string', async () => {
    expect(parsePrecisionRatio('1:12,345')).toBeCloseTo(12345, 0);
  });

  it('handles the ∞ infinity case', async () => {
    expect(parsePrecisionRatio('1:∞ (Perfect)')).toBeGreaterThan(999999990);
  });

  it('returns 0 for null or undefined', async () => {
    expect(parsePrecisionRatio(null)).toBe(0);
    expect(parsePrecisionRatio(undefined)).toBe(0);
    expect(parsePrecisionRatio('')).toBe(0);
  });

  it('returns 0 for unparseable strings', async () => {
    expect(parsePrecisionRatio('not a ratio')).toBe(0);
  });
});

// ── Title Commitment / ALTA Skip Classification ────────────────────────────────
describe('classifyByFilename — title commitment / ALTA skip', () => {
  it('returns SKIP for Title Commitment cover pages', async () => {
    expect(classifyByFilename('Title Commitment Alan Howard 081221(1).pdf')).toBe('SKIP');
    expect(classifyByFilename('Title Committment 2023.pdf')).toBe('SKIP');
  });

  it('returns SKIP for ALTA commitment documents', async () => {
    expect(classifyByFilename('ALTA 2016 Title Commitment v. 1 - 21.15.2021.pdf')).toBe('SKIP');
    expect(classifyByFilename('ALTA 2021 Policy.pdf')).toBe('SKIP');
  });

  it('returns SKIP for County Commitment documents', async () => {
    expect(classifyByFilename('Duval County Commitment Part 11.pdf')).toBe('SKIP');
  });

  it('returns DEED for parcel-split pages (__A/__B suffix) from commitment files', async () => {
    // These are extracted parcels from a commitment — they may contain real THENCE courses
    expect(classifyByFilename('Title Commitment Alan Howard 081221(1)__A.pdf')).toBe('DEED');
    expect(classifyByFilename('ALTA 2016 Title Commitment v. 1 - 21.15.2021__D.pdf')).toBe('DEED');
  });

  it('SKIP_KEYWORDS includes title commitment terms', async () => {
    expect(SKIP_KEYWORDS).toContain('Title Commitment');
    expect(SKIP_KEYWORDS).toContain('ALTA 2016');
    expect(SKIP_KEYWORDS).toContain('Commitment Part');
  });
});
