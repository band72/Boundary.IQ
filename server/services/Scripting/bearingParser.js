// ─── Bearing Parser ─────────────────────────────────────────────────────────
// Port of BearingParser.cs — parses surveyor bearing strings into azimuth degrees.
// Supports: "N45°30'00"E", "N45-30-00E", "N 45 30 00 E", "N45.3000E"

// Suffix is optional (e.g. S89°21'48")
const EXPANDED = /^\s*([NSns])\s*(\d{1,3})[°\-\s](\d{1,2})['\-\s](\d{1,2}(?:\.\d+)?)["'\s]*([EWew])?\s*$/;
const DEG_MIN  = /^\s*([NSns])\s*(\d{1,3})[°\-\s](\d{1,2}(?:\.\d+)?)['\s]*([EWew])?\s*$/;
const DEG_ONLY = /^\s*([NSns])\s*(\d{1,3}(?:\.\d+)?)[°\s]*([EWew])?\s*$/;
const DECIMAL_DEG = /^\s*([NSns])\s*(\d{1,3}\.\d+)\s*([EWew])\s*$/;
const PACKED   = /^\s*([NSns])\s*(\d+\.\d+)\s*([EWew])?\s*$/;

// Prefix is optional (e.g. 89°21'48"E)
const EXPANDED_NO_PREFIX = /^\s*([NSns])?\s*(\d{1,3})[°\-\s](\d{1,2})['\-\s](\d{1,2}(?:\.\d+)?)["'\s]*([EWew])\s*$/;
const DEG_MIN_NO_PREFIX  = /^\s*([NSns])?\s*(\d{1,3})[°\-\s](\d{1,2}(?:\.\d+)?)['\s]*([EWew])\s*$/;
const DEG_ONLY_NO_PREFIX = /^\s*([NSns])?\s*(\d{1,3}(?:\.\d+)?)[°\s]*([EWew])\s*$/;
const DECIMAL_DEG_NO_PREFIX = /^\s*([NSns])?\s*(\d{1,3}\.\d+)\s*([EWew])\s*$/;
const PACKED_NO_PREFIX   = /^\s*([NSns])?\s*(\d+\.\d+)\s*([EWew])\s*$/;

function getQuadrant(ns, ew) {
  const nsClean = (ns || 'N').toUpperCase();
  const ewClean = (ew || 'W').toUpperCase();
  const key = nsClean + ewClean;
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
  let clean = bearing.trim()
    // Fuzzy quadrant character substitutions (e.g. starting M/H -> N, trailing P/F -> E)
    .replace(/^[MHmh](?=\s*\d)/, 'N')
    .replace(/(?<=[\d°'"’\s])[PFpf]\s*\.?\s*$/, 'E')
    // Normalize double-decimal formats e.g. 12.34.56.78 -> 12°34'56.78", 12.34.56 -> 12°34'56"
    .replace(/(\d+)\.(\d{1,2})\.(\d{1,2})\.(\d+)/g, '$1°$2\'$3.$4"')
    .replace(/(\d+)\.(\d{1,2})\.(\d{1,2})/g, '$1°$2\'$3"')
    // Normalize OCR degree symbol misread as 8 or 9 (e.g. N.89903*21"E or N.89803*21"E -> N89°03'21"E)
    .replace(/(?:([NSns])\s*\.?\s*)?([0-8]\d)[89](\d{2})[*'\-\s]+(\d{2}(?:\.\d+)?)\s*["\u201D\u2033]?\s*([EWew])?/gi, (match, ns, deg, min, sec, ew) => {
      return `${ns || ''}${deg}°${min}'${sec}"${ew || ''}`;
    })
    // Normalize smashed bearings, e.g. S743907W -> S74°39'07"W
    .replace(/(?:([NSns])\s*)?(?<![\d\.])(\d{5,6}(?:\.\d+)?)(?:\s*([EWew]))?/gi, (match, ns, digits, ew) => {
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
    // Normalize Unicode prime marks (from Word typographic fonts)
    .replace(/\u2032/g, "'"  )    // U+2032 PRIME → minutes apostrophe
    .replace(/\u2033/g, '"'  )    // U+2033 DOUBLE PRIME → seconds quote
    .replace(/\u2034/g, '"'  )    // U+2034 TRIPLE PRIME → seconds fallback
    .replace(/\u02B9/g, "'"  )    // U+02B9 MODIFIER LETTER PRIME
    .replace(/\u02BA/g, '"'  )    // U+02BA MODIFIER LETTER DOUBLE PRIME
    // Windows Symbol / Wingdings PUA characters (Word legacy font encoding)
    .replace(/\uF0B0/g, '°'  )    // U+F0B0 Symbol-font DEGREE SIGN → °
    .replace(/\uF0B2/g, "'"  )    // U+F0B2 Symbol-font PRIME → '
    .replace(/\uFEFF/g, ''   )    // BOM
    // Common degree symbol lookalikes / OCR substitutions
    .replace(/\u00BA/g, '°'  )    // U+00BA MASCULINE ORDINAL INDICATOR º → °
    .replace(/\u02DA/g, '°'  )    // U+02DA RING ABOVE ˚ → °
    // Normalize Greek lookalike letters OCR sometimes produces in all-caps docs
    .replace(/\u039D/g, 'N'  )    // Ν (Greek Nu) → N
    .replace(/\u0391/g, 'A'  )    // Α (Greek Alpha) → A
    .replace(/\u039F/g, 'O'  )    // Ο (Greek Omicron) → O
    .replace(/\u0395/g, 'E'  )    // Ε (Greek Epsilon) → E
    .replace(/\u0397/g, 'H'  )    // Η (Greek Eta) → H
    .replace(/\u039A/g, 'K'  )    // Κ (Greek Kappa) → K
    .replace(/\u039C/g, 'M'  )    // Μ (Greek Mu) → M
    .replace(/\u03A1/g, 'R'  )    // Ρ (Greek Rho) → R
    .replace(/\u03A4/g, 'T'  )    // Τ (Greek Tau) → T
    .replace(/\u03A5/g, 'Y'  )    // Υ (Greek Upsilon) → Y
    .replace(/\u03A7/g, 'X'  )    // Χ (Greek Chi) → X
    .replace(/\u03A9/g, 'W'  )    // Ω (Greek Omega) → W (rare)
    // Word document smart-quote / special character cleanup
    .replace(/[\u2018\u2019\u201A\u02BC\u00B4]/g, "'") // smart-left/right single quotes → '
    .replace(/[\u201C\u201D\u201E]/g, '"')              // smart-left/right double quotes → "
    .replace(/\bNORTH\b/gi, 'N')
    .replace(/\bSOUTH\b/gi, 'S')
    .replace(/\bEAST\b/gi, 'E')
    .replace(/\bWEST\b/gi, 'W')
    .replace(/DEGREES?|DEGREAS|DEGRES?|DEG/gi, '°')
    .replace(/MINUTES|MIN/gi, "'")
    .replace(/SECONDS|SEC/gi, '"')
    .replace(/\*/g, ' ')
    // Fix OCR/LLM single-quote-for-decimal-point error in seconds (e.g. 12'18'50" -> 12'18.50")
    .replace(/(\d+)\s*'\s*(\d+)\s*'\s*(\d+)\s*"/g, "$1'$2.$3\"")
    // Fix OCR/LLM degree symbol used instead of minutes symbol (e.g. 0°18°50" -> 0°18'50")
    .replace(/(\d+)\s*°\s*(\d+)\s*°/g, "$1°$2'")
    // Fix OCR/LLM degree symbol used instead of seconds symbol (e.g. 0°18'50° -> 0°18'50")
    .replace(/(\d+)\s*'\s*(\d+)\s*°/g, '$1\'$2"');



  // Check if it's a cardinal/ordinal direction word directly
  const cardAz = parseCardinalAzimuth(clean);
  if (cardAz !== null) {
    let quadrant = 1;
    if (cardAz <= 90) quadrant = 1;      // NE
    else if (cardAz <= 180) quadrant = 2; // SE
    else if (cardAz <= 270) quadrant = 3; // SW
    else quadrant = 4;                    // NW
    return { azimuthDeg: cardAz, azimuthRad: cardAz * Math.PI / 180.0, quadrant, parseConfidence: 'HIGH' };
  }

  // Remove dot after N/S and before/after E/W (e.g., "N.45" -> "N45", "E." -> "E")
  clean = clean
    .replace(/^([NSns])\s*\./i, '$1')
    .replace(/\.\s*([EWew])$/i, '$1')
    .replace(/^([NSns])\s*/i, '$1')
    .replace(/\s*([EWew])$/i, '$1')
    .replace(/([EWew])\s*\.$/i, '$1');

  // Fix swapped quadrant letters (e.g. E81°54'58"N -> N81°54'58"E)
  if (/^[EWew].*[NSns]$/.test(clean)) {
    const start = clean[0].toUpperCase();
    const end = clean[clean.length - 1].toUpperCase();
    clean = end + clean.slice(1, clean.length - 1) + start;
  }

  // Fix starting quadrant letter substitution typos (e.g. E58°48'30"E -> N58°48'30"E, W58°48'30"W -> S58°48'30"W)
  if (/^[EWew]\d/.test(clean)) {
    const start = clean[0].toUpperCase();
    if (start === 'E') {
      clean = 'N' + clean.slice(1);
    } else if (start === 'W') {
      clean = 'S' + clean.slice(1);
    }
  }

  // Clean spaces around symbols and normalize symbols
  clean = clean
    .replace(/\s*[°º\*^d]\s*/g, '°')
    .replace(/\s*['’‘`]\s*/g, "'")
    .replace(/\s*(?:"|”|“|'')\s*/g, '"');

  // Replace letter O/o/Q/q with 0 when representing numbers
  clean = clean
    .replace(/(?<=\d)[OoQq]/g, '0')
    .replace(/[OoQq](?=\d)/g, '0')
    .replace(/[OoQq]\s*°/g, '0°')
    .replace(/[OoQq]\s*'/g, "0'")
    .replace(/[OoQq]\s*"/g, '0"');

  // Handle cases where the degree field has no digits and only symbols/letters (e.g. S_J°49'01"E -> S0°49'01"E, S(J° -> S0°)
  clean = clean.replace(/([NSns])\s*[^0-9°\s]*\s*°/gi, '$10°');

  // Handle OCR/scrivener errors where the degree symbol is misread as a letter (e.g. S00P56'28"E -> S00°56'28"E)
  clean = clean.replace(/([NSns]\s*\d{1,3})\s*([^0-9NSEWns\s])\s*(\d{1,2}\s*['])/gi, '$1°$3');

  // Handle OCR/scrivener errors where the degree symbol is misread as a digit (e.g. S00955'38"E -> S00°55'38"E)
  clean = clean.replace(/([NSns]\s*\d{2,3})([0-9])(\d{2}\s*['])/gi, '$1°$3');

  // Handle double degree symbol OCR errors or LLM translation duplicate degree digit errors (e.g. S72°912'02"W -> S72°12'02"W, S17°047'58"E -> S17°47'58"E)
  clean = clean.replace(/(\d+)\s*°\s*[0-9]\s*(\d{2}\s*['])/gi, '$1°$2');

  // Handle OCR error where minutes quote is misread as a seconds quote in a degree-minute bearing (e.g. S073°55"E -> S073°55'E)
  if (clean.includes('°') && clean.includes('"') && !clean.includes("'")) {
    const numericGroups = clean.match(/\d+(?:\.\d+)?/g);
    if (numericGroups && numericGroups.length === 2) {
      clean = clean.replace(/"/g, "'");
    }
  }

  // Handle smashed degree symbol OCR errors (e.g. S5719'54"W -> S57°19'54"W, S5719'W -> S57°19'00"W)
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

  // Try expanded DMS (prefix required)
  let m = EXPANDED.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const sec = parseFloat(m[4]);
    const ew = (m[5] || 'W').toUpperCase();
    // Detect impossible DMS values (OCR artifacts like S00°91'50"E where minutes=91)
    const impossible = min >= 60 || sec >= 60 || deg > 90;
    const decDeg = deg + min / 60.0 + sec / 3600.0;
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = impossible ? 'IMPOSSIBLE' : (m[5] ? assessConfidence(deg, min, sec, 'expanded') : 'LOW');
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence, impossibleDms: impossible ? { deg, min, sec } : undefined };
  }

  // Try expanded DMS (prefix optional, suffix required)
  m = EXPANDED_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const sec = parseFloat(m[4]);
    const ew = m[5].toUpperCase();
    const decDeg = deg + min / 60.0 + sec / 3600.0;
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = m[1] ? assessConfidence(deg, min, sec, 'expanded') : 'LOW';
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence };
  }

  // Try degree + minute only (no seconds, prefix required)
  m = DEG_MIN.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const sec = 0;
    const ew = (m[4] || 'W').toUpperCase();
    const decDeg = deg + min / 60.0;
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = m[4] ? assessConfidence(deg, min, sec, 'expanded_deg_min') : 'LOW';
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence };
  }

  // Try degree + minute only (no seconds, prefix optional, suffix required)
  m = DEG_MIN_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const deg = parseFloat(m[2]);
    const min = parseFloat(m[3]);
    const sec = 0;
    const ew = m[4].toUpperCase();
    const decDeg = deg + min / 60.0;
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = m[1] ? assessConfidence(deg, min, sec, 'expanded_deg_min') : 'LOW';
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence };
  }

  // Try degree only (prefix required)
  m = DEG_ONLY.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const deg = parseFloat(m[2]);
    const min = 0;
    const sec = 0;
    const ew = (m[3] || 'W').toUpperCase();
    const decDeg = deg;
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = m[3] ? assessConfidence(deg, min, sec, 'expanded_deg_only') : 'LOW';
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence };
  }

  // Try degree only (prefix optional, suffix required)
  m = DEG_ONLY_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const deg = parseFloat(m[2]);
    const min = 0;
    const sec = 0;
    const ew = m[3].toUpperCase();
    const decDeg = deg;
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = m[1] ? assessConfidence(deg, min, sec, 'expanded_deg_only') : 'LOW';
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence };
  }

  // Try decimal degrees (prefix required)
  m = DECIMAL_DEG.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const deg = parseFloat(m[2]);
    const ew = m[3].toUpperCase();
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, deg);
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence: 'HIGH' };
  }

  // Try decimal degrees (prefix optional, suffix required)
  m = DECIMAL_DEG_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const deg = parseFloat(m[2]);
    const ew = m[3].toUpperCase();
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, deg);
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence: 'HIGH' };
  }

  // Try packed DMS (prefix required)
  m = PACKED.exec(clean);
  if (m) {
    const ns = m[1].toUpperCase();
    const packed = parseFloat(m[2]);
    const ew = (m[3] || 'W').toUpperCase();
    const decDeg = packedDmsToDeg(packed);
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = m[3] ? assessConfidence(decDeg, 0, 0, 'packed') : 'LOW';
    return { azimuthDeg, azimuthRad: azimuthDeg * Math.PI / 180.0, quadrant, parseConfidence };
  }

  // Try packed DMS (prefix optional, suffix required)
  m = PACKED_NO_PREFIX.exec(clean);
  if (m) {
    const ns = (m[1] || 'N').toUpperCase();
    const packed = parseFloat(m[2]);
    const ew = m[3].toUpperCase();
    const decDeg = packedDmsToDeg(packed);
    const quadrant = getQuadrant(ns, ew);
    const azimuthDeg = quadrantToAzimuth(quadrant, decDeg);
    const parseConfidence = m[1] ? assessConfidence(decDeg, 0, 0, 'packed') : 'LOW';
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

/**
 * Check whether a course list contains any bearing that parsed as physically
 * impossible (minutes ≥ 60 or seconds ≥ 60 — classic OCR concatenation error).
 *
 * @param {Array<{bearing?: string}>} courses
 * @returns {{ hasImpossible: boolean, badCourses: number[] }}
 *   badCourses contains 1-based course indices of impossible bearings.
 */
export function hasImpossibleBearings(courses) {
  if (!Array.isArray(courses)) return { hasImpossible: false, badCourses: [] };
  const badCourses = [];
  courses.forEach((c, i) => {
    const brg = c?.bearing || c?.chordBearing;
    if (!brg) return;
    try {
      const parsed = parse(brg);
      if (parsed?.parseConfidence === 'IMPOSSIBLE') {
        badCourses.push(i + 1);
      }
    } catch {}
  });
  return { hasImpossible: badCourses.length > 0, badCourses };
}
