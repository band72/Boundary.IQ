// ─── Legal Description Writer ───────────────────────────────────────────────
// Port of LegalDescriptionWriter.cs — generates formatted metes-and-bounds legal descriptions.

/**
 * Converts a computed traverse into a formatted metes-and-bounds legal description.
 * @param {object} req - WriteRequest
 * @returns {string}
 */
export function write(req) {
  const courses = req.courses;
  const units = req.units || 'feet';
  let county = req.county;
  if (!county || county === 'Unknown') county = 'Unknown County';
  let state = req.state;
  if (!state || state === 'Unknown') state = 'Unknown State';
  const parcel = req.parcelDescription || 'a parcel of land';
  const lines = [];
  const precision = (req.bearingSecondsDecimals != null && !isNaN(parseInt(req.bearingSecondsDecimals, 10))) ? parseInt(req.bearingSecondsDecimals, 10) : 0;

  // ── Header
  lines.push(`A parcel of land being ${parcel}, situated in ${county}, ${state}, more particularly described as follows:`);
  lines.push('');
  lines.push(`BEGINNING at a point, said point being the Point of Beginning (POB), having coordinates of Northing ${(req.pobNorthing || 0).toFixed(2)}, Easting ${(req.pobEasting || 0).toFixed(2)};`);
  lines.push('');

  // ── Courses
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    const isLast = i === courses.length - 1;
    const type = (c.type || 'Line').toLowerCase();

    let term = ';';
    if (isLast) {
      if (type === 'point of beginning' || type === 'point of terminus') {
        term = '.';
      } else {
        term = ' to the Point of Beginning.';
      }
    }

    const subPhrase = formatSubItemPhrase(c);
    let phrase = '';

    if (type === 'line') {
      const brg = formatBearing(c.bearing || '', precision);
      const dist = (c.distance || 0).toFixed(2);
      phrase = `THENCE ${brg}, a distance of ${dist} ${units}${subPhrase}`;
    } else if (type === 'squiggle' || type === 'meandering line') {
      const brg = formatBearing(c.bearing || '', precision);
      const dist = (c.distance != null && c.distance !== '' && !isNaN(c.distance) && parseFloat(c.distance) > 0) ? parseFloat(c.distance) : null;
      const desc = c.description ? ` (${c.description})` : '';
      if (brg && dist != null) {
        phrase = `THENCE along a meandering line ${brg}, a distance of ${dist.toFixed(2)} ${units}${desc}${subPhrase}`;
      } else if (dist != null) {
        phrase = `THENCE along a meandering line, a distance of ${dist.toFixed(2)} ${units}${desc}${subPhrase}`;
      } else {
        phrase = `THENCE along a meandering line${desc}${subPhrase}`;
      }
    } else if (type === 'curve') {
      const dir = c.curveDirection || c.Direction || c.direction || 'Right';
      const delta = formatDMS(c.delta || 0);
      const radius = (c.radius || 0).toFixed(2);
      const arc = (c.arcLength || 0).toFixed(2);
      const chord = (c.chordDistance || 0).toFixed(2);
      // chord bearing may be absent — use bearing field as fallback, or omit
      const rawChord = c.chordBearing || c.bearing || '';
      const chBrg = rawChord ? formatBearing(rawChord, precision) : null;
      if (chBrg) {
        phrase = `THENCE along a curve to the ${dir}, having a radius of ${radius} ${units}, a central angle of ${delta}, an arc length of ${arc} ${units}, a chord bearing of ${chBrg}, and a chord distance of ${chord} ${units}${subPhrase}`;
      } else {
        phrase = `THENCE along a curve to the ${dir}, having a radius of ${radius} ${units}, a central angle of ${delta}, and an arc length of ${arc} ${units}${subPhrase}`;
      }
    } else if (type === 'point of beginning') {
      const desc = c.description ? ` (${c.description})` : '';
      phrase = `THENCE to the Point of Beginning (POB)${desc}${subPhrase}`;
    } else if (type === 'point of reference') {
      const desc = c.description ? ` (${c.description})` : '';
      phrase = `THENCE to the Point of Reference (POR)${desc}${subPhrase}`;
    } else if (type === 'point') {
      const desc = c.description ? ` (${c.description})` : '';
      phrase = `THENCE to a point${desc}${subPhrase}`;

    } else if (type === 'point of terminus') {
      const desc = c.description ? ` (${c.description})` : '';
      phrase = `THENCE to the Point of Terminus (POT)${desc}${subPhrase}`;
    } else {
      phrase = `THENCE ${type}${subPhrase}`;
    }

    lines.push(`${phrase}${term}`);
    if (!isLast) lines.push('');
  }

  // ── Closure stats
  if (req.areaAcres != null || req.perimeter != null) {
    lines.push('');
    lines.push(`Said parcel containing ${(req.areaAcres || 0).toFixed(4)} acres, more or less, and having a perimeter of ${(req.perimeter || 0).toFixed(2)} ${units}.`);
  }

  // ── Basis of bearings
  lines.push('');
  const basis = req.basisOfBearings || 'the deed of record';
  lines.push(`Bearings are based on ${basis} and are ${req.bearingSystem || 'grid bearings'}.`);
  if (basis.toLowerCase().includes('magnetic')) {
    lines.push(`Note: References to Magnetic North should be avoided in boundary reports except where comparison is necessitated by a Deed Call (61G17-6.002(2)(g), F.A.C.).`);
  }

  // ── Professional standard disclaimer
  lines.push('');
  lines.push(`DISCLAIMER: In accordance with professional mapping standards (e.g., Chapter 61G17-6.006, F.A.C.), if a sketch or map is attached to this description, such sketch or map is NOT A SURVEY.`);

  return lines.join('\n').trimEnd();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatSubItemPhrase(c) {
  const conn = (c.subConnector || '').trim();
  const feat = (c.subFeature || '').trim();
  const dir = (c.subDirection || '').trim();

  if (!conn && !feat && !dir) return '';

  let connWord = '';
  const cl = conn.toLowerCase();
  if (cl.startsWith('to')) connWord = 'to the';
  else if (cl.startsWith('along')) connWord = 'along the';
  else if (cl.startsWith('inter')) connWord = 'to the intersection with the';
  else connWord = conn.toLowerCase();

  let dirWord = '';
  if (dir) {
    dirWord = dir + ' line';
  }

  const parts = [];
  if (connWord) parts.push(connWord);
  if (dirWord) parts.push(dirWord);
  if (feat) {
    if (dirWord) parts.push('of the');
    else parts.push('the');
    parts.push(feat);
  }

  return ' ' + parts.join(' ');
}

