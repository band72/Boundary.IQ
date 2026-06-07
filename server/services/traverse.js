// ─── Traverse Service ───────────────────────────────────────────────────────
// Port of TraverseService.cs — traverse computation, compass rule, shoelace area.
// Replaces RCS.Cogo.Core with pure JS math (bearingParser.js).

import * as bp from './bearingParser.js';

// ── Unit Scale Factors (Fix #10) ─────────────────────────────────────────────
// All internal math is in feet. Metric deed distances are converted on input.
const UNIT_TO_FEET = { feet: 1.0, foot: 1.0, ft: 1.0, meters: 3.28084, metre: 3.28084, m: 3.28084 };

function unitFactor(units) {
  return UNIT_TO_FEET[(units || 'Feet').toLowerCase()] ?? 1.0;
}

/**
 * Compute a full traverse: raw coords → closure → compass rule → area.
 * @param {object} req - { pointOfBeginning: {northing, easting}, courses: [...], units, isOpenEnded }
 * @returns {object} TraverseResult
 */
export function compute(req) {
  // ── Step 0: Resolve deflection angles → absolute bearings
  const resolved = resolveDeflectionAngles(req.courses);

  // ── Inverse Gap Solver: auto-fix meander/unknown runs
  const courses = autoFixUnknownRuns(resolved, req.pointOfBeginning);

  const uf = unitFactor(req.units);
  const pobN = req.pointOfBeginning.northing;
  const pobE = req.pointOfBeginning.easting;
  const stations = [];
  let curN = pobN, curE = pobE;
  let seq = 0;

  // Add POB
  stations.push({ seq: seq++, course: 'POB', northing: pobN, easting: pobE, depDN: 0, depDE: 0 });

  let perimeter = 0;
  let prevAzimuthDeg = null; // Track incoming azimuth for curve chord synthesis (Fix #7)

  for (const course of courses) {
    let dn, de, label;

    if (course.type?.toLowerCase() === 'line') {
      if (!course.bearing || course.distance == null)
        throw new Error(`Course ${seq}: Line requires Bearing and Distance.`);

      const { azimuthDeg, azimuthRad } = bp.parse(course.bearing);
      const dist = course.distance * uf;
      dn = dist * Math.cos(azimuthRad);
      de = dist * Math.sin(azimuthRad);
      perimeter += dist;
      label = `${bp.toDisplayString(azimuthDeg)} ${dist.toFixed(2)}'`;
      prevAzimuthDeg = azimuthDeg;

    } else if (course.type?.toLowerCase() === 'curve') {
      ({ dn, de, perimeter, label } = computeCurve(course, perimeter, uf, prevAzimuthDeg));
      // Compute synthetic azimuth for subsequent courses — use chord bearing if available
      if (course.chordBearing) {
        try { prevAzimuthDeg = bp.parse(course.chordBearing).azimuthDeg; } catch {}
      }
    } else {
      throw new Error(`Unknown course type: ${course.type}`);
    }

    curN += dn;
    curE += de;
    stations.push({ seq: seq++, course: label, northing: curN, easting: curE, depDN: dn, depDE: de });
  }

  // Closure
  const errorN = pobN - curN;
  const errorE = pobE - curE;
  const linearError = Math.sqrt(errorN * errorN + errorE * errorE);
  const precision = (perimeter > 0 && linearError > 0) ? perimeter / linearError : Number.MAX_SAFE_INTEGER;

  let ratio, status;
  if (req.isOpenEnded) {
    ratio = '1:∞ (Open-Ended)';
    status = '✓ PASSES  (Open-Ended Traverse)';
  } else {
    ratio = precision >= 999999 ? '1:∞ (Perfect)' : `1:${Math.round(precision).toLocaleString()}`;
    status = precision >= 10000
      ? `✓ PASSES  ${ratio}`
      : `✗ FAILS   ${ratio}  (min 1:10,000)`;
  }

  const closure = { errorNorthing: errorN, errorEasting: errorE, linearError, perimeter, precisionRatio: ratio, status };

  // Compass Rule
  const adjusted = compassRuleAdjust(
    stations,
    req.isOpenEnded ? 0 : errorN,
    req.isOpenEnded ? 0 : errorE,
    perimeter
  );

  // Area via Shoelace
  const areaSqFt = shoelaceArea(adjusted);
  const areaAcres = areaSqFt / 43560.0;

  return { stations, closure, perimeter, areaSqFt, areaAcres, adjustedStations: adjusted, courses };
}

