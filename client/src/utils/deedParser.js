/**
 * deedParser.js — Client-side regex deed text preview parser
 *
 * Provides a lightweight, instant parse of raw deed text for live UI preview
 * (e.g. "12 courses detected").  The authoritative parsing is always done
 * server-side via /deed/solve-text; this util only counts and classifies.
 *
 * Supports:
 *   - Standard metes-and-bounds courses ("THENCE N45°22'10"E, 150.25 feet")
 *   - Curve calls ("THENCE along a curve to the right, Radius = 200.00 ft, ...")
 *   - Commencement detection ("COMMENCING AT" vs "BEGINNING AT")
 *   - POB coordinate extraction ("Northing 5000.00, Easting 5000.00")
 */

// ── Regex patterns ────────────────────────────────────────────────────────────

// Matches a THENCE keyword that opens a new course
const RE_THENCE = /\bTHENCE\b/gi;

// Matches a quadrant bearing: N/S + digits + °/- + digits + '/- + digits + E/W
const RE_BEARING = /\b([NSns])\s*(\d{1,3})[°\-\s\.]+(\d{1,2})['\-\s\.]+(\d{1,2}(?:\.\d+)?)["\s]*([EWew])/g;

// Matches a straight-line distance: number followed by feet/meters/ft/m
const RE_DISTANCE = /(\d{1,6}(?:\.\d+)?)\s*(?:feet|foot|ft\.?|meters?|m\.?)\b/gi;

// Matches curve call keywords
const RE_CURVE = /\b(?:curve|arc|radius|radially|circular)\b/gi;

// Commencement indicator
const RE_COMMENCE = /\b(?:COMMENCING|COMMENCE)\b/i;

// Point of beginning vs point of commencement
const RE_POB = /\bPOINT\s+OF\s+BEGINNING\b|\bP\.?O\.?B\.?\b/i;

// POB coordinate extraction
const RE_POB_COORDS = /northing\s*[=:]?\s*([\d,]+\.?\d*)\s*[,;]?\s*easting\s*[=:]?\s*([\d,]+\.?\d*)/i;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Quick-parse raw deed text and return a summary for live UI display.
 *
 * @param {string} text
 * @returns {{
 *   courseCount: number,
 *   bearingCount: number,
 *   curveCount: number,
 *   hasCommencement: boolean,
 *   hasPOB: boolean,
 *   pobCoords: {northing:number,easting:number}|null,
 *   preview: Array<{index:number, type:'Line'|'Curve'|'Unknown', bearing:string|null, distance:number|null}>
 * }}
 */
export function previewDeedText(text) {
  if (!text || !text.trim()) {
    return {
      courseCount: 0,
      bearingCount: 0,
      curveCount: 0,
      hasCommencement: false,
      hasPOB: false,
      pobCoords: null,
      preview: [],
    };
  }

  // Count THENCE occurrences = approximate course count
  const thenceMatches = [...text.matchAll(RE_THENCE)];
  const courseCount = thenceMatches.length;

  // Count bearings
  const bearingMatches = [...text.matchAll(RE_BEARING)];
  const bearingCount = bearingMatches.length;

  // Count curves
  RE_CURVE.lastIndex = 0;
  const curveSegments = (text.match(RE_CURVE) || []).length;
  // Rough heuristic: if a THENCE segment mentions a curve keyword, it's a curve call
  const thenceParts = text.split(RE_THENCE);
  let curveCount = 0;
  const preview = [];

  thenceParts.slice(1).forEach((part, idx) => {
    const isCurve = RE_CURVE.test(part);
    RE_CURVE.lastIndex = 0;

    // Extract first bearing in this segment
    RE_BEARING.lastIndex = 0;
    const bMatch = RE_BEARING.exec(part);
    const bearingStr = bMatch
      ? `${bMatch[1].toUpperCase()}${bMatch[2]}°${bMatch[3]}'${bMatch[4]}"${bMatch[5].toUpperCase()}`
      : null;

    // Extract first distance in this segment
    RE_DISTANCE.lastIndex = 0;
    const dMatch = RE_DISTANCE.exec(part);
    const distance = dMatch ? parseFloat(dMatch[1].replace(/,/g, '')) : null;

    if (isCurve) curveCount++;

    preview.push({
      index: idx + 1,
      type: isCurve ? 'Curve' : (bearingStr ? 'Line' : 'Unknown'),
      bearing: bearingStr,
      distance,
    });
  });

  // Commencement / POB detection
  const hasCommencement = RE_COMMENCE.test(text);
  const hasPOB = RE_POB.test(text);

  // Try to extract POB coordinates
  const pobMatch = RE_POB_COORDS.exec(text);
  const pobCoords = pobMatch
    ? {
        northing: parseFloat(pobMatch[1].replace(/,/g, '')),
        easting:  parseFloat(pobMatch[2].replace(/,/g, '')),
      }
    : null;

  return {
    courseCount,
    bearingCount,
    curveCount,
    hasCommencement,
    hasPOB,
    pobCoords,
    preview,
  };
}

/**
 * Returns a short human-readable summary string for the deed preview.
 * E.g. "12 courses detected (2 curves) · POB found"
 */
export function deedPreviewSummary(parsed) {
  if (!parsed || parsed.courseCount === 0) return null;
  const parts = [];
  parts.push(`${parsed.courseCount} course${parsed.courseCount !== 1 ? 's' : ''} detected`);
  if (parsed.curveCount > 0) parts.push(`${parsed.curveCount} curve${parsed.curveCount !== 1 ? 's' : ''}`);
  if (parsed.hasCommencement) parts.push('commencement found');
  if (parsed.hasPOB) parts.push('POB found');
  if (parsed.pobCoords) parts.push(`N${parsed.pobCoords.northing.toFixed(2)} E${parsed.pobCoords.easting.toFixed(2)}`);
  return parts.join(' · ');
}