function formatBearing(raw, precision = 0) {
  if (!raw || raw.length < 3) return raw || '';
  raw = raw.trim();
  // Normalize Unicode/Latin degree symbol variants (º U+00BA, ˚ U+02DA, ° U+00B0)
  raw = raw.replace(/[\u00B0\u00BA\u02DA\u25E6]/g, '\u00B0');
  const firstChar = raw[0].toUpperCase();
  const lastChar = raw[raw.length - 1].toUpperCase();
  const ns = firstChar === 'N' ? 'North' : (firstChar === 'S' ? 'South' : null);
  const ew = lastChar === 'E' ? 'East' : (lastChar === 'W' ? 'West' : null);
  // If not in N/S/E/W quadrant format, return as-is
  if (!ns || !ew) return raw;
  let mid = raw.slice(1, -1).trim();

  // Try to parse degrees, minutes, seconds from mid
  const matches = mid.match(/^(\d+)\D+(\d+)\D+(\d+(?:\.\d+)?)/);
  if (matches) {
    const d = parseInt(matches[1], 10);
    const m = parseInt(matches[2], 10);
    const s = parseFloat(matches[3]);
    let sStr;
    if (precision === 0) {
      // Truncate (not round) so that 05.72" stays 05" — rounding would change
      // the bearing value from the original deed, which is unexpected to the user.
      sStr = `${Math.floor(s).toString().padStart(2, '0')}"`;
    } else {
      sStr = `${s.toFixed(precision).padStart(3 + precision, '0')}"`;
    }
    mid = `${d}\u00B0${String(m).padStart(2, '0')}'${sStr}`;
  } else {
    // Fallback normalization of dash separators
    if (mid.includes('-')) {
      const i1 = mid.indexOf('-');
      mid = mid.substring(0, i1) + '\u00B0' + mid.substring(i1 + 1);
      const i2 = mid.indexOf('-');
      if (i2 >= 0) mid = mid.substring(0, i2) + "'" + mid.substring(i2 + 1);
    }
  }

  const nsChar = firstChar === 'N' ? 'N' : (firstChar === 'S' ? 'S' : '');
  const ewChar = lastChar === 'E' ? 'E' : (lastChar === 'W' ? 'W' : '');
  return `${nsChar}${mid}${ewChar}`;
}

/**
 * Format decimal degrees as a surveyor DMS string.
 *
 * FIX #4: traverse.js writes delta as `dDeg.toFixed(6)` — a plain decimal-degrees
 * value (e.g. 93.385278°).  The previous implementation wrongly treated this as
 * packed DMS (DDD.MMSS), converting 93.385278 → 93°38'52.78" instead of the
 * correct 93°23'06.99".
 *
 * This version always interprets `dms` as decimal degrees and converts properly.
 * Strings are parsed with parseFloat() so callers may pass either a number or
 * the string produced by toFixed(6).
 */
function formatDMS(dms) {
  const decDeg = Math.abs(parseFloat(dms) || 0);
  const d = Math.floor(decDeg);
  const minFrac = (decDeg - d) * 60;
  const m = Math.floor(minFrac);
  const s = (minFrac - m) * 60;
  return `${String(d).padStart(2, '0')}\u00b0${String(m).padStart(2, '0')}'${s.toFixed(2).padStart(5, '0')}"`;
}
