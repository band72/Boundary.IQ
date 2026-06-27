import { useState, useEffect, useRef } from 'react';
import { resolveLabels, getLeaderIntersection } from '../utils/labelLayout';

const PAD = 50;

function parseCardinalAzimuthClient(word) {
  if (!word || /\d/.test(word)) return null;
  const CARDINAL_MAP = {
    'N': 0,   'NORTH': 0,     'NORTHERLY': 0,
    'NE': 45, 'NORTHEAST': 45, 'NORTHEASTERLY': 45,
    'E': 90,  'EAST': 90,     'EASTERLY': 90,
    'SE': 135,'SOUTHEAST': 135,'SOUTHEASTERLY': 135,
    'S': 180, 'SOUTH': 180,   'SOUTHERLY': 180,
    'SW': 225,'SOUTHWEST': 225,'SOUTHWESTERLY': 225,
    'W': 270, 'WEST': 270,    'WESTERLY': 270,
    'NW': 315,'NORTHWEST': 315,'NORTHWESTERLY': 315,
    'NNE': 22.5,  'NORTHNORTHEAST': 22.5,
    'ENE': 67.5,  'EASTNORTHEAST': 67.5,
    'ESE': 112.5, 'EASTSOUTHEAST': 112.5,
    'SSE': 157.5, 'SOUTHSOUTHEAST': 157.5,
    'SSW': 202.5, 'SOUTHSOUTHWEST': 202.5,
    'WSW': 247.5, 'WESTSOUTHWEST': 247.5,
    'WNW': 292.5, 'WESTNORTHWEST': 292.5,
    'NNW': 337.5, 'NORTHNORTHWEST': 337.5,
  };
  const key = word.toUpperCase().replace(/[^A-Z]/g, '');
  return key in CARDINAL_MAP ? CARDINAL_MAP[key] : null;
}

