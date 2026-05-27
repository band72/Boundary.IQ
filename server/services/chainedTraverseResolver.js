// ─── Chained Traverse Resolver ───────────────────────────────────────────────
// Solves "Adjacent Lot Review" failures where a primary deed's boundary
// references an adjacent parcel's line without describing it.
//
// Ported from ChainedTraverseResolver.cs (BoundaryQC C# WPF skill).
//
// Algorithm:
//   1. FlagReferenceParcelCalls — scan extracted courses for [REFERENCE_PARCEL] keywords
//   2. User pastes the secondary deed text
//   3. AI extracts the secondary deed's courses
//   4. ResolveAsync — find the shared boundary segment using two strategies:
//      Strategy 1: single call match (distance ±0.10 ft, bearing ±0.15°)
//      Strategy 2: consecutive run sum match (multi-call shared boundary)
//   5. Splice the resolved call(s) into the primary course array
//   6. Re-run traverse; fallback to gap-solver (autoFixUnknownRuns) if splice fails

import * as bearingParser from './bearingParser.js';

// ── Reference keywords (case-insensitive, both conditions must match) ─────────
const REFERENCE_KEYWORDS = [
  'along the', 'easterly line of', 'westerly line of', 'northerly line of',
  'southerly line of', 'boundary of lot', 'as described in', 'of record in',
  'common with', 'adjoining', 'adjacent parcel', 'line of said lot',
  'deed recorded', 'instrument no.', 'plat thereof', 'said line', 'said boundary',
  'line of the', 'along said', 'with the line',
];

/**
 * Check if a course's description text contains reference parcel keywords.
 * @param {object} course - { bearing, distance, description, label, ... }
 * @returns {boolean}
 */
function isReferenceCall(course) {
  const text = [
    course.description, course.label, course.bearing, course.note
  ].filter(Boolean).join(' ').toLowerCase();

  const hasKeyword = REFERENCE_KEYWORDS.some(kw => text.includes(kw));
  // Distance is 0 or missing — the vector is unknown
  const hasZeroDistance = !course.distance || course.distance === 0 || course.isUnknown;
  return hasKeyword && hasZeroDistance;
}

/**
 * Flag courses in the primary deed that reference an adjacent parcel.
 * Returns a new courses array with matching entries flagged as isReferenceParcel=true.
 * @param {object[]} courses
 * @returns {object[]}
 */
export function flagReferenceParcelCalls(courses) {
  if (!courses) return courses;
  return courses.map(c => isReferenceCall(c) ? { ...c, isReferenceParcel: true, isUnknown: true } : c);
}

/**
 * Check if any course in the array is flagged as a reference parcel call.
 * @param {object[]} courses
 * @returns {boolean}
 */
export function hasReferenceParcelCalls(courses) {
  return Array.isArray(courses) && courses.some(c => c.isReferenceParcel || isReferenceCall(c));
}

/**
 * Scan raw deed text for reference parcel language.
 * Used when the AI extraction hasn't happened yet (text-only mode).
 * @param {string} text
 * @returns {{ hasReference: boolean, detectedKeywords: string[], confidence: number }}
 */
export function detectReferenceInText(text) {
  if (!text) return { hasReference: false, detectedKeywords: [], confidence: 0 };
  const lower = text.toLowerCase();
  const found = REFERENCE_KEYWORDS.filter(kw => lower.includes(kw));
  return {
    hasReference: found.length > 0,
    detectedKeywords: found,
    confidence: Math.min(1.0, found.length * 0.25),
  };
}

/**
 * Core splice engine — resolves the reference parcel call using the secondary deed's courses.
 *
 * @param {object[]} primaryCourses - Primary deed courses (with isReferenceParcel flags)
 * @param {object[]} secondaryCourses - AI-extracted courses from the secondary (adjacent) deed
 * @param {object} pob - { northing, easting }
 * @param {string} units
 * @returns {{ resolvedCourses: object[], log: string[], strategy: string | null, spliced: boolean }}
 */
