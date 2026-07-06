// ── Quadrant Disambiguator ─────────────────────────────────────────────────────
// Post-extraction service that detects and auto-corrects implausible N/S E/W
// bearing quadrant flips in extracted survey courses.
//
// Strategy: for each course, try all 4 quadrant variants (NN/NE, NW, SE, SW).
// Accept the flip only if it:
//   1. Reduces linearError, AND
//   2. Does not create a self-intersecting polygon
//   3. Was a meaningful improvement (> 0.5 ft gain)
//
// Returns: { courses, correctedCount, corrections[] }
// ──────────────────────────────────────────────────────────────────────────────

import * as bp from './bearingParser.js';
import { compute, detectSelfIntersection } from './traverse.js';
import { createChildLogger } from '../../logger.js';

const log = createChildLogger('quadrantDisambiguator');

const QUADRANTS = ['N...E', 'N...W', 'S...E', 'S...W'];
const MIN_IMPROVEMENT_FT = 0.5; // only accept flip if it improves by at least this much

/**
 * Applies quadrant flip to a bearing string.
 * @param {string} bearing  e.g. "N45°30'00\"W"
 * @param {string} quadrant e.g. 'S...E'
 * @returns {string} bearing with new N/S and E/W
 */
function applyQuadrant(bearing, quadrant) {
  if (!bearing) return bearing;
  const ns = quadrant[0];   // 'N' or 'S'
  const ew = quadrant[4];   // 'E' or 'W'
  return bearing
    .replace(/^[NS]/i, ns)
    .replace(/[EW]$/i, ew);
}

/**
 * Evaluate a set of courses: returns { linearError, hasSelfIntersection }
 */
function evaluate(courses, pobN, pobE) {
  try {
    const result = compute({
      pointOfBeginning: { northing: pobN, easting: pobE },
      courses,
      units: 'Feet',
      isOpenEnded: false,
    });
    return {
      linearError: result.closure.linearError,
      hasSelfIntersection: detectSelfIntersection(result.adjustedStations ?? result.stations),
    };
  } catch {
    return { linearError: Infinity, hasSelfIntersection: true };
  }
}

/**
 * For a given course (Line or Curve), return all 4 quadrant variants of its
 * directional bearing (bearing for Lines, chordBearing for Curves).
 */
function getVariants(course) {
  const isLine = (course.type || '').toLowerCase() === 'line';
  const src = isLine ? course.bearing : course.chordBearing;
  if (!src) return [course]; // nothing to flip

  return QUADRANTS.map(q => {
    const flipped = applyQuadrant(src, q);
    if (isLine) return { ...course, bearing: flipped };
    return { ...course, chordBearing: flipped };
  });
}

/**
 * Main disambiguator entry point.
 *
 * @param {object[]} courses     Extracted course array from AI/OCR
 * @param {number}   pobN        Point of Beginning northing
 * @param {number}   pobE        Point of Beginning easting
 * @returns {{ courses: object[], correctedCount: number, corrections: object[] }}
 */
export function disambiguateQuadrants(courses, pobN = 5000, pobE = 5000) {
  if (!courses || courses.length === 0) {
    return { courses, correctedCount: 0, corrections: [] };
  }

  const corrections = [];
  let current = courses.map(c => ({ ...c }));

  // Baseline evaluation
  let baseline = evaluate(current, pobN, pobE);
  log.debug({ baselineError: baseline.linearError?.toFixed(3), hasSelfIntersection: baseline.hasSelfIntersection }, 'Quadrant disambiguator: baseline');

  // Greedy pass: fix one course at a time, always keeping the best flip
  let improved = true;
  let passes = 0;
  const MAX_PASSES = 3; // multiple passes in case fixing one course reveals another

  while (improved && passes < MAX_PASSES) {
    improved = false;
    passes++;

    for (let i = 0; i < current.length; i++) {
      const isLine = (current[i].type || '').toLowerCase() === 'line';
      const originalBearing = isLine ? current[i].bearing : current[i].chordBearing;
      if (!originalBearing) continue;

      let bestError = baseline.linearError;
      let bestVariant = null;
      let bestQuadrant = null;

      const variants = getVariants(current[i]);
      for (const variant of variants) {
        const testCourses = [...current];
        testCourses[i] = variant;
        const eval_ = evaluate(testCourses, pobN, pobE);

        // Accept only if: no self-intersection AND better than current best
        if (!eval_.hasSelfIntersection && eval_.linearError < bestError - MIN_IMPROVEMENT_FT) {
          bestError = eval_.linearError;
          bestVariant = variant;
          bestQuadrant = isLine ? variant.bearing : variant.chordBearing;
        }
      }

      if (bestVariant) {
        corrections.push({
          courseIndex: i,
          field: isLine ? 'bearing' : 'chordBearing',
          original: originalBearing,
          corrected: bestQuadrant,
          errorBefore: baseline.linearError,
          errorAfter: bestError,
        });
        log.info(
          { courseIndex: i, original: originalBearing, corrected: bestQuadrant, errorBefore: baseline.linearError?.toFixed(3), errorAfter: bestError.toFixed(3) },
          'Quadrant disambiguator: corrected flip'
        );
        current[i] = bestVariant;
        baseline = evaluate(current, pobN, pobE);
        improved = true;
      }
    }
  }

  return {
    courses: current,
    correctedCount: corrections.length,
    corrections,
    finalError: baseline.linearError,
    finalSelfIntersect: baseline.hasSelfIntersection,
  };
}
