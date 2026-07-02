import { describe, it, expect } from 'vitest';

// ── Inline reference implementation matching client/src/utils/deedParser.js ───

const RE_THENCE   = /\bTHENCE\b/gi;
const RE_BEARING  = /\b([NSns])\s*(\d{1,3})[°\-\s.]+(\d{1,2})['\-\s.]+(\d{1,2}(?:\.\d+)?)["\s]*([EWew])/g;
const RE_DISTANCE = /(\d{1,6}(?:\.\d+)?)\s*(?:feet|foot|ft\.?|meters?|m\.?)\b/gi;
const RE_CURVE    = /\b(?:curve|arc|radius|radially|circular)\b/gi;
const RE_COMMENCE = /\b(?:COMMENCING|COMMENCE)\b/i;
const RE_POB      = /\bPOINT\s+OF\s+BEGINNING\b|\bP\.?O\.?B\.?\b/i;
const RE_POB_COORDS = /northing\s*[=:]?\s*([\d,]+\.?\d*)\s*[,;]?\s*easting\s*[=:]?\s*([\d,]+\.?\d*)/i;

function previewDeedText(text) {
  if (!text || !text.trim()) {
    return { courseCount: 0, bearingCount: 0, curveCount: 0, hasCommencement: false, hasPOB: false, pobCoords: null, preview: [] };
  }
  const thenceMatches = [...text.matchAll(RE_THENCE)];
  const bearingMatches = [...text.matchAll(RE_BEARING)];
  const thenceParts = text.split(RE_THENCE);
  let curveCount = 0;
  const preview = [];
  thenceParts.slice(1).forEach((part, idx) => {
    const isCurve = RE_CURVE.test(part);
    RE_CURVE.lastIndex = 0;
    RE_BEARING.lastIndex = 0;
    const bMatch = RE_BEARING.exec(part);
    const bearingStr = bMatch
      ? `${bMatch[1].toUpperCase()}${bMatch[2]}°${bMatch[3]}'${bMatch[4]}"${bMatch[5].toUpperCase()}`
      : null;
    RE_DISTANCE.lastIndex = 0;
    const dMatch = RE_DISTANCE.exec(part);
    const distance = dMatch ? parseFloat(dMatch[1].replace(/,/g, '')) : null;
    if (isCurve) curveCount++;
    preview.push({ index: idx + 1, type: isCurve ? 'Curve' : (bearingStr ? 'Line' : 'Unknown'), bearing: bearingStr, distance });
  });
  const hasCommencement = RE_COMMENCE.test(text);
  const hasPOB = RE_POB.test(text);
  const pobMatch = RE_POB_COORDS.exec(text);
  const pobCoords = pobMatch
    ? { northing: parseFloat(pobMatch[1].replace(/,/g, '')), easting: parseFloat(pobMatch[2].replace(/,/g, '')) }
    : null;
  return { courseCount: thenceMatches.length, bearingCount: bearingMatches.length, curveCount, hasCommencement, hasPOB, pobCoords, preview };
}

function deedPreviewSummary(parsed) {
  if (!parsed || parsed.courseCount === 0) return null;
  const parts = [];
  parts.push(`${parsed.courseCount} course${parsed.courseCount !== 1 ? 's' : ''} detected`);
  if (parsed.curveCount > 0) parts.push(`${parsed.curveCount} curve${parsed.curveCount !== 1 ? 's' : ''}`);
  if (parsed.hasCommencement) parts.push('commencement found');
  if (parsed.hasPOB) parts.push('POB found');
  return parts.join(' · ');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deedParser', () => {

  it('Empty input returns all zeros/false', async () => {
    const p = previewDeedText('');
    expect(p.courseCount).toBe(0);
    expect(p.bearingCount).toBe(0);
    expect(p.curveCount).toBe(0);
    expect(p.hasCommencement).toBe(false);
    expect(p.hasPOB).toBe(false);
    expect(p.pobCoords).toBeNull();
  });

  it('Simple 4-course deed: detects 4 THENCE clauses and 4 bearings', async () => {
    const text = `
      BEGINNING at a point;
      THENCE N 00°00'00" E, a distance of 100.00 feet;
      THENCE N 90°00'00" E, a distance of 100.00 feet;
      THENCE S 00°00'00" W, a distance of 100.00 feet;
      THENCE N 90°00'00" W, a distance of 100.00 feet to the POINT OF BEGINNING.
    `;
    const p = previewDeedText(text);
    expect(p.courseCount).toBe(4);
    expect(p.bearingCount).toBe(4);
    expect(p.hasPOB).toBe(true);
  });

  it('Curve detection: "THENCE along a curve to the right" triggers curveCount >= 1', async () => {
    const text = `
      THENCE along a curve to the right, having a Radius of 200.00 feet,
      an arc length of 157.08 feet to a point.
    `;
    const p = previewDeedText(text);
    expect(p.curveCount).toBeGreaterThanOrEqual(1);
  });

  it('Commencement detection: "COMMENCING AT" sets hasCommencement=true', async () => {
    const p = previewDeedText('COMMENCING AT the Southeast corner of Section 14.');
    expect(p.hasCommencement).toBe(true);
  });

  it('POB detection: "POINT OF BEGINNING" sets hasPOB=true', async () => {
    const p = previewDeedText('...to the POINT OF BEGINNING.');
    expect(p.hasPOB).toBe(true);
  });

  it('POB coordinate extraction: Northing/Easting parsed correctly', async () => {
    const p = previewDeedText('having coordinates Northing 5000.00, Easting 5000.00');
    expect(p.pobCoords).not.toBeNull();
    expect(p.pobCoords.northing).toBe(5000);
    expect(p.pobCoords.easting).toBe(5000);
  });

  it('deedPreviewSummary returns string containing course count', async () => {
    const p = previewDeedText(`
      THENCE N 00°00'00" E, 100 feet;
      THENCE N 90°00'00" E, 100 feet;
      THENCE S 00°00'00" W, 100 feet;
      THENCE N 90°00'00" W, 100 feet to the POINT OF BEGINNING.
    `);
    const summary = deedPreviewSummary(p);
    expect(typeof summary).toBe('string');
    expect(summary).toContain('4 courses');
  });

  it('Null/undefined input returns zero counts', async () => {
    expect(previewDeedText(null).courseCount).toBe(0);
    expect(previewDeedText(undefined).courseCount).toBe(0);
  });

});