// ── Curve computation ─────────────────────────────────────────────────────────
export function parseDmsToDecimal(dms) {
  if (dms == null) return 0;
  if (typeof dms === 'number') {
    // Treat as packed DMS (e.g. 93.6200)
    const d = Math.floor(Math.abs(dms));
    const rem = (Math.abs(dms) - d) * 100;
    const m = Math.floor(rem);
    const s = (rem - m) * 100;
    return (d + m / 60.0 + s / 3600.0) * (dms < 0 ? -1 : 1);
  }

  const clean = dms.toString().trim();
  // Match degrees, minutes, seconds
  const match = clean.match(/^(-?\d+)\s*[°º\*^d]?\s*(\d+)\s*['’‘`]?\s*(\d+(?:\.\d+)?)\s*["”“']{0,2}$/)
    || clean.match(/^(-?\d+)\s*[°º\*^d]?\s*(\d+(?:\.\d+)?)\s*['’‘`]?$/)
    || clean.match(/^(-?\d+(?:\.\d+)?)\s*[°º\*^d]?$/);

  if (match) {
    const deg = parseFloat(match[1]);
    const min = match[2] ? parseFloat(match[2]) : 0;
    const sec = match[3] ? parseFloat(match[3]) : 0;
    const sign = deg < 0 ? -1 : 1;
    return (Math.abs(deg) + min / 60.0 + sec / 3600.0) * sign;
  }

  // Fallback: try parsing as simple float
  const val = parseFloat(clean);
  if (!isNaN(val)) return val;
  return 0;
}

function computeCurve(c, perim, uf, prevAzimuthDeg) {
  const deltaDeg = parseDmsToDecimal(c.delta);

  // Arc length: prefer given, else compute from R × Δ
  let arcLen = c.arcLength;
  if (arcLen == null && c.radius && c.delta) {
    const deltaRad = deltaDeg * Math.PI / 180.0;
    arcLen = c.radius * deltaRad;
  }
  if (arcLen == null) arcLen = 0;
  perim += (arcLen * uf);

  // Use chord bearing + chord distance
  if (c.chordBearing && c.chordDistance != null) {
    const { azimuthDeg, azimuthRad } = bp.parse(c.chordBearing);
    const dist = c.chordDistance * uf;
    const dn = dist * Math.cos(azimuthRad);
    const de = dist * Math.sin(azimuthRad);
    const label = `Curve R=${(c.radius || 0).toFixed(2)} Δ=${deltaDeg.toFixed(4)}°`;
    return { dn, de, perimeter: perim, label };
  }

  // Fix #7: Synthesize chord bearing from incoming azimuth + delta/2 (deflection angle formula)
  if (c.radius != null && c.delta != null && prevAzimuthDeg != null) {
    const halfDelta = deltaDeg / 2.0;
    const deflectionSign = (c.curveDirection || '').toLowerCase() === 'left' ? -1 : 1;
    const synthAzDeg = (prevAzimuthDeg + deflectionSign * halfDelta + 360) % 360;
    const synthAzRad = synthAzDeg * Math.PI / 180.0;

    // Chord distance from chord = 2R * sin(Δ/2)
    const deltaRad = deltaDeg * Math.PI / 180.0;
    const chordDist = 2.0 * c.radius * Math.sin(deltaRad / 2.0) * uf;

    const dn = chordDist * Math.cos(synthAzRad);
    const de = chordDist * Math.sin(synthAzRad);
    const label = `Curve R=${(c.radius).toFixed(2)} Δ=${deltaDeg.toFixed(4)}° [CHORD-SYNTH]`;
    console.log(`Curve chord synthesized: bearing=${bp.toDisplayString(synthAzDeg)} dist=${chordDist.toFixed(3)}'`);
    return { dn, de, perimeter: perim, label };
  }

  throw new Error('Curve requires ChordBearing+ChordDistance, or Radius+Delta+incoming bearing for synthesis.');
}

/** Convert packed DMS value to radians. */
function dmsToRad(dms) {
  const deg = parseDmsToDecimal(dms);
  return deg * Math.PI / 180.0;
}

// ── Compass Rule (Bowditch) Adjustment ────────────────────────────────────────
function compassRuleAdjust(stations, errN, errE, perimeter) {
  const result = [];
  let cumDist = 0;
  result.push({ seq: 0, northing: stations[0].northing, easting: stations[0].easting });

  for (let i = 1; i < stations.length; i++) {
    const s = stations[i];
    const legDist = Math.sqrt(s.depDN * s.depDN + s.depDE * s.depDE);
    cumDist += legDist;
    const k = perimeter > 0 ? cumDist / perimeter : 0;
    result.push({ seq: i, northing: s.northing + errN * k, easting: s.easting + errE * k });
  }
  return result;
}

// ── Shoelace Area ─────────────────────────────────────────────────────────────
function shoelaceArea(pts) {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    area += (p1.easting * p2.northing) - (p2.easting * p1.northing);
  }
  return Math.abs(area) / 2.0;
}

// ─── Inverse Gap Solver (AutoFixUnknownRuns) ─────────────────────────────────
// Heuristic #6: replace meander/unknown course runs with straight-line tie vectors.
// Fix #3: Now handles up to 2 separate contiguous unknown runs.
/**
 * Resolve deflection-angle courses to absolute bearings.
 *
 * Deeds by deflection angle describe a course as:
 *   "THENCE AT A DEFLECTION ANGLE TO THE LEFT OF 13°22'55", a distance of 89.02 feet"
 * rather than a compass bearing.  The outgoing azimuth is:
 *   LEFT  → incomingAz − deflectionAngle
 *   RIGHT → incomingAz + deflectionAngle
 *
 * The AI extracts these with two extra fields:
 *   { type: 'Line', deflectionAngle: 13.3819, deflectionDirection: 'LEFT', distance: 89.02 }
 *
 * Courses may also carry a cardinalDirection word ('NORTHERLY', 'SW', …) instead of a
 * numeric bearing; we resolve those too so the caller always gets a proper bearing string.
 *
 * @param {Array} courses - Raw course list from AI extraction
 * @returns {Array} Courses with all deflection angles converted to absolute bearings
 */
export function resolveDeflectionAngles(courses) {
  if (!courses || courses.length === 0) return courses;

  let prevAzDeg = null; // tracks the outgoing azimuth of the most recent resolved course

  return courses.map((c, idx) => {
    const course = { ...c };

    // ── 1. Cardinal direction word → absolute bearing
    //    e.g. bearing = 'NORTHERLY'  →  bearing = 'N00°00'00"E'
    if (course.bearing) {
      const cardAz = bp.parseCardinalAzimuth(course.bearing);
      if (cardAz !== null) {
        // Replace the word with a proper bearing string AND record the azimuth
        course.bearing = bp.toDisplayString(cardAz);
        prevAzDeg = cardAz;
        return course;
      }
      // Regular bearing — just update prevAzDeg so the next deflection can reference it
      try {
        prevAzDeg = bp.parse(course.bearing).azimuthDeg;
      } catch { /* leave prevAzDeg unchanged */ }
      return course;
    }

    // ── 2. Deflection angle course
    if (course.deflectionAngle != null && course.deflectionDirection) {
      if (prevAzDeg === null) {
        // No prior course to reference — mark as unknown for the gap solver
        console.warn(`resolveDeflectionAngles: course ${idx} has deflection but no prior azimuth — marking unknown`);
        course.isUnknown = true;
        return course;
      }
      const outAz = bp.applyDeflection(prevAzDeg, course.deflectionAngle, course.deflectionDirection);
      course.bearing = bp.toDisplayString(outAz);
      // Remove deflection fields so downstream doesn't get confused
      delete course.deflectionAngle;
      delete course.deflectionDirection;
      prevAzDeg = outAz;
      return course;
    }

    return course;
  });
}

export function autoFixUnknownRuns(courses, pob) {
  if (!courses || courses.length === 0) return courses;

  const isIncompleteCourse = (c) => {
    if (c.isUnknown) return true;
    if (c.type?.toLowerCase() === 'line') {
      // distance=0 is treated as unknown — meander courses often land here
      // when the AI sees "along meanderings thereof, 100 ft more or less"
      return !c.bearing || c.distance == null || isNaN(c.distance) || c.distance === 0;
    }
    if (c.type?.toLowerCase() === 'curve') {
      return !c.chordBearing || c.chordDistance == null || isNaN(c.chordDistance) || c.chordDistance === 0;
    }
    return true;
  };

  // Build runs of consecutive unknown/incomplete courses
  const runs = [];
  const n = courses.length;
  for (let i = 0; i < n;) {
    if (isIncompleteCourse(courses[i])) {
      let j = i;
      while (j < n && isIncompleteCourse(courses[j])) j++;
      runs.push({ start: i, end: j - 1 });
      i = j;
    } else i++;
  }

  if (runs.length === 0) return courses;

  // ── Single unknown run (original logic) ──────────────────────────────────
  if (runs.length === 1) {
    return _solveOneRun(courses, runs[0], pob);
  }

  // ── Two unknown runs (Fix #3) — iterative solve ───────────────────────────
  if (runs.length === 2) {
    // Strategy: solve run[0] assuming run[1] closes perfectly (set run[1] to zero-vector temporarily),
    // then re-solve run[1] with run[0] locked in. One iteration usually suffices for well-formed deeds.
    console.log(`Inverse Gap Solver: 2 unknown runs detected at [${runs[0].start}-${runs[0].end}] and [${runs[1].start}-${runs[1].end}]. Attempting iterative solve.`);

    // Pass 1: freeze run[1] out (zero displacement), solve run[0]
    const pass1 = courses.map(c => ({ ...c }));
    for (let i = runs[1].start; i <= runs[1].end; i++) {
      pass1[i] = { type: 'Line', bearing: 'N00°00\'00"E', distance: 0.0001, isUnknown: false, _frozen: true };
    }
    const afterPass1 = _solveOneRun(pass1, runs[0], pob);

    // Pass 2: restore run[1] unknowns and solve against the now-locked run[0]
    const pass2 = afterPass1.map(c => c._frozen ? courses[afterPass1.indexOf(c)] : c);
    // Re-index: the run[1] indices may have shifted if run[0] was multi-course. Find run[1] again.
    const runs2 = [];
    for (let i = 0; i < pass2.length;) {
      if (isIncompleteCourse(pass2[i])) {
        let j = i;
        while (j < pass2.length && isIncompleteCourse(pass2[j])) j++;
        runs2.push({ start: i, end: j - 1 });
        i = j;
      } else i++;
    }
    if (runs2.length === 1) {
      const result = _solveOneRun(pass2, runs2[0], pob);
      console.log(`Inverse Gap Solver: 2-run iterative solve succeeded.`);
      return result;
    }
    // If still 2 runs after pass 2, fall through to returning original (cannot solve)
    console.warn(`Inverse Gap Solver: Could not resolve 2 unknown runs — returning original courses.`);
    return courses;
  }

  // More than 2 unknown runs — cannot solve mathematically
  console.warn(`Inverse Gap Solver: ${runs.length} unknown runs — cannot solve, returning original.`);
  return courses;
}

/** Internal: solve exactly one contiguous unknown run with a tie vector. */
function _solveOneRun(courses, run, pob) {
  const n = courses.length;
  let dN_complete = 0;
  let dE_complete = 0;

  for (let i = 0; i < n; i++) {
    if (i < run.start || i > run.end) {
      const { dn, de } = computeVector(courses[i]);
      dN_complete += dn;
      dE_complete += de;
    }
  }

  const dN_tie = -dN_complete;
  const dE_tie = -dE_complete;
  const chordDist = Math.sqrt(dN_tie * dN_tie + dE_tie * dE_tie);

  if (chordDist < 0.01) return courses; // too small to solve

  const tieBearing = bp.vectorToBearing(dN_tie, dE_tie);
  const replacement = {
    type: 'Line',
    bearing: tieBearing,
    distance: Math.round(chordDist * 100) / 100,
    isUnknown: false,
  };

  const result = [...courses];
  result.splice(run.start, run.end - run.start + 1, replacement);

  console.log(`Inverse Gap Solver: Solved run [${run.start} to ${run.end}] with tie: ${tieBearing} ${replacement.distance.toFixed(2)}'`);
  return result;
}

function computeVector(c) {
  try {
    if (c.type?.toLowerCase() === 'line') {
      const { azimuthRad } = bp.parse(c.bearing);
      const dist = parseFloat(c.distance);
      return { dn: dist * Math.cos(azimuthRad), de: dist * Math.sin(azimuthRad) };
    }
    // Curve — use chord
    const { azimuthRad } = bp.parse(c.chordBearing);
    const dist = parseFloat(c.chordDistance);
    return { dn: dist * Math.cos(azimuthRad), de: dist * Math.sin(azimuthRad) };
  } catch {
    return { dn: 0, de: 0 };
  }
}