function parseBearingToAzimuthDegrees(bearing) {
  if (!bearing) return null;
  let clean = bearing.toString().trim()
    .replace(/(\d+)\.(\d{1,2})\.(\d{1,2})\.(\d+)/g, '$1°$2\'$3.$4"')
    .replace(/(\d+)\.(\d{1,2})\.(\d{1,2})/g, '$1°$2\'$3"')
    .replace(/(?:([NSns])\s*\.?\s*)?([0-8]\d)[89](\d{2})[*'\-\s]+(\d{2}(?:\.\d+)?)\s*["\u201D\u2033]?\s*([EWew])?/gi, (match, ns, deg, min, sec, ew) => {
      return `${ns || ''}${deg}°${min}'${sec}"${ew || ''}`;
    })
    .replace(/(?:([NSns])\s*)?(\d{5,6}(?:\.\d+)?)(?:\s*([EWew]))?/gi, (match, ns, digits, ew) => {
      if (!ns && !ew) return match;
      const dotIdx = digits.indexOf('.');
      const intPart = dotIdx !== -1 ? digits.slice(0, dotIdx) : digits;
      const decPart = dotIdx !== -1 ? digits.slice(dotIdx) : '';
      let deg, min, sec;
      if (intPart.length === 6) {
        deg = intPart.slice(0, 2);
        min = intPart.slice(2, 4);
        sec = intPart.slice(4) + decPart;
      } else if (intPart.length === 5) {
        deg = intPart.slice(0, 1);
        min = intPart.slice(1, 3);
        sec = intPart.slice(3) + decPart;
      } else {
        return match;
      }
      return `${ns || ''}${deg}°${min}'${sec}"${ew || ''}`;
    })
    .replace(/\u2032/g, "'"  )
    .replace(/\u2033/g, '"'  )
    .replace(/\u2034/g, '"'  )
    .replace(/\u02B9/g, "'"  )
    .replace(/\u02BA/g, '"'  )
    .replace(/\uF0B0/g, '°'  )
    .replace(/\uF0B2/g, "'"  )
    .replace(/\uFEFF/g, ''   )
    .replace(/\u00BA/g, '°'  )
    .replace(/\u02DA/g, '°'  )
    .replace(/\u039D/g, 'N'  )
    .replace(/\u0391/g, 'A'  )
    .replace(/\u039F/g, 'O'  )
    .replace(/\u0395/g, 'E'  )
    .replace(/\u0397/g, 'H'  )
    .replace(/\u039A/g, 'K'  )
    .replace(/\u039C/g, 'M'  )
    .replace(/\u03A1/g, 'R'  )
    .replace(/\u03A4/g, 'T'  )
    .replace(/\u03A5/g, 'Y'  )
    .replace(/\u03A7/g, 'X'  )
    .replace(/\u03A9/g, 'W'  )
    .replace(/[\u2018\u2019\u201A\u02BC\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/\bNORTH\b/gi, 'N')
    .replace(/\bSOUTH\b/gi, 'S')
    .replace(/\bEAST\b/gi, 'E')
    .replace(/\bWEST\b/gi, 'W')
    .replace(/DEGREES?|DEGREAS|DEGRES?|DEG/gi, '°')
    .replace(/MINUTES|MIN/gi, "'")
    .replace(/SECONDS|SEC/gi, '"')
    .replace(/\*/g, ' ')
    .replace(/(\d+)\s*'\s*(\d+)\s*'\s*(\d+)\s*"/g, "$1'$2.$3\"")
    .replace(/(\d+)\s*°\s*(\d+)\s*°/g, "$1°$2'")
    .replace(/(\d+)\s*'\s*(\d+)\s*°/g, '$1\'$2"');

  const cardAz = parseCardinalAzimuthClient(clean);
  if (cardAz !== null) return cardAz;

  clean = clean
    .replace(/^([NSns])\s*\./i, '$1')
    .replace(/\.\s*([EWew])$/i, '$1')
    .replace(/^([NSns])\s*/i, '$1')
    .replace(/\s*([EWew])$/i, '$1')
    .replace(/([EWew])\s*\.$/i, '$1');

  if (/^[EWew].*[NSns]$/.test(clean)) {
    const start = clean[0].toUpperCase();
    const end = clean[clean.length - 1].toUpperCase();
    clean = end + clean.slice(1, clean.length - 1) + start;
  }

  if (/^[EWew]\d/.test(clean)) {
    const start = clean[0].toUpperCase();
    if (start === 'E') clean = 'N' + clean.slice(1);
    else if (start === 'W') clean = 'S' + clean.slice(1);
  }

  clean = clean
    .replace(/\s*[°º*^d]\s*/g, '°')
    .replace(/\s*['’‘`]\s*/g, "'")
    .replace(/\s*(?:"|”|“|'')\s*/g, '"');

  clean = clean
    .replace(/(?<=\d)[OoQq]/g, '0')
    .replace(/[OoQq](?=\d)/g, '0')
    .replace(/[OoQq]\s*°/g, '0°')
    .replace(/[OoQq]\s*'/g, "0'")
    .replace(/[OoQq]\s*"/g, '0"');

  clean = clean.replace(/([NSns])\s*[^0-9°\s]*\s*°/gi, '$10°');
  clean = clean.replace(/([NSns]\s*\d{1,3})\s*([^0-9NSEWns\s])\s*(\d{1,2}\s*['])/gi, '$1°$3');
  clean = clean.replace(/([NSns]\s*\d{2,3})([0-9])(\d{2}\s*['])/gi, '$1°$3');
  clean = clean.replace(/(\d+)\s*°\s*[0-9]\s*(\d{2}\s*['])/gi, '$1°$2');

  if (clean.includes('°') && clean.includes('"') && !clean.includes("'")) {
    const numericGroups = clean.match(/\d+(?:\.\d+)?/g);
    if (numericGroups && numericGroups.length === 2) {
      clean = clean.replace(/"/g, "'");
    }
  }

  if (!clean.includes('°')) {
    const smashedMatch = /^([NSns])\s*(\d{3,4})\s*[']\s*(?:(\d{1,2}(?:\.\d+)?)\s*["])?\s*([EWew])$/i.exec(clean);
    if (smashedMatch) {
      const ns = smashedMatch[1].toUpperCase();
      const digits = smashedMatch[2];
      const sec = smashedMatch[3] || '00';
      const ew = smashedMatch[4].toUpperCase();
      const deg = digits.slice(0, digits.length - 2);
      const min = digits.slice(digits.length - 2);
      clean = `${ns}${deg}°${min}'${sec}"${ew}`;
    }
  }

  const EXPANDED = /^\s*([NSns])\s*(\d{1,3})[°\-\s](\d{1,2})['\-\s](\d{1,2}(?:\.\d+)?)["'\s]*([EWew])?\s*$/;
  const DEG_MIN  = /^\s*([NSns])\s*(\d{1,3})[°\-\s](\d{1,2}(?:\.\d+)?)['\s]*([EWew])?\s*$/;
  const DEG_ONLY = /^\s*([NSns])\s*(\d{1,3}(?:\.\d+)?)[°\s]*([EWew])?\s*$/;
  const PACKED   = /^\s*([NSns])\s*(\d+\.\d+)\s*([EWew])?\s*$/;

  const EXPANDED_NO_PREFIX = /^\s*([NSns])?\s*(\d{1,3})[°\-\s](\d{1,2})['\-\s](\d{1,2}(?:\.\d+)?)["'\s]*([EWew])\s*$/;
  const DEG_MIN_NO_PREFIX  = /^\s*([NSns])?\s*(\d{1,3})[°\-\s](\d{1,2}(?:\.\d+)?)['\s]*([EWew])\s*$/;
  const DEG_ONLY_NO_PREFIX = /^\s*([NSns])?\s*(\d{1,3}(?:\.\d+)?)[°\s]*([EWew])\s*$/;
  const PACKED_NO_PREFIX   = /^\s*([NSns])?\s*(\d+\.\d+)\s*([EWew])\s*$/;

  const getQuad = (ns, ew) => {
    const nsC = (ns || 'N').toUpperCase();
    const ewC = (ew || 'W').toUpperCase();
    const key = nsC + ewC;
    const map = { NE: 1, SE: 2, SW: 3, NW: 4 };
    return map[key] || 1;
  };

  const quadToAz = (quad, brgDeg) => {
    switch (quad) {
      case 1: return brgDeg;
      case 2: return 180 - brgDeg;
      case 3: return 180 + brgDeg;
      case 4: return 360 - brgDeg;
      default: return brgDeg;
    }
  };

  const packToDeg = (dms) => {
    const d = Math.floor(Math.abs(dms));
    const rem = (Math.abs(dms) - d) * 100;
    const m = Math.floor(rem);
    const s = (rem - m) * 100;
    return d + m / 60.0 + s / 3600.0;
  };

  let m = EXPANDED.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const sec = parseFloat(m[4]);
    const ew = (m[5] || 'W').toUpperCase();
    return quadToAz(getQuad(ns, ew), deg + min / 60.0 + sec / 3600.0);
  }

  m = EXPANDED_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const sec = parseFloat(m[4]);
    const ew = m[5].toUpperCase();
    return quadToAz(getQuad(ns, ew), deg + min / 60.0 + sec / 3600.0);
  }

  m = DEG_MIN.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const ew = (m[4] || 'W').toUpperCase();
    return quadToAz(getQuad(ns, ew), deg + min / 60.0);
  }

  m = DEG_MIN_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const ew = m[4].toUpperCase();
    return quadToAz(getQuad(ns, ew), deg + min / 60.0);
  }

  m = DEG_ONLY.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const deg = parseFloat(m[2]);
    const ew = (m[3] || 'W').toUpperCase();
    return quadToAz(getQuad(ns, ew), deg);
  }

  m = DEG_ONLY_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const deg = parseFloat(m[2]);
    const ew = m[3].toUpperCase();
    return quadToAz(getQuad(ns, ew), deg);
  }

  m = PACKED.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const packed = parseFloat(m[2]);
    const ew = (m[3] || 'W').toUpperCase();
    return quadToAz(getQuad(ns, ew), packToDeg(packed));
  }

  m = PACKED_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const packed = parseFloat(m[2]);
    const ew = m[3].toUpperCase();
    return quadToAz(getQuad(ns, ew), packToDeg(packed));
  }

  return null;
}

function computePointsFromCourses(courses, pob = { northing: 5000, easting: 5000 }) {
  const pts = [{ northing: pob.northing, easting: pob.easting }];
  let curN = pob.northing;
  let curE = pob.easting;

  courses.forEach(c => {
    let bearingStr = c.bearing || c.chordBearing || '';
    let dist = parseFloat(c.distance || c.chordDistance || c.arcLength || 0);

    if (dist <= 0) return;

    let angleRad;
    let angleDeg = parseBearingToAzimuthDegrees(bearingStr);
    if (angleDeg !== null) {
      angleRad = (angleDeg * Math.PI) / 180;
    } else {
      return; // skip if unparseable
    }

    curN += dist * Math.cos(angleRad);
    curE += dist * Math.sin(angleRad);
    pts.push({ northing: curN, easting: curE });
  });

  return pts;
}

// Helper functions to compute intermediate curve coordinates
function getCurvePoints(p1, p2, course, steps = 40) {
  const R = parseFloat(course.radius || course.Radius);
  if (!R || isNaN(R)) return [p1, p2];

  const dx = p2.easting - p1.easting;
  const dy = p2.northing - p1.northing;
  const chord = Math.hypot(dx, dy);
  if (chord < 0.01) return [p1, p2];

  const rSq = R * R;
  const halfChordSq = (chord / 2) * (chord / 2);
  if (rSq < halfChordSq) return [p1, p2];
  const h = Math.sqrt(rSq - halfChordSq);

  const mx = (p1.easting + p2.easting) / 2;
  const my = (p1.northing + p2.northing) / 2;

  const ux = -dy / chord;
  const uy = dx / chord;

  const isLeft = (course.curveDirection || course.CurveDirection || '').toLowerCase() === 'left';
  const cx = isLeft ? mx + h * ux : mx - h * ux;
  const cy = isLeft ? my + h * uy : my - h * uy;

  const a1 = Math.atan2(p1.northing - cy, p1.easting - cx);
  const a2 = Math.atan2(p2.northing - cy, p2.easting - cx);

  let diff = a2 - a1;
  if (isLeft) {
    if (diff < 0) diff += 2 * Math.PI;
  } else {
    if (diff > 0) diff -= 2 * Math.PI;
  }

  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const angle = a1 + diff * t;
    pts.push({
      easting: cx + R * Math.cos(angle),
      northing: cy + R * Math.sin(angle)
    });
  }
  return pts;
}

/** Compute the center-of-curvature (cx, cy) for a curve segment. Returns null if not computable. */
function getCurveCenter(p1, p2, course) {
  const R = parseFloat(course.radius || course.Radius);
  if (!R || isNaN(R)) return null;
  const dx = p2.easting - p1.easting;
  const dy = p2.northing - p1.northing;
  const chord = Math.hypot(dx, dy);
  if (chord < 0.01) return null;
  const rSq = R * R;
  const halfChordSq = (chord / 2) * (chord / 2);
  if (rSq < halfChordSq) return null;
  const h = Math.sqrt(rSq - halfChordSq);
  const mx = (p1.easting + p2.easting) / 2;
  const my = (p1.northing + p2.northing) / 2;
  const ux = -dy / chord;
  const uy = dx / chord;
  const isLeft = (course.curveDirection || course.CurveDirection || '').toLowerCase() === 'left';
  return {
    easting:  isLeft ? mx + h * ux : mx - h * ux,
    northing: isLeft ? my + h * uy : my - h * uy,
  };
}

function getDistanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}
 
function getWavyCreekPoints(p1, p2, frequency = 4, amplitude = 4, steps = 30) {
  const pts = [];
  const dx = p2.easting - p1.easting;
  const dy = p2.northing - p1.northing;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [p1, p2];

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const distAlong = t * len;
    const wave = Math.sin(t * Math.PI * frequency) * amplitude;
    pts.push({
      easting: p1.easting + ux * distAlong + px * wave,
      northing: p1.northing + uy * distAlong + py * wave
    });
  }
  return pts;
}

function getDensePoints(pts, coursesList) {
  if (!pts || pts.length === 0) return pts;
  if (!coursesList || coursesList.length === 0) return pts;
  const dense = [];
  dense.push(pts[0]);
  for (let i = 0; i < coursesList.length; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1] || pts[0];
    const c = coursesList[i];
    if (!p1 || !p2 || !c) continue;

    const isCreek = (c.type || '').toLowerCase() === 'squiggle' || /stream|creek|river|meander|water|shoreline|center\s*line\s*of\s*an?\s*existing|along\s+said\s+center\s+line/i.test(c.description || c.label || c.bearing || '');

    if (c.type?.toLowerCase() === 'curve' || c.Type?.toLowerCase() === 'curve') {
      const curvePts = getCurvePoints(p1, p2, c, 20);
      for (let j = 1; j < curvePts.length; j++) {
        dense.push(curvePts[j]);
      }
    } else if (isCreek) {
      const creekPts = getWavyCreekPoints(p1, p2, 4, 3.5, 30);
      for (let j = 1; j < creekPts.length; j++) {
        dense.push(creekPts[j]);
      }
    } else {
      dense.push(p2);
    }
  }
  return dense;
}

function parseDmsToDecimal(dms) {
  if (dms == null) return 0;
  const clean = dms.toString().trim();
  const match = clean.match(/^(-?\d+(?:\.\d+)?)\s*[°º*^d]?$/)
    || clean.match(/^(-?\d+)\s*[°º*^d]?\s*(\d+)\s*['’‘`]?\s*(\d+(?:\.\d+)?)\s*["”“']{0,2}$/)
    || clean.match(/^(-?\d+)\s*[°º*^d]?\s*(\d+(?:\.\d+)?)\s*['’‘`]?$/);

  if (match) {
    const deg = parseFloat(match[1]);
    const min = match[2] ? parseFloat(match[2]) : 0;
    const sec = match[3] ? parseFloat(match[3]) : 0;

    // Check for mixed decimal/DMS scrivener error (e.g. 22°97'38.78" where min >= 60)
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
  const val = parseFloat(clean);
  if (!isNaN(val)) return val;
  return 0;
}

function parseBearingToDegrees(b) {
  return parseBearingToAzimuthDegrees(b);
}

function azimuthToBearingString(azDeg) {
  let ns, ew, brg;
  if (azDeg <= 90)       { ns = 'N'; ew = 'E'; brg = azDeg; }
  else if (azDeg <= 180) { ns = 'S'; ew = 'E'; brg = 180 - azDeg; }
  else if (azDeg <= 270) { ns = 'S'; ew = 'W'; brg = azDeg - 180; }
  else                   { ns = 'N'; ew = 'W'; brg = 360 - azDeg; }

  let totalSec = Math.round(brg * 3600 * 100) / 100;
  let d = Math.floor(totalSec / 3600);
  let remSec = totalSec - d * 3600;
  let mn = Math.floor(remSec / 60);
  let sec = remSec - mn * 60;

  const dd = String(d).padStart(2, '0');
  const mm = String(mn).padStart(2, '0');
  const ss = sec.toFixed(2).padStart(5, '0');
  return `${ns}${dd}°${mm}'${ss}"${ew}`;
}

function resolveCurvePropertiesClient(c, prevAzimuthDeg) {
  let r = c.radius != null && c.radius !== '' ? parseFloat(c.radius) : null;
  let l = c.arcLength != null && c.arcLength !== '' ? parseFloat(c.arcLength) : null;
  let dDeg = c.delta != null && c.delta !== '' ? parseDmsToDecimal(c.delta) : null;
  let chDist = c.chordDistance != null && c.chordDistance !== '' ? parseFloat(c.chordDistance) : null;
  let chBrg = c.chordBearing || c.bearing || null;

  if (isNaN(r)) r = null;
  if (isNaN(l)) l = null;
  if (isNaN(dDeg)) dDeg = null;
  if (isNaN(chDist)) chDist = null;

  let deltaRad = dDeg !== null ? dDeg * Math.PI / 180 : null;

  if (r !== null && l !== null && dDeg !== null) {
    const calculatedDeltaRad = l / r;
    const calculatedDeltaDeg = calculatedDeltaRad * 180.0 / Math.PI;
    if (Math.abs(dDeg - calculatedDeltaDeg) > 0.5) {
      dDeg = calculatedDeltaDeg;
      deltaRad = calculatedDeltaRad;
    }
  }

  if (deltaRad === null) {
    if (r !== null && l !== null) {
      deltaRad = l / r;
    } else if (r !== null && chDist !== null) {
      if (chDist <= 2 * r) {
        deltaRad = 2 * Math.asin(chDist / (2 * r));
      }
    } else if (l !== null && chDist !== null) {
      if (chDist < l) {
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

  if (deltaRad !== null && deltaRad > 0) {
    if (r === null) {
      if (l !== null) {
        r = l / deltaRad;
      } else if (chDist !== null) {
        const sinHalf = Math.sin(deltaRad / 2);
        if (sinHalf > 0) {
          r = chDist / (2 * sinHalf);
        }
      }
    }

    if (l === null && r !== null) {
      l = r * deltaRad;
    }

    if (chDist === null && r !== null) {
      chDist = 2 * r * Math.sin(deltaRad / 2);
    }

    dDeg = deltaRad * 180 / Math.PI;
  }

  if (chBrg === null && prevAzimuthDeg !== null && dDeg !== null) {
    const deflectionSign = (c.curveDirection || c.direction || '').toLowerCase() === 'left' ? -1 : 1;
    const synthAzDeg = (prevAzimuthDeg + deflectionSign * (dDeg / 2.0) + 360) % 360;
    chBrg = azimuthToBearingString(synthAzDeg);
  }

  return {
    radius: r,
    arcLength: l,
    delta: dDeg,
    chordDistance: chDist,
    chordBearing: chBrg
  };
}

export default function TraverseMap({
  stations,
  adjusted,
  courses,
  pob,
  hoveredCourseIndex: hoveredCourseIndexProp,
  setHoveredCourseIndex: setHoveredCourseIndexProp,
  selectedCourseIndex: selectedCourseIndexProp,
  setSelectedCourseIndex: setSelectedCourseIndexProp,
  activeTractIndex = 0,
  tracts = []
}) {
  const [canvasElement, setCanvasElement] = useState(null);
  const [hoveredCourseIndexLocal, setHoveredCourseIndexLocal] = useState(null);
  const [hoveredVertexIndexLocal, setHoveredVertexIndexLocal] = useState(null);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panAtDragStart = useRef({ x: 0, y: 0 });

  const activeHoveredIndex = hoveredCourseIndexProp !== undefined ? hoveredCourseIndexProp : hoveredCourseIndexLocal;
  const activeSelectedIndex = selectedCourseIndexProp !== undefined ? selectedCourseIndexProp : null;
  
  const getPts = () => {
    if (adjusted?.length) return adjusted;
    if (stations?.length) return stations.map(s => ({ northing: s.northing, easting: s.easting }));
    if (courses?.length) return computePointsFromCourses(courses, pob);
    return [];
  };

  const pts = getPts();

  const getAllPoints = () => {
    let all = [...pts];
    if (tracts && tracts.length > 0) {
      tracts.forEach(t => {
        const tPts = t.traverse?.adjustedStations || t.traverse?.stations || computePointsFromCourses(t.originalCourses || t.courses, t.pob);
        all.push(...tPts);
      });
    }
    return all;
  };

  const allPtsForBounds = getAllPoints();

  useEffect(() => {
    if (!canvasElement || !pts || pts.length < 2) return;
    const canvas = canvasElement;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // Compute bounds encompassing all tracts
    const ns = allPtsForBounds.map(p => p.northing), es = allPtsForBounds.map(p => p.easting);
    const minN = ns.length ? Math.min(...ns) : 5000;
    const maxN = ns.length ? Math.max(...ns) : 5000;
    const minE = es.length ? Math.min(...es) : 5000;
    const maxE = es.length ? Math.max(...es) : 5000;
    const rangeN = maxN - minN || 1, rangeE = maxE - minE || 1;

    const scaleX = (W - PAD * 2) / rangeE;
    const scaleY = (H - PAD * 2) / rangeN;
    const scale = Math.min(scaleX, scaleY);

    const tx = e => PAD + (e - minE) * scale + panOffset.x;
    const ty = n => H - PAD - (n - minN) * scale + panOffset.y;

    // Grid lines (Surveyor Draft grid) – shifted by pan offset
    ctx.save();
    ctx.translate(panOffset.x, panOffset.y);
    ctx.strokeStyle = 'rgba(31, 46, 77, 0.4)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const x = PAD + i * (W - PAD * 2) / 5;
      const y = PAD + i * (H - PAD * 2) / 5;
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    }

    // Draw INACTIVE tracts in faded background color
    if (tracts && tracts.length > 1) {
      tracts.forEach((t, tIdx) => {
        if (tIdx === activeTractIndex) return;
        const tPts = t.traverse?.adjustedStations || t.traverse?.stations || computePointsFromCourses(t.originalCourses || t.courses, t.pob);
        if (tPts.length < 2) return;

        ctx.beginPath();
        const tDense = getDensePoints(tPts, t.originalCourses || t.courses);
        ctx.moveTo(tx(tDense[0].easting), ty(tDense[0].northing));
        for (let k = 1; k < tDense.length; k++) {
          ctx.lineTo(tx(tDense[k].easting), ty(tDense[k].northing));
        }
        ctx.closePath();
        ctx.strokeStyle = 'rgba(61, 127, 255, 0.2)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = 'rgba(61, 127, 255, 0.02)';
        ctx.fill();
      });
    }

    // Draw active tract interior
    const densePts = getDensePoints(pts, courses);
    ctx.beginPath();
    ctx.moveTo(tx(densePts[0].easting), ty(densePts[0].northing));
    for (let i = 1; i < densePts.length; i++) ctx.lineTo(tx(densePts[i].easting), ty(densePts[i].northing));
    ctx.closePath();
    ctx.fillStyle = 'rgba(61,127,255,0.06)';
    ctx.fill();

      // Draw boundary lines course-by-course for individual highlighting
      for (let i = 0; i < courses.length; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1] || pts[0];
        const c = courses[i];
        if (!p1 || !p2 || !c) continue;

        const isCurve = c.type?.toLowerCase() === 'curve';
        const isCreek = (c.type || '').toLowerCase() === 'squiggle' || /stream|creek|river|meander|water|shoreline|center\s*line\s*of\s*an?\s*existing|along\s+said\s+center\s+line/i.test(c.description || c.label || c.bearing || '');
        const isHovered = (activeHoveredIndex === i);
        const isSelected = (activeSelectedIndex === i);

        ctx.beginPath();
        const segPts = isCurve ? getCurvePoints(p1, p2, c, 40) : (isCreek ? getWavyCreekPoints(p1, p2, 4, 3.5, 30) : [p1, p2]);
        ctx.moveTo(tx(segPts[0].easting), ty(segPts[0].northing));
        for (let k = 1; k < segPts.length; k++) {
          ctx.lineTo(tx(segPts[k].easting), ty(segPts[k].northing));
        }

        if (isSelected) {
          ctx.strokeStyle = '#ff4d6d';
          ctx.lineWidth = 4.5;
          ctx.shadowColor = 'rgba(255, 77, 109, 0.5)';
          ctx.shadowBlur = 8;
        } else if (isHovered) {
          ctx.strokeStyle = '#00d4a8';
          ctx.lineWidth = 3.5;
          ctx.shadowColor = 'rgba(0, 212, 168, 0.4)';
          ctx.shadowBlur = 6;
        } else {
          ctx.strokeStyle = isCurve ? '#ff9f43' : '#3d7fff';
          ctx.lineWidth = 2.5;
          ctx.shadowBlur = 0;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Feature 4: When a curve segment is hovered, draw chord + center-of-curvature
        if (isCurve && (isHovered || isSelected)) {
          // Chord line (thin dashed)
          ctx.save();
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = 'rgba(255,159,67,0.45)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(tx(p1.easting), ty(p1.northing));
          ctx.lineTo(tx(p2.easting), ty(p2.northing));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          // Center-of-curvature dot
          const center = getCurveCenter(p1, p2, c);
          if (center) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(tx(center.easting), ty(center.northing), 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,159,67,0.75)';
            ctx.strokeStyle = '#ff9f43';
            ctx.lineWidth = 1;
            ctx.fill();
            ctx.stroke();

            // Radius lines to endpoints
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = 'rgba(255,159,67,0.25)';
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            ctx.moveTo(tx(center.easting), ty(center.northing));
            ctx.lineTo(tx(p1.easting), ty(p1.northing));
            ctx.moveTo(tx(center.easting), ty(center.northing));
            ctx.lineTo(tx(p2.easting), ty(p2.northing));
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      }

    const leaderStyle = localStorage.getItem('boundaryiq_leader_style') || 'arc';
    const labelContentMode = localStorage.getItem('boundaryiq_label_content_mode') || 'auto';

    // Compute resolved non-overlapping positions for labels
    const resolvedPoints = pts.map(p => ({ x: tx(p.easting), y: ty(p.northing) }));
    const resolvedLabels = resolveLabels(ctx, resolvedPoints, courses, W, H, {
      stationFont: 'bold 10px Inter, sans-serif',
      segmentFont: 'bold 9px "JetBrains Mono", monospace',
      stationPadding: 3,
      segmentPaddingX: 4,
      segmentPaddingY: 2,
      vertexRadius: 4.5,
      showStations: pts.length <= 30,
      showSegments: true,
      showConceptualDetail: false,
      leaderStyle,
      labelContentMode
    });

    // Visual Error / Misclosure gap dashed red line
    const last = pts[pts.length - 1];
    const first = pts[0];
    const closeGap = Math.hypot(last.northing - first.northing, last.easting - first.easting);
    if (closeGap > 0.05) {
      const xLast = tx(last.easting), yLast = ty(last.northing);
      const xFirst = tx(first.easting), yFirst = ty(first.northing);

      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 1.5;
      ctx.moveTo(xLast, yLast);
      ctx.lineTo(xFirst, yFirst);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ff4d6d';
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`Misclosure: ${closeGap.toFixed(2)} ft`, Math.max(10, Math.min(xLast, xFirst) + 5), Math.max(10, Math.min(yLast, yFirst) - 5));
    }

    // Draw station nodes
    pts.forEach((p, i) => {
      const px = tx(p.easting), py = ty(p.northing);
      const isVertexHovered = (hoveredVertexIndexLocal === i);
      ctx.beginPath();
      ctx.arc(px, py, isVertexHovered ? 6.5 : (i === 0 ? 5.5 : 3.8), 0, Math.PI * 2);
      ctx.fillStyle = isVertexHovered ? '#ff4d6d' : (i === 0 ? '#00d4a8' : '#3d7fff');
      ctx.fill();
      ctx.strokeStyle = '#090e1a';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    });

    // Draw labels
    resolvedLabels.forEach(lbl => {
      if (lbl.type === 'station') {
        if (lbl.needsLeader) {
          const intersection = getLeaderIntersection(lbl.anchorX, lbl.anchorY, lbl.x, lbl.y, lbl.width, lbl.height);
          ctx.beginPath();
          ctx.moveTo(lbl.anchorX, lbl.anchorY);
          if (lbl.leaderStyle === 'arc') {
            const dx = intersection.x - lbl.anchorX;
            const dy = intersection.y - lbl.anchorY;
            const dist = Math.hypot(dx, dy) || 1e-9;
            const midX = (lbl.anchorX + intersection.x) / 2;
            const midY = (lbl.anchorY + intersection.y) / 2;
            const px = -dy / dist;
            const py = dx / dist;
            const controlX = midX + px * dist * 0.2;
            const controlY = midY + py * dist * 0.2;
            ctx.quadraticCurveTo(controlX, controlY, intersection.x, intersection.y);
          } else {
            ctx.lineTo(intersection.x, intersection.y);
          }
          ctx.strokeStyle = 'rgba(168, 196, 255, 0.6)';
          ctx.lineWidth = 0.8;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(lbl.anchorX, lbl.anchorY, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(168, 196, 255, 0.6)';
          ctx.fill();

          ctx.save();
          ctx.font = 'bold 10px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(9, 14, 26, 0.85)';
          ctx.strokeStyle = 'rgba(168, 196, 255, 0.4)';
          ctx.lineWidth = 0.8;
          const rx = lbl.x - lbl.width / 2;
          const ry = lbl.y - lbl.height / 2;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(rx, ry, lbl.width, lbl.height, 2);
          else ctx.rect(rx, ry, lbl.width, lbl.height);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = lbl.text === 'POB' ? '#00d4a8' : '#ffffff';
          ctx.fillText(lbl.text, lbl.x, lbl.y);
          ctx.restore();
        } else {
          ctx.save();
          ctx.font = 'bold 10px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.strokeStyle = 'rgba(9, 14, 26, 0.85)';
          ctx.lineWidth = 2.5;
          ctx.strokeText(lbl.text, lbl.x, lbl.y);
          ctx.fillStyle = lbl.text === 'POB' ? '#00d4a8' : '#ffffff';
          ctx.fillText(lbl.text, lbl.x, lbl.y);
          ctx.restore();
        }
      } else if (lbl.type === 'segment') {
        if (lbl.needsLeader) {
          const intersection = getLeaderIntersection(lbl.anchorX, lbl.anchorY, lbl.x, lbl.y, lbl.width, lbl.height);
          ctx.beginPath();
          ctx.moveTo(lbl.anchorX, lbl.anchorY);
          if (lbl.leaderStyle === 'arc') {
            const dx = intersection.x - lbl.anchorX;
            const dy = intersection.y - lbl.anchorY;
            const dist = Math.hypot(dx, dy) || 1e-9;
            const midX = (lbl.anchorX + intersection.x) / 2;
            const midY = (lbl.anchorY + intersection.y) / 2;
            const px = -dy / dist;
            const py = dx / dist;
            const controlX = midX + px * dist * 0.2;
            const controlY = midY + py * dist * 0.2;
            ctx.quadraticCurveTo(controlX, controlY, intersection.x, intersection.y);
          } else {
            ctx.lineTo(intersection.x, intersection.y);
          }
          ctx.strokeStyle = 'rgba(168, 196, 255, 0.6)';
          ctx.lineWidth = 0.8;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(lbl.anchorX, lbl.anchorY, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(168, 196, 255, 0.6)';
          ctx.fill();
        }

        ctx.save();
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(lbl.x, lbl.y);
        if (lbl.rotated) {
          ctx.rotate(lbl.angle);
        }

        ctx.fillStyle = 'rgba(9, 14, 26, 0.85)';
        ctx.strokeStyle = lbl.isCurve ? 'rgba(255, 159, 67, 0.7)' : 'rgba(168, 196, 255, 0.7)';
        ctx.lineWidth = 1;

        const rx = -lbl.width / 2;
        const ry = -lbl.height / 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(rx, ry, lbl.width, lbl.height, 3);
        else ctx.rect(rx, ry, lbl.width, lbl.height);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = lbl.isCurve ? '#ff9f43' : '#a8c4ff';
        ctx.fillText(lbl.text, 0, 0);
        ctx.restore();
      }
    });

    // North arrow graphic
    ctx.save();
    ctx.translate(W - 35, 55);
    ctx.fillStyle = '#3d7fff';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -18);
    ctx.beginPath(); 
    ctx.moveTo(0, -15); 
    ctx.lineTo(4.5, 0); 
    ctx.lineTo(0, -4); 
    ctx.lineTo(-4.5, 0); 
    ctx.closePath();
    ctx.fill();
    ctx.restore();

  }, [canvasElement, pts, courses, activeHoveredIndex, activeSelectedIndex, hoveredVertexIndexLocal, tracts, activeTractIndex]);

  const handleMouseDown = (e) => {
    setIsPanning(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    panAtDragStart.current = { ...panOffset };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleMouseMove = (e) => {
    if (!canvasElement || pts.length < 2) return;

    // ── Pan drag ──────────────────────────────────────────────────────────────
    if (isPanning) {
      const canvas = canvasElement;
      const rect = canvas.getBoundingClientRect();
      const scaleRatio = (canvas.width / rect.width) * 0.55;  // CSS px → canvas px, damped
      const dx = (e.clientX - dragStart.current.x) * scaleRatio;
      const dy = (e.clientY - dragStart.current.y) * scaleRatio;
      setPanOffset({ x: panAtDragStart.current.x + dx, y: panAtDragStart.current.y + dy });
      return;  // skip hit-testing while dragging
    }

    const canvas = canvasElement;
    const rect = canvas.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const mouseY = ((e.clientY - rect.top) / rect.height) * canvas.height;

    // Scale calculation matching draw function (including panOffset)
    const ns = allPtsForBounds.map(p => p.northing), es = allPtsForBounds.map(p => p.easting);
    const minN = ns.length ? Math.min(...ns) : 5000;
    const maxN = ns.length ? Math.max(...ns) : 5000;
    const minE = es.length ? Math.min(...es) : 5000;
    const maxE = es.length ? Math.max(...es) : 5000;
    const rangeN = maxN - minN || 1, rangeE = maxE - minE || 1;

    const scaleX = (canvas.width - PAD * 2) / rangeE;
    const scaleY = (canvas.height - PAD * 2) / rangeN;
    const scale = Math.min(scaleX, scaleY);

    const tx = e => PAD + (e - minE) * scale + panOffset.x;
    const ty = n => canvas.height - PAD - (n - minN) * scale + panOffset.y;

    // 1. Vertex hit-testing
    let closestVertex = null;
    let minVertexDist = 10; // pixels
    pts.forEach((p, idx) => {
      const px = tx(p.easting);
      const py = ty(p.northing);
      const dist = Math.hypot(mouseX - px, mouseY - py);
      if (dist < minVertexDist) {
        minVertexDist = dist;
        closestVertex = idx;
      }
    });

    // 2. Segment hit-testing
    let closestCourse = null;
    let minCourseDist = 12; // pixels
    for (let i = 0; i < courses.length; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1] || pts[0];
      const course = courses[i];
      if (!p1 || !p2 || !course) continue;
      const d = getDistanceToCourse(mouseX, mouseY, p1, p2, course, tx, ty);
      if (d < minCourseDist) {
        minCourseDist = d;
        closestCourse = i;
      }
    }

    if (closestVertex !== null) {
      setHoveredVertexIndexLocal(closestVertex);
      setHoveredCourseIndexLocal(null);
      if (setHoveredCourseIndexProp) setHoveredCourseIndexProp(null);
    } else if (closestCourse !== null) {
      setHoveredVertexIndexLocal(null);
      setHoveredCourseIndexLocal(closestCourse);
      if (setHoveredCourseIndexProp) setHoveredCourseIndexProp(closestCourse);
    } else {
      setHoveredVertexIndexLocal(null);
      setHoveredCourseIndexLocal(null);
      if (setHoveredCourseIndexProp) setHoveredCourseIndexProp(null);
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const handleMouseLeave = () => {
    setIsPanning(false);
    setHoveredVertexIndexLocal(null);
    setHoveredCourseIndexLocal(null);
    if (setHoveredCourseIndexProp) setHoveredCourseIndexProp(null);
  };

  const handleCanvasClick = () => {
    if (hoveredVertexIndexLocal !== null) {
      const selectIdx = hoveredVertexIndexLocal === pts.length - 1 ? hoveredVertexIndexLocal - 1 : hoveredVertexIndexLocal;
      const finalSelectIdx = Math.max(0, selectIdx);
      if (setSelectedCourseIndexProp) {
        setSelectedCourseIndexProp(finalSelectIdx);
      }
    } else if (hoveredCourseIndexLocal !== null) {
      if (setSelectedCourseIndexProp) {
        setSelectedCourseIndexProp(hoveredCourseIndexLocal);
      }
    } else {
      if (setSelectedCourseIndexProp) {
        setSelectedCourseIndexProp(null);
      }
    }
  };

  function getDistanceToCourse(mx, my, p1, p2, course, tx, ty) {
    const isCurve = (course.type || course.Type || '').toLowerCase() === 'curve';
    const isCreek = (course.type || course.Type || '').toLowerCase() === 'squiggle' || /stream|creek|river|meander|water|shoreline|center\s*line\s*of\s*an?\s*existing|along\s+said\s+center\s+line/i.test(course.description || course.label || course.bearing || '');
    if (isCurve || isCreek) {
      const segPts = isCurve ? getCurvePoints(p1, p2, course, 20) : getWavyCreekPoints(p1, p2, 4, 3.5, 30);
      let minDist = Infinity;
      for (let k = 0; k < segPts.length - 1; k++) {
        const dist = getDistanceToSegment(
          mx, my,
          tx(segPts[k].easting), ty(segPts[k].northing),
          tx(segPts[k + 1].easting), ty(segPts[k + 1].northing)
        );
        if (dist < minDist) minDist = dist;
      }
      return minDist;
    } else {
      return getDistanceToSegment(
        mx, my,
        tx(p1.easting), ty(p1.northing),
        tx(p2.easting), ty(p2.northing)
      );
    }
  }

  const getTablesData = () => {
    const linesList = [];
    const curvesList = [];
    if (!courses) return { lines: linesList, curves: curvesList };

    let lineIndex = 1;
    let curveIndex = 1;
    let prevAzimuthDeg = null;

    courses.forEach(c => {
      const isCurve = (c.type || '').toLowerCase() === 'curve';
      if (isCurve) {
        const resolvedCurve = resolveCurvePropertiesClient(c, prevAzimuthDeg);
        
        if (resolvedCurve.radius === null && resolvedCurve.arcLength === null && resolvedCurve.chordDistance === null) {
          return;
        }

        curvesList.push({
          tag: `C${curveIndex++}`,
          radius: resolvedCurve.radius != null ? `${resolvedCurve.radius.toFixed(2)}'` : '-',
          arcLength: resolvedCurve.arcLength != null ? `${resolvedCurve.arcLength.toFixed(2)}'` : '-',
          chordBearing: resolvedCurve.chordBearing || '-',
          chordDistance: resolvedCurve.chordDistance != null ? `${resolvedCurve.chordDistance.toFixed(2)}'` : '-',
          delta: resolvedCurve.delta != null ? `${resolvedCurve.delta.toFixed(4)}°` : '-'
        });

        if (resolvedCurve.delta !== null) {
          const deflectionSign = (c.curveDirection || c.direction || '').toLowerCase() === 'left' ? -1 : 1;
          if (prevAzimuthDeg !== null) {
            prevAzimuthDeg = (prevAzimuthDeg + deflectionSign * resolvedCurve.delta + 360) % 360;
          } else if (resolvedCurve.chordBearing) {
            const parsed = parseBearingToDegrees(resolvedCurve.chordBearing);
            if (parsed !== null) prevAzimuthDeg = parsed;
          }
        }
      } else {
        let dist = parseFloat(c.distance || 0);
        if (dist <= 0) return;

        const bearingStr = c.bearing || '';
        const parsed = parseBearingToDegrees(bearingStr);
        if (parsed !== null) {
          prevAzimuthDeg = parsed;
        }

        linesList.push({
          tag: `L${lineIndex++}`,
          bearing: c.bearing || '-',
          distance: c.distance != null && c.distance !== '' ? `${parseFloat(c.distance).toFixed(2)}'` : '-'
        });
      }
    });

    return { lines: linesList, curves: curvesList };
  };

  const { lines, curves } = getTablesData();

  const panCursor = isPanning ? 'grabbing' : (hoveredCourseIndexLocal !== null || hoveredVertexIndexLocal !== null) ? 'pointer' : 'grab';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="map-container" style={{ height: 340, position: 'relative' }}>
        <canvas
          ref={setCanvasElement}
          className="map-canvas"
          width={700}
          height={340}
          style={{ cursor: panCursor }}
          onPointerDown={handleMouseDown}
          onPointerMove={handleMouseMove}
          onPointerUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onClick={handleCanvasClick}
        />
        {(panOffset.x !== 0 || panOffset.y !== 0) && (
          <button
            onClick={() => setPanOffset({ x: 0, y: 0 })}
            title="Reset view"
            style={{
              position: 'absolute', top: 8, right: 8,
              background: 'rgba(9,14,26,0.82)', border: '1px solid rgba(168,196,255,0.25)',
              color: '#a8c4ff', borderRadius: 6, padding: '3px 9px',
              fontSize: '0.72rem', cursor: 'pointer', letterSpacing: '0.03em',
              backdropFilter: 'blur(6px)', transition: 'opacity 0.2s',
            }}
          >
            ⌖ Reset View
          </button>
        )}
        <div className="map-legend">
          <span style={{ color: 'var(--success)', fontWeight: 600 }}>● POB</span>
          {'  '}
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>● Station</span>
          {'  '}
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>- - Misclosure Error</span>
        </div>
      </div>

      {(lines.length > 0 || curves.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
          {lines.length > 0 && (
            <div className="card" style={{ padding: '1.25rem', border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.75rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                📐 Line Table
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '50px' }}>Tag</th>
                      <th>Bearing</th>
                      <th>Distance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, idx) => (
                      <tr key={idx}>
                        <td style={{ fontWeight: 'bold', color: 'var(--accent)' }}>{l.tag}</td>
                        <td>{l.bearing}</td>
                        <td>{l.distance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {curves.length > 0 && (
            <div className="card" style={{ padding: '1.25rem', border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.75rem', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                🍊 Curve Table
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '50px' }}>Tag</th>
                      <th>Radius</th>
                      <th>Length</th>
                      <th>Chord Brg</th>
                      <th>Chord Dist</th>
                    </tr>
                  </thead>
                  <tbody>
                    {curves.map((c, idx) => (
                      <tr key={idx}>
                        <td style={{ fontWeight: 'bold', color: 'var(--warning)' }}>{c.tag}</td>
                        <td>{c.radius}</td>
                        <td>{c.arcLength}</td>
                        <td>{c.chordBearing}</td>
                        <td>{c.chordDistance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