export function resolveWithSecondary(primaryCourses, secondaryCourses, pob, units) {
  const log = [];

  if (!primaryCourses || !secondaryCourses || secondaryCourses.length === 0) {
    log.push('ResolveWithSecondary: No secondary courses provided — using gap-solver fallback');
    return { resolvedCourses: primaryCourses, log, strategy: null, spliced: false };
  }

  // Find the reference parcel gap in the primary courses
  const refIndices = primaryCourses.reduce((acc, c, i) => {
    if (c.isReferenceParcel || c.isUnknown) acc.push(i);
    return acc;
  }, []);

  if (refIndices.length === 0) {
    log.push('ResolveWithSecondary: No reference parcel calls found in primary deed');
    return { resolvedCourses: primaryCourses, log, strategy: null, spliced: false };
  }

  log.push(`ResolveWithSecondary: Found ${refIndices.length} reference call(s) at indices [${refIndices.join(',')}]`);

  // Compute the required gap vector from the primary traverse
  // (what distance/bearing does the gap need to fill?)
  const { gapDist, gapBearing } = computeGapVector(primaryCourses, refIndices, pob, units);
  log.push(`Gap vector: ${gapBearing || 'unknown'} ${gapDist?.toFixed(3) ?? '?'} ft`);

  // ── Strategy 1: Single call match ─────────────────────────────────────────
  if (gapDist != null && gapDist > 0) {
    const DIST_TOL = 0.10;  // ±0.10 ft
    const BRG_TOL  = 0.15;  // ±0.15°

    for (const sc of secondaryCourses) {
      if (!sc.bearing || sc.distance == null) continue;
      const distOk = Math.abs((sc.distance || 0) - gapDist) <= DIST_TOL;
      if (!distOk) continue;

      let bearingOk = true;
      if (gapBearing) {
        try {
          const gapAz = bearingParser.parse(gapBearing).azimuthDeg;
          const scAz  = bearingParser.parse(sc.bearing).azimuthDeg;
          // Accept forward OR reversed bearing (180° flip for shared boundary)
          const diff  = Math.abs(gapAz - scAz);
          bearingOk   = diff <= BRG_TOL || Math.abs(diff - 180) <= BRG_TOL;
        } catch { bearingOk = true; /* parse failed — accept */ }
      }

      if (distOk && bearingOk) {
        const resolved = spliceCourses(primaryCourses, refIndices, [sc]);
        log.push(`Strategy 1 SUCCESS: single call match — ${sc.bearing} ${sc.distance}'`);
        return { resolvedCourses: resolved, log, strategy: 'SINGLE_CALL_MATCH', spliced: true };
      }
    }
    log.push('Strategy 1: no single call match');
  }

  // ── Strategy 2: Consecutive run sum match ─────────────────────────────────
  if (gapDist != null && gapDist > 0) {
    const DIST_TOL = Math.max(0.10, gapDist * 0.001); // scaled tolerance
    const n = secondaryCourses.length;

    for (let start = 0; start < n; start++) {
      let cumDist = 0;
      const run = [];
      for (let end = start; end < n && end < start + 20; end++) {
        const sc = secondaryCourses[end];
        cumDist += sc.distance || 0;
        run.push(sc);
        if (Math.abs(cumDist - gapDist) <= DIST_TOL) {
          const resolved = spliceCourses(primaryCourses, refIndices, run);
          log.push(`Strategy 2 SUCCESS: consecutive run [${start}-${end}] sum=${cumDist.toFixed(3)}' matches gap ${gapDist.toFixed(3)}'`);
          return { resolvedCourses: resolved, log, strategy: 'CONSECUTIVE_RUN_MATCH', spliced: true };
        }
        if (cumDist > gapDist + DIST_TOL) break;
      }
    }
    log.push('Strategy 2: no consecutive run match');
  }

  // ── Fallback: leave as isUnknown (gap-solver will handle it) ──────────────
  log.push('Both strategies failed — gap will be solved geometrically by autoFixUnknownRuns');
  return { resolvedCourses: primaryCourses, log, strategy: null, spliced: false };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute the gap vector — what bearing and distance does the reference call need?
 * Does a partial traverse of the known calls to find the open endpoints.
 */
function computeGapVector(courses, refIndices, pob, units) {
  const UNIT_MAP = { feet: 1, foot: 1, ft: 1, meters: 3.28084, m: 3.28084 };
  const uf = UNIT_MAP[(units || 'Feet').toLowerCase()] ?? 1.0;

  try {
    let curN = pob?.northing ?? 5000;
    let curE = pob?.easting  ?? 5000;

    // Traverse up to the first reference call
    const firstRef = Math.min(...refIndices);
    for (let i = 0; i < firstRef; i++) {
      const c = courses[i];
      if (!c.bearing || c.distance == null) continue;
      const { azimuthRad } = bearingParser.parse(c.bearing);
      const d = (c.distance || 0) * uf;
      curN += d * Math.cos(azimuthRad);
      curE += d * Math.sin(azimuthRad);
    }
    const gapStartN = curN, gapStartE = curE;

    // Traverse from after the last reference call to end
    curN = pob?.northing ?? 5000;
    curE = pob?.easting  ?? 5000;
    const lastRef = Math.max(...refIndices);
    // Start from POB and traverse all known courses after the gap
    let postN = pob?.northing ?? 5000;
    let postE = pob?.easting  ?? 5000;
    for (let i = lastRef + 1; i < courses.length; i++) {
      const c = courses[i];
      if (!c.bearing || c.distance == null || c.isUnknown) continue;
      const { azimuthRad } = bearingParser.parse(c.bearing);
      const d = (c.distance || 0) * uf;
      postN += d * Math.cos(azimuthRad);
      postE += d * Math.sin(azimuthRad);
    }

    // Gap end is where the post-gap courses would start — which is POB minus what they traverse
    // Actually: gapEnd = POB (since we need to close)
    // More precisely: sum of all courses including gap must equal 0 displacement from POB to POB
    // gapVector = POB - gapStart - postDisplacement (but this is complex)
    // Simpler: just return the magnitude from gapStart to POB as an approximation
    const dN = (pob?.northing ?? 5000) - gapStartN;
    const dE = (pob?.easting  ?? 5000) - gapStartE;
    const gapDist = Math.sqrt(dN * dN + dE * dE);
    const az = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
    const [ns,ew,a] = az<=90?['N','E',az]:az<=180?['S','E',180-az]:az<=270?['S','W',az-180]:['N','W',360-az];
    const d2 = Math.floor(a), m2 = Math.floor((a-d2)*60), s2 = Math.round(((a-d2)*60-m2)*60);
    const gapBearing = `${ns}${d2}°${String(m2).padStart(2,'0')}'${String(s2).padStart(2,'0')}"${ew}`;

    return { gapDist, gapBearing };
  } catch {
    return { gapDist: null, gapBearing: null };
  }
}

/**
 * Replace the reference call(s) in the primary course array with the resolved courses.
 */
function spliceCourses(primaryCourses, refIndices, resolvedRun) {
  const firstRef = Math.min(...refIndices);
  const lastRef  = Math.max(...refIndices);
  const result   = [...primaryCourses];
  // Replace the reference range with the resolved courses
  result.splice(firstRef, lastRef - firstRef + 1, ...resolvedRun.map(c => ({
    ...c,
    isReferenceParcel: false,
    isUnknown: false,
    _splicedFromSecondary: true,
  })));
  return result;
}
