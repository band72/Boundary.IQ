// ─── Bearing Parser ─────────────────────────────────────────────────────────
// Port of BearingParser.cs — parses surveyor bearing strings into azimuth degrees.
// Supports: "N45°30'00"E", "N45-30-00E", "N 45 30 00 E", "N45.3000E"

const EXPANDED = /^\s*([NSns])\s*(\d{1,3})[°\-\s](\d{1,2})['\-\s](\d{1,2}(?:\.\d+)?)["\s]*([EWew])\s*$/;
const PACKED   = /^\s*([NSns])\s*(\d+\.\d+)\s*([EWew])\s*$/;

function getQuadrant(ns, ew) {
  const key = ns.toUpperCase() + ew.toUpperCase();
  const map = { NE: 1, SE: 2, SW: 3, NW: 4 };
  if (!map[key]) throw new Error(`Invalid quadrant: ${key}`);
  return map[key];
}

/** Convert packed DMS (DDD.MMSS) to decimal degrees. */
function packedDmsToDeg(dms) {
  const d = Math.floor(Math.abs(dms));
  const rem = (Math.abs(dms) - d) * 100;
  const m = Math.floor(rem);
  const s = (rem - m) * 100;
  return d + m / 60.0 + s / 3600.0;
}

/** Convert quadrant bearing to azimuth (0-360, clockwise from North). */
function quadrantToAzimuth(quadrant, bearingDeg) {
  switch (quadrant) {
    case 1: return bearingDeg;            // NE
    case 2: return 180 - bearingDeg;      // SE
    case 3: return 180 + bearingDeg;      // SW
    case 4: return 360 - bearingDeg;      // NW
    default: throw new Error(`Invalid quadrant: ${quadrant}`);
  }
}

/**
 * Parse a surveyor bearing string into azimuth + quadrant.
 * @param {string} bearing - e.g. "N45°30'00"E"
 * @returns {{ azimuthDeg: number, azimuthRad: number, quadrant: number, parseConfidence: 'HIGH'|'MEDIUM'|'LOW' }}
 */
function assessConfidence(deg, min, sec, format) {
  // Cardinal or near-cardinal direction (on the axis) — common OCR substitution artifact
  if (deg === 0 || deg === 90) return 'LOW';
  // Packed DMS format — less precise, no seconds field
  if (format === 'packed') return 'MEDIUM';
  // Missing or zero seconds in expanded DMS — possible truncation
  if (sec === 0 && min === 0) return 'LOW';
  return 'HIGH';
}
export function parse(bearing) {
  // Pre-normalize bearing string to handle non-standard characters from OCR or Word conversions
  let clean = bearing.trim();

  // Remove dot after N/S and before/after E/W (e.g., "N.45" -> "N45", "E." -> "E")
  clean = clean
    .replace(/^([NSns])\s*\./i, '$1')
    .replace(/\.\s*([EWew])$/i, '$1')
    .replace(/^([NSns])\s*/i, '$1')
    .replace(/\s*([EWew])$/i, '$1')
    .replace(/([EWew])\s*\.$/i, '$1');

  // Clean spaces around symbols and normalize symbols
  clean = clean
    .replace(/\s*[°º\*^d]\s*/g, '°')
    .replace(/\s*['’‘`]\s*/g, "'")
    .replace(/\s*(?:"|”|“|'')\s*/g, '"');

  // Try expanded DMS
  let m = EXPANDED.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const sec = parseFloat(m[4]);
    const ew = m[5].toUpperCase();
    const decDeg = deg + min / 60.0 + sec / 3600.0;
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = assessConfidence(deg, min, sec, 'expanded');
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence };
  }

  // Try packed DMS
  m = PACKED.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const packed = parseFloat(m[2]);
    const ew = m[3].toUpperCase();
    const decDeg = packedDmsToDeg(packed);
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = assessConfidence(decDeg, 0, 0, 'packed');
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence };
  }

  throw new Error(`Cannot parse bearing: '${bearing}'. Expected format: N45°30'00"E`);
}

/**
 * Convert azimuth degrees to display bearing string.
 * @param {number} azDeg - Azimuth in degrees (0=N, CW)
 * @returns {string} e.g. "N45°30'00.00"E"
 */
export function toDisplayString(azDeg) {
  let ns, ew, brg;
  if (azDeg <= 90)       { ns = 'N'; ew = 'E'; brg = azDeg; }
  else if (azDeg <= 180) { ns = 'S'; ew = 'E'; brg = 180 - azDeg; }
  else if (azDeg <= 270) { ns = 'S'; ew = 'W'; brg = azDeg - 180; }
  else                   { ns = 'N'; ew = 'W'; brg = 360 - azDeg; }

  const d = Math.floor(brg);
  const rem = (brg - d) * 60;
  const mn = Math.floor(rem);
  const sec = (rem - mn) * 60;

  const dd = String(d).padStart(2, '0');
  const mm = String(mn).padStart(2, '0');
  const ss = sec.toFixed(2).padStart(5, '0');
  return `${ns}${dd}°${mm}'${ss}"${ew}`;
}

/**
 * Convert ΔN/ΔE vector to surveyor bearing string.
 * @param {number} dN - Delta northing
 * @param {number} dE - Delta easting
 * @returns {string} e.g. "N45°30'00.00"E"
 */
export function vectorToBearing(dN, dE) {
  let azRad = Math.atan2(dE, dN);
  let azDeg = azRad * 180.0 / Math.PI;
  if (azDeg < 0) azDeg += 360.0;
  return toDisplayString(azDeg);
}

/**
 * Apply a deflection angle to an incoming azimuth to produce an outgoing azimuth.
 * Deflection angles are RELATIVE turns from the current direction of travel:
 *   LEFT  = counter-clockwise (subtract from azimuth)
 *   RIGHT = clockwise         (add to azimuth)
 *
 * Example: incoming N (0°), deflect LEFT 13°22'55" → outgoing N13°22'55"W (346.62°)
 *
 * @param {number} incomingAzDeg - Azimuth of the incoming course (0–360, CW from N)
 * @param {number} deflAngleDeg  - Deflection angle in decimal degrees (always positive)
 * @param {string} direction     - 'LEFT' or 'RIGHT' (case-insensitive)
 * @returns {number} Outgoing azimuth in degrees (0–360)
 */
export function applyDeflection(incomingAzDeg, deflAngleDeg, direction) {
  const dir = (direction || 'RIGHT').toString().toUpperCase().trim();
  let outAz;
  if (dir === 'LEFT' || dir === 'L') {
    outAz = incomingAzDeg - deflAngleDeg;
  } else {
    outAz = incomingAzDeg + deflAngleDeg;
  }
  return ((outAz % 360) + 360) % 360; // normalize to [0, 360)
}

/**
 * Parse a cardinal/ordinal direction word to azimuth degrees.
 * Used to establish the incoming bearing for the first course in a deflection-angle deed,
 * or for courses described as "NORTHERLY", "SOUTHWESTERLY", etc.
 *
 * @param {string} word - e.g. 'NORTHERLY', 'WESTERLY', 'NORTHWESTERLY', 'NORTH', 'SW'
 * @returns {number|null} Azimuth in degrees, or null if unrecognised
 */
export function parseCardinalAzimuth(word) {
  if (!word || /\d/.test(word)) return null;
  const CARDINAL_MAP = {
    // 8 primary directions
    'N': 0,   'NORTH': 0,     'NORTHERLY': 0,
    'NE': 45, 'NORTHEAST': 45, 'NORTHEASTERLY': 45,
    'E': 90,  'EAST': 90,     'EASTERLY': 90,
    'SE': 135,'SOUTHEAST': 135,'SOUTHEASTERLY': 135,
    'S': 180, 'SOUTH': 180,   'SOUTHERLY': 180,
    'SW': 225,'SOUTHWEST': 225,'SOUTHWESTERLY': 225,
    'W': 270, 'WEST': 270,    'WESTERLY': 270,
    'NW': 315,'NORTHWEST': 315,'NORTHWESTERLY': 315,
    // 16-point compass
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
