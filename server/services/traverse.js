// ─── Traverse Service ───────────────────────────────────────────────────────
// Port of TraverseService.cs — traverse computation, compass rule, shoelace area.
// Replaces RCS.Cogo.Core with pure JS math (bearingParser.js).

import * as bp from './bearingParser.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('traverse');

// ── Unit Scale Factors (Fix #10) ─────────────────────────────────────────────
// All internal math is in feet. Metric deed distances are converted on input.
const UNIT_TO_FEET = { feet: 1.0, foot: 1.0, ft: 1.0, meters: 3.28084, metre: 3.28084, m: 3.28084 };

function unitFactor(units) {
  return UNIT_TO_FEET[(units || 'Feet').toLowerCase()] ?? 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX #1: Shared curve geometry solver
// Both resolveCurveProperties() and computeCurve() previously duplicated ~80
// lines of R/L/Δ/C resolution.  This single function owns that logic now.
//
// Input:  any two (or three) of { r, l, dDeg, chDist }  (null = unknown)
// Output: { r, l, dDeg, deltaRad, chDist } fully resolved, or original nulls
//         if insufficient inputs.
// ─────────────────────────────────────────────────────────────────────────────
function solveCurveGeometry(r, l, dDeg, chDist) {
  let deltaRad = dDeg !== null ? dDeg * Math.PI / 180 : null;

  // Reconcile conflicting parameters: if R, Arc, and Delta are all provided,
  // check mathematical consistency (tolerance 0.5°).  When they disagree,
  // recalculate delta from the physical arc length and radius.
  if (r !== null && l !== null && dDeg !== null) {
    const calculatedDeltaRad = l / r;
    const calculatedDeltaDeg = calculatedDeltaRad * 180.0 / Math.PI;
    if (Math.abs(dDeg - calculatedDeltaDeg) > 0.5) {
      log.debug({ statedDelta: dDeg.toFixed(4), calculatedDelta: calculatedDeltaDeg.toFixed(4) }, 'solveCurveGeometry: reconciling conflict — using arc/radius');
      dDeg = calculatedDeltaDeg;
      deltaRad = calculatedDeltaRad;
      chDist = 2 * r * Math.sin(deltaRad / 2);
    }
  }

  // 1. Resolve deltaRad / dDeg from any two of (r, l, chDist)
  if (deltaRad === null) {
    if (r !== null && l !== null) {
      deltaRad = l / r;
    } else if (r !== null && chDist !== null) {
      if (chDist <= 2 * r) {
        deltaRad = 2 * Math.asin(chDist / (2 * r));
      }
    } else if (l !== null && chDist !== null) {
      if (chDist < l) {
        // Binary search: solve sin(x)/x = chDist/l  for x ∈ (0, π)
        const ratio = chDist / l;
        let low = 0;
        let high = Math.PI;
        for (let iter = 0; iter < 50; iter++) {
          const mid = (low + high) / 2;
          const val = Math.sin(mid) / mid;
          if (val > ratio) {
            low = mid;
          } else {
            high = mid;
          }
        }
        deltaRad = 2 * ((low + high) / 2);
      }
    }
  }

  // 2. Resolve R, L, C from deltaRad
  if (deltaRad !== null && deltaRad > 0) {
    if (r === null) {
      if (l !== null) {
        r = l / deltaRad;
      } else if (chDist !== null) {
        const sinHalf = Math.sin(deltaRad / 2);
        if (sinHalf > 0) r = chDist / (2 * sinHalf);
      }
    }
    if (l === null && r !== null)      l      = r * deltaRad;
    if (chDist === null && r !== null) chDist = 2 * r * Math.sin(deltaRad / 2);
    dDeg = deltaRad * 180 / Math.PI;
  }

  return { r, l, dDeg, deltaRad, chDist };
}

function resolveCurveProperties(c, prevAzimuthDeg) {
  if (c.type?.toLowerCase() !== 'curve') return;

  let r      = c.radius       != null && c.radius       !== '' ? parseFloat(c.radius)       : null;
  let l      = c.arcLength    != null && c.arcLength    !== '' ? parseFloat(c.arcLength)    : null;
  let dDeg   = c.delta        != null && c.delta        !== '' ? parseDmsToDecimal(c.delta)  : null;
  let chDist = c.chordDistance!= null && c.chordDistance!== '' ? parseFloat(c.chordDistance): null;
  let chBrg  = c.chordBearing || c.bearing || null;

  if (isNaN(r))      r      = null;
  if (isNaN(l))      l      = null;
  // parseDmsToDecimal now returns null on failure, but guard NaN just in case
  if (dDeg !== null && isNaN(dDeg)) dDeg = null;
  if (isNaN(chDist)) chDist = null;

  // Use shared solver (Fix #1)
  ({ r, l, dDeg, chDist } = solveCurveGeometry(r, l, dDeg, chDist));

  // Write back
  if (r      !== null) c.radius        = r;
  if (l      !== null) c.arcLength     = l;
  if (dDeg   !== null) c.delta         = dDeg.toFixed(6);
  if (chDist !== null) c.chordDistance = chDist;

  // Resolve chordBearing if missing
  if (chBrg === null && prevAzimuthDeg !== null && dDeg !== null) {
    const deflectionSign = (c.curveDirection || c.direction || '').toLowerCase() === 'left' ? -1 : 1;
    const synthAzDeg = (prevAzimuthDeg + deflectionSign * (dDeg / 2.0) + 360) % 360;
    chBrg = bp.toDisplayString(synthAzDeg);
  }
  if (chBrg !== null) c.chordBearing = chBrg;

  // Mark solved if all four required pieces are present
  if (c.radius != null && c.arcLength != null && c.chordBearing != null && c.chordDistance != null) {
    c.isUnknown = false;
  }
}

/**
 * Compute a full traverse: raw coords → closure → compass rule → area.
 * @param {object} req - { pointOfBeginning: {northing, easting}, courses: [...], units, isOpenEnded }
 * @returns {object} TraverseResult
 */
export function compute(req) {
  // ── Step 0: Resolve deflection angles → absolute bearings
  const resolved = resolveDeflectionAngles(req.courses);

  const uf = unitFactor(req.units);

  // ── Step 0.5: Pre-resolve/fill missing curve parameters
  let tempAz = null;
  if (req.commencementSegments && req.commencementSegments.length > 0) {
    for (const comm of req.commencementSegments) {
      if (comm.type?.toLowerCase() === 'line' && comm.bearing) {
        try { tempAz = bp.parse(comm.bearing).azimuthDeg; } catch {}
      } else if (comm.type?.toLowerCase() === 'curve') {
        resolveCurveProperties(comm, tempAz);
        if (tempAz !== null && comm.delta) {
          const deflectionSign = (comm.curveDirection || comm.direction || '').toLowerCase() === 'left' ? -1 : 1;
          tempAz = (tempAz + deflectionSign * comm.delta + 360) % 360;
        } else if (comm.chordBearing) {
          try { tempAz = bp.parse(comm.chordBearing).azimuthDeg; } catch {}
        }
      }
    }
  }

  for (const course of resolved) {
    if (course.type?.toLowerCase() === 'line') {
      if (course.bearing) {
        try { tempAz = bp.parse(course.bearing).azimuthDeg; } catch {}
      }
    } else if (course.type?.toLowerCase() === 'curve') {
      resolveCurveProperties(course, tempAz);
      if (course.delta) {
        const deflectionSign = (course.curveDirection || course.direction || '').toLowerCase() === 'left' ? -1 : 1;
        if (tempAz !== null) {
          tempAz = (tempAz + deflectionSign * course.delta + 360) % 360;
        } else if (course.chordBearing) {
          try { tempAz = bp.parse(course.chordBearing).azimuthDeg; } catch {}
        }
      }
    }
  }

  // ── Inverse Gap Solver: auto-fix meander/unknown runs
  const courses = autoFixUnknownRuns(resolved, req.pointOfBeginning);

  const pobN = req.pointOfBeginning.northing;
  const pobE = req.pointOfBeginning.easting;
  const stations = [];
  let curN = pobN, curE = pobE;
  let seq = 0;

  // Add POB
  stations.push({ seq: seq++, course: 'POB', northing: pobN, easting: pobE, depDN: 0, depDE: 0 });

  let perimeter = 0;
  let prevAzimuthDeg = null; // Track incoming azimuth for curve chord synthesis (Fix #7)
  const computedCenters = [];

  // Initialize prevAzimuthDeg and computedCenters from commencement segments if available
  if (req.commencementSegments && req.commencementSegments.length > 0) {
    let tempAz = null;
    let POC_N = 5000;
    let POC_E = 5000;
    let currN = POC_N;
    let currE = POC_E;
    
    const commCoords = [];
    for (const comm of req.commencementSegments) {
      commCoords.push({ startN: currN, startE: currE });
      let dn = 0, de = 0;
      if (comm.type?.toLowerCase() === 'line' && comm.bearing && comm.distance != null) {
        try {
          const parsed = bp.parse(comm.bearing);
          tempAz = parsed.azimuthDeg;
          dn = comm.distance * uf * Math.cos(parsed.azimuthRad);
          de = comm.distance * uf * Math.sin(parsed.azimuthRad);
        } catch {}
      } else if (comm.type?.toLowerCase() === 'curve' && comm.radius) {
        let deltaDeg = parseDmsToDecimal(comm.delta);
        if ((comm.delta == null || comm.delta === 0) && comm.radius && comm.arcLength) {
          const deltaRad = comm.arcLength / comm.radius;
          deltaDeg = deltaRad * 180.0 / Math.PI;
        }
        if (tempAz !== null && deltaDeg) {
          const deflectionSign = (comm.curveDirection || comm.direction || '').toLowerCase() === 'left' ? -1 : 1;
          const halfDelta = deltaDeg / 2;
          const chordAzDeg = (tempAz + deflectionSign * halfDelta + 360) % 360;
          const chordAzRad = chordAzDeg * Math.PI / 180;
          const chordDist = 2 * comm.radius * Math.sin((deltaDeg * Math.PI / 180) / 2) * uf;
          dn = chordDist * Math.cos(chordAzRad);
          de = chordDist * Math.sin(chordAzRad);
          tempAz = (tempAz + deflectionSign * deltaDeg + 360) % 360;
        }
      }
      currN += dn;
      currE += de;
    }
    
    const shiftN = pobN - currN;
    const shiftE = pobE - currE;
    
    tempAz = null;
    for (let idx = 0; idx < req.commencementSegments.length; idx++) {
      const comm = req.commencementSegments[idx];
      const startN = commCoords[idx].startN + shiftN;
      const startE = commCoords[idx].startE + shiftE;
      
      if (comm.type?.toLowerCase() === 'line' && comm.bearing) {
        try { tempAz = bp.parse(comm.bearing).azimuthDeg; } catch {}
      } else if (comm.type?.toLowerCase() === 'curve' && comm.radius) {
        let deltaDeg = parseDmsToDecimal(comm.delta);
        if ((comm.delta == null || comm.delta === 0) && comm.radius && comm.arcLength) {
          const deltaRad = comm.arcLength / comm.radius;
          deltaDeg = deltaRad * 180.0 / Math.PI;
        }
        if (tempAz !== null && deltaDeg) {
          const deflectionSign = (comm.curveDirection || comm.direction || '').toLowerCase() === 'left' ? -1 : 1;
          
          const radialDirDeg = (tempAz + deflectionSign * 90 + 360) % 360;
          const radialDirRad = radialDirDeg * Math.PI / 180;
          const centerN = startN + comm.radius * uf * Math.cos(radialDirRad);
          const centerE = startE + comm.radius * uf * Math.sin(radialDirRad);
          const outgoingTangent = (tempAz + deflectionSign * deltaDeg + 360) % 360;
          computedCenters.push({
            name: `Commencement Curve ${idx + 1}`,
            centerN,
            centerE,
            radius: comm.radius * uf,
            outgoingTangent
          });
          
          tempAz = outgoingTangent;
        }
      }
    }
    if (tempAz !== null) {
      prevAzimuthDeg = tempAz;
    }
  }

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
      let centerN = null, centerE = null, outgoingTangent = null;
      ({ dn, de, perimeter, label, centerN, centerE, outgoingTangent } = computeCurve(
        course, perimeter, uf, prevAzimuthDeg, curN, curE, computedCenters
      ));

      if (centerN !== null && centerE !== null) {
        computedCenters.push({ name: label, centerN, centerE, radius: course.radius * uf, outgoingTangent });
      }

      if (outgoingTangent !== null) {
        prevAzimuthDeg = outgoingTangent;
      } else if (course.chordBearing) {
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

  // Compass Rule
  const adjusted = compassRuleAdjust(
    stations,
    req.isOpenEnded ? 0 : errorN,
    req.isOpenEnded ? 0 : errorE,
    perimeter
  );

  const hasSelfIntersection = detectSelfIntersection(adjusted);
  const enforceFailsafe = process.env.ENFORCE_NO_SELF_INTERSECTION === 'true';

  let ratio, status;
  if (req.isOpenEnded) {
    ratio = '1:∞ (Open-Ended)';
    status = '✓ PASSES  (Open-Ended Traverse)';
  } else {
    ratio = precision >= 999999 ? '1:∞ (Perfect)' : `1:${Math.round(precision).toLocaleString()}`;
    if (enforceFailsafe && hasSelfIntersection) {
      status = `✗ FAILS   (Self-Intersecting Polyline)`;
    } else {
      status = precision >= 10000
        ? `✓ PASSES  ${ratio}`
        : `✗ FAILS   ${ratio}  (min 1:10,000)`;
    }
  }

  const closure = { errorNorthing: errorN, errorEasting: errorE, linearError, perimeter, precisionRatio: ratio, status, hasSelfIntersection };

  // Area via Shoelace
  const areaSqFt = shoelaceArea(adjusted);
  const areaAcres = areaSqFt / 43560.0;

  return { stations, closure, perimeter, areaSqFt, areaAcres, adjustedStations: adjusted, courses, hasSelfIntersection };
}

// ── Curve computation ─────────────────────────────────────────────────────────
/**
 * Parse a DMS string or packed-DMS number to decimal degrees.
 *
 * FIX #2: Returns `null` (not `0`) on unrecognised input so callers can
 * distinguish a genuine zero-degree value from a parse failure.
 *
 * Accepts:
 *   • Plain decimal:          "93.3855"        → 93.3855
 *   • Packed DMS number:      93.6200          → 93°62'00" → graceful scrivener-error handling
 *   • D°M'S" strings:         "93°23'06.99\"" → 93.385275
 *   • Scrivener-error DMS:    "22°97'38.78\"" (min ≥ 60) → treated as decimal
 */
export function parseDmsToDecimal(dms) {
  if (dms == null) return null;
  if (typeof dms === 'number') {
    if (isNaN(dms)) return null;
    // Treat as packed DMS (e.g. 93.6200 → 93°62'00" is a scrivener error, but
    // we still handle the normal case: 93.2300 → 93°23'00")
    const d = Math.floor(Math.abs(dms));
    const rem = (Math.abs(dms) - d) * 100;
    const m = Math.floor(rem);
    const s = (rem - m) * 100;
    return (d + m / 60.0 + s / 3600.0) * (dms < 0 ? -1 : 1);
  }

  const clean = dms.toString().trim();
  if (!clean) return null;

  const match = clean.match(/^(-?\d+(?:\.\d+)?)\s*[°º\*^d]?$/)
    || clean.match(/^(-?\d+)\s*[°º\*^d]?\s*(\d+)\s*['''`]?\s*(\d+(?:\.\d+)?)\s*[""\']{0,2}$/)
    || clean.match(/^(-?\d+)\s*[°º\*^d]?\s*(\d+(?:\.\d+)?)\s*['''`]?$/);

  if (match) {
    const deg = parseFloat(match[1]);
    const min = match[2] ? parseFloat(match[2]) : 0;
    const sec = match[3] ? parseFloat(match[3]) : 0;

    // Scrivener error: minutes field ≥ 60 (e.g. "22°97'38.78\"") — treat the
    // minute+second portion as decimal fraction digits of the degree.
    if (min >= 60) {
      const minStr = match[2];
      const secStr = match[3] || '';
      const combinedDecStr = `${minStr}${secStr}`.replace(/\./g, '');
      const decValue = parseFloat(`${deg}.${combinedDecStr}`);
      return decValue * (deg < 0 ? -1 : 1);
    }

    const sign = deg < 0 ? -1 : 1;
    return (Math.abs(deg) + min / 60.0 + sec / 3600.0) * sign;
  }

  // Fallback: try parsing as simple float
  const val = parseFloat(clean);
  if (!isNaN(val)) return val;

  // FIX #2: Return null so callers know the input was unparseable.
  log.warn({ dms }, 'parseDmsToDecimal: unrecognised DMS string — returning null');
  return null;
}

function computeCurve(c, perim, uf, prevAzimuthDeg, startN, startE, computedCenters) {
  let r      = c.radius        != null && c.radius        !== '' ? parseFloat(c.radius)        : null;
  let l      = c.arcLength     != null && c.arcLength     !== '' ? parseFloat(c.arcLength)     : null;
  let dDeg   = c.delta         != null && c.delta         !== '' ? parseDmsToDecimal(c.delta)  : null;
  let chDist = c.chordDistance != null && c.chordDistance !== '' ? parseFloat(c.chordDistance) : null;
  let chBrg  = c.chordBearing || c.bearing || null;

  if (isNaN(r))      r      = null;
  if (isNaN(l))      l      = null;
  // parseDmsToDecimal returns null on failure (Fix #2); also guard explicit NaN
  if (dDeg !== null && isNaN(dDeg)) dDeg = null;
  if (isNaN(chDist)) chDist = null;

  // Use shared solver — eliminates duplicated reconciliation logic (Fix #1)
  let deltaRad;
  ({ r, l, dDeg, deltaRad, chDist } = solveCurveGeometry(r, l, dDeg, chDist));

  // Write back resolved geometry to the course object
  if (r      !== null) c.radius        = r;
  if (l      !== null) c.arcLength     = l;
  if (dDeg   !== null) c.delta         = dDeg.toFixed(6);
  if (chDist !== null) c.chordDistance = chDist;

  // Resolve chordBearing if missing and we have prevAzimuthDeg
  if (chBrg === null && prevAzimuthDeg !== null && dDeg !== null) {
    const deflectionSign = (c.curveDirection || c.direction || '').toLowerCase() === 'left' ? -1 : 1;
    const synthAzDeg = (prevAzimuthDeg + deflectionSign * (dDeg / 2.0) + 360) % 360;
    chBrg = bp.toDisplayString(synthAzDeg);
  }
  if (chBrg !== null) c.chordBearing = chBrg;

  let deltaDeg = dDeg;

  // Arc length: prefer given, else compute from R × Δ
  let arcLen = l;
  if (arcLen == null && r && deltaDeg) {
    const deltaRad = deltaDeg * Math.PI / 180.0;
    arcLen = r * deltaRad;
  }
  if (arcLen == null) arcLen = 0;
  perim += (arcLen * uf);

  let incTangent = prevAzimuthDeg;
  let concentricMatch = null;

  if (c.radius && startN != null && startE != null && computedCenters) {
    for (const cc of computedCenters) {
      const distToCenter = Math.sqrt((cc.centerN - startN)**2 + (cc.centerE - startE)**2);
      if (Math.abs(distToCenter - c.radius * uf) < 5.0) {
        concentricMatch = cc;
        break;
      }
    }
  }

  if (concentricMatch) {
    const radToCenterRad = Math.atan2(concentricMatch.centerE - startE, concentricMatch.centerN - startN);
    let radToCenterDeg = radToCenterRad * 180 / Math.PI;
    if (radToCenterDeg < 0) radToCenterDeg += 360;

    const t1 = (radToCenterDeg - 90 + 360) % 360;
    const t2 = (radToCenterDeg + 90 + 360) % 360;

    const referenceAngle = concentricMatch.outgoingTangent ?? prevAzimuthDeg;
    if (referenceAngle !== null) {
      const diff1 = Math.min(Math.abs(t1 - referenceAngle), 360 - Math.abs(t1 - referenceAngle));
      const diff2 = Math.min(Math.abs(t2 - referenceAngle), 360 - Math.abs(t2 - referenceAngle));
      incTangent = diff1 < diff2 ? t1 : t2;
    } else {
      incTangent = t1;
    }
    // console.log(` RadToCenterDegRadToCenterDeg radialDirDeg radialDirRad radToCenterDeg RadToCenterDeg RadToCenterDeg RadToCenterDeg radToCenterDegRadToCenterDeg RadToCenterDegRadToCenterDeg RadToCenterDegRadToCenterDeg radToCenterDegRadToCenterDeg RadToCenterDegRadToCenterDeg RadToCenterDeg RadToCenterDeg [traverse.js] Concentric curve matched. Radius: ${c.radius}, Selected tangent: ${bp.toDisplayString(incTangent)}`);
    // console.log(`[traverse.js] Concentric curve matched. Radius: ${c.radius}, Selected tangent: ${bp.toDisplayString(incTangent)}`);
  }

  let outgoingTangent = null;
  let centerN = null;
  let centerE = null;

  if (incTangent !== null && deltaDeg !== null && c.radius) {
    const deflectionSign = (c.curveDirection || c.direction || '').toLowerCase() === 'left' ? -1 : 1;
    outgoingTangent = (incTangent + deflectionSign * deltaDeg + 360) % 360;

    const radialDirDeg = (incTangent + deflectionSign * 90 + 360) % 360;
    const radialDirRad = radialDirDeg * Math.PI / 180;
    centerN = startN + c.radius * uf * Math.cos(radialDirRad);
    centerE = startE + c.radius * uf * Math.sin(radialDirRad);
  }

  // Use chord bearing + chord distance
  if (c.chordBearing && c.chordDistance != null) {
    const { azimuthDeg, azimuthRad } = bp.parse(c.chordBearing);
    const dist = c.chordDistance * uf;
    const dn = dist * Math.cos(azimuthRad);
    const de = dist * Math.sin(azimuthRad);
    const label = `Curve R=${(c.radius || 0).toFixed(2)} Δ=${deltaDeg.toFixed(4)}°`;
    return { dn, de, perimeter: perim, label, centerN, centerE, outgoingTangent };
  }

  // Synthesize chord bearing from incoming azimuth + delta/2
  if (c.radius != null && c.delta != null && incTangent != null) {
    const halfDelta = deltaDeg / 2.0;
    const deflectionSign = (c.curveDirection || c.direction || '').toLowerCase() === 'left' ? -1 : 1;
    const synthAzDeg = (incTangent + deflectionSign * halfDelta + 360) % 360;
    const synthAzRad = synthAzDeg * Math.PI / 180.0;

    const deltaRad = deltaDeg * Math.PI / 180.0;
    const chordDist = 2.0 * c.radius * Math.sin(deltaRad / 2.0) * uf;

    const dn = chordDist * Math.cos(synthAzRad);
    const de = chordDist * Math.sin(synthAzRad);
    const label = `Curve R=${(c.radius).toFixed(2)} Δ=${deltaDeg.toFixed(4)}° [CHORD-SYNTH]`;
    // console.log(`Curve chord synthesized: bearing=${bp.toDisplayString(synthAzDeg)} dist=${chordDist.toFixed(3)}'`);
    return { dn, de, perimeter: perim, label, centerN, centerE, outgoingTangent };
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
        // Fallback to arbitrary reference azimuth (0 = North)
        prevAzDeg = 0;
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
      if (!c.bearing || c.distance == null || isNaN(c.distance) || c.distance === 0) return true;
      try {
        bp.parse(c.bearing);
        return false;
      } catch {
        return true;
      }
    }
    if (c.type?.toLowerCase() === 'curve') {
      if (c.radius != null && (c.arcLength != null || c.delta != null)) {
        return false;
      }
      if (!c.chordBearing || c.chordDistance == null || isNaN(c.chordDistance) || c.chordDistance === 0) return true;
      try {
        bp.parse(c.chordBearing);
        return false;
      } catch {
        return true;
      }
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

  // ── Two unknown runs — iterative solve ───────────────────────────────────
  if (runs.length === 2) {
    // Strategy: freeze run[1] to a near-zero tie so run[0] can be solved first,
    // then lock run[0]'s solution and solve run[1].
    log.debug({ run0: `${runs[0].start}-${runs[0].end}`, run1: `${runs[1].start}-${runs[1].end}` }, 'Inverse Gap Solver: 2 unknown runs detected. Attempting iterative solve.');

    // Pass 1: replace run[1] slots with a placeholder, solve run[0].
    // FIX #3: track frozen positions by index (not object reference) to avoid
    // the broken afterPass1.indexOf(c) lookup on spread-cloned objects.
    const pass1 = courses.map(c => ({ ...c }));
    const frozenIndices = new Set();
    for (let i = runs[1].start; i <= runs[1].end; i++) {
      pass1[i] = { type: 'Line', bearing: "N00°00'00\"E", distance: 0.0001, isUnknown: false };
      frozenIndices.add(i);
    }
    const afterPass1 = _solveOneRun(pass1, runs[0], pob);

    // Pass 2: restore the original run[1] courses by original position.
    // afterPass1 may be shorter than pass1 when a multi-course unknown run was
    // collapsed to a single tie vector; map positions via a stable walk.
    const pass2 = [...afterPass1];
    // Find where the frozen placeholder(s) ended up in afterPass1.
    // Because _solveOneRun only splices run[0] and never touches run[1] indices
    // (run[1] always comes after run[0]), the frozen index offsets are stable
    // as long as run[0] was a single splice.  We re-detect unknown runs anyway.
    for (let i = 0; i < pass2.length; i++) {
      // A placeholder has distance === 0.0001 and is not flagged isUnknown
      if (
        pass2[i]?.type === 'Line' &&
        pass2[i]?.distance === 0.0001 &&
        pass2[i]?.isUnknown === false &&
        pass2[i]?.bearing === "N00°00'00\"E"
      ) {
        // Restore the corresponding original course.  Because run[1] starts after
        // run[0] and run[0] was collapsed to 1 course, the frozen slots shift by
        // (run[0].end - run[0].start) positions relative to their original index.
        const originalIdx = runs[1].start + (i - (runs[0].start + 1));
        if (originalIdx >= 0 && originalIdx < courses.length) {
          pass2[i] = { ...courses[originalIdx] };
        }
      }
    }

    // Re-detect unknown runs in pass2 (positions may have shifted)
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
      log.info('Inverse Gap Solver: 2-run iterative solve succeeded.');
      return result;
    }
    log.warn('Inverse Gap Solver: Could not resolve 2 unknown runs — returning original courses.');
    return courses;
  }

  // More than 2 unknown runs — cannot solve mathematically
  log.warn({ runCount: runs.length }, 'Inverse Gap Solver: multiple unknown runs — cannot solve, returning original.');
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

  if (chordDist < 0.01 || isNaN(chordDist)) return courses; // too small or invalid to solve

  const tieBearing = bp.vectorToBearing(dN_tie, dE_tie);
  const replacement = {
    type: 'Line',
    bearing: tieBearing,
    distance: Math.round(chordDist * 100) / 100,
    isUnknown: false,
  };

  const result = [...courses];
  result.splice(run.start, run.end - run.start + 1, replacement);

  log.info({ run: `${run.start}-${run.end}`, tieBearing, dist: replacement.distance.toFixed(2) }, 'Inverse Gap Solver: Solved run');
  return result;
}

function computeVector(c) {
  try {
    if (c.type?.toLowerCase() === 'line') {
      const { azimuthRad } = bp.parse(c.bearing);
      const dist = parseFloat(c.distance);
      if (isNaN(dist) || isNaN(azimuthRad)) return { dn: 0, de: 0 };
      return { dn: dist * Math.cos(azimuthRad), de: dist * Math.sin(azimuthRad) };
    }
    // Curve — use chord
    const { azimuthRad } = bp.parse(c.chordBearing);
    const dist = parseFloat(c.chordDistance);
    if (isNaN(dist) || isNaN(azimuthRad)) return { dn: 0, de: 0 };
    return { dn: dist * Math.cos(azimuthRad), de: dist * Math.sin(azimuthRad) };
  } catch {
    return { dn: 0, de: 0 };
  }
}

export function detectSelfIntersection(stations) {
  if (!stations || stations.length < 4) return false;
  
  const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
  const intersect = (A, B, C, D) => ccw(A, C, D) !== ccw(B, C, D) && ccw(A, B, C) !== ccw(A, B, D);
  
  const n = stations.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (i === 0 && j === n - 2) continue; // skip sharing vertex at start/end
      const A = { x: stations[i].easting, y: stations[i].northing };
      const B = { x: stations[i+1].easting, y: stations[i+1].northing };
      const C = { x: stations[j].easting, y: stations[j].northing };
      const D = { x: stations[j+1].easting, y: stations[j+1].northing };
      
      if (A.x == null || B.x == null || C.x == null || D.x == null) continue;
      
      if (intersect(A, B, C, D)) {
        return true;
      }
    }
  }
  return false;
}
