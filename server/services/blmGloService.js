// ─── BLM GLO Service ─────────────────────────────────────────────────────────
// Public BLM GeoCommunicator PLSS Cadastral API client.
// Fetches real section polygon geometry for PLSS and Government Lot descriptions.
// No API key required — all public REST endpoints.
//
// WGS84 → local survey feet via manual Transverse Mercator (no npm packages).
// Accuracy: ≤0.01 ft at 5 miles from section origin — adequate for survey drafting.
//
// Session-level cache: keyed on "trs" string (e.g. "7N-7E-8"). ClearCache() between runs if needed.

const BLM_BASE = 'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer';
const SECTION_LAYER  = 3;  // PLSS First Divisions (sections)
const TOWNSHIP_LAYER = 2;  // PLSS Townships

// 300ms minimum between requests (BLM has no documented rate limit, but be polite)
let _lastRequestMs = 0;
async function rateLimitedFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, 300 - (now - _lastRequestMs));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestMs = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`BLM API ${res.status}: ${url}`);
  return res.json();
}

// Session-level cache
const _sectionCache = new Map();
const _lotCache     = new Map();

export function clearCache() {
  _sectionCache.clear();
  _lotCache.clear();
}

// ── PLSS T/R/S key formatter ──────────────────────────────────────────────────
// Accepts: township="7N", range="7E", section=8
// Returns BLM query where clause string
function buildSectionWhere(township, range, section) {
  // Normalise: "7N" → township=7, direction=N
  const tMatch = String(township).match(/^(\d+)\s*([NS])$/i);
  const rMatch = String(range).match(/^(\d+)\s*([EW])$/i);
  if (!tMatch || !rMatch) throw new Error(`Invalid township/range: ${township} / ${range}`);
  const tNum = parseInt(tMatch[1]), tDir = tMatch[2].toUpperCase();
  const rNum = parseInt(rMatch[1]), rDir = rMatch[2].toUpperCase();
  const secNum = parseInt(section);
  // BLM field names: TWNSHPNO, TWNSHPDIR, RANGENO, RANGEDIR, FRSTDIVNO
  return `TWNSHPNO=${tNum} AND TWNSHPDIR='${tDir}' AND RANGENO=${rNum} AND RANGEDIR='${rDir}' AND FRSTDIVNO=${secNum}`;
}

/**
 * Fetch the polygon of a PLSS section from the BLM GeoCommunicator API.
 * Returns { vertices: [{northing, easting}], areaSqFt, areaAcres, source, vertexCount }
 * or null on failure.
 */
export async function getSectionBoundaryAsync(township, range, section) {
  const cacheKey = `${township}-${range}-${section}`.toUpperCase();
  if (_sectionCache.has(cacheKey)) return _sectionCache.get(cacheKey);

  try {
    const where = encodeURIComponent(buildSectionWhere(township, range, section));
    const url = `${BLM_BASE}/${SECTION_LAYER}/query?where=${where}&outFields=*&returnGeometry=true&geometryType=esriGeometryPolygon&outSR=4326&f=json`;
    console.log(`BLM GLO: Fetching section ${township} ${range} Sec ${section}…`);
    const data = await rateLimitedFetch(url);

    if (!data.features || data.features.length === 0) {
      console.warn(`BLM GLO: No features for ${cacheKey}`);
      _sectionCache.set(cacheKey, null);
      return null;
    }

    const rings = data.features[0].geometry?.rings;
    if (!rings || rings.length === 0) { _sectionCache.set(cacheKey, null); return null; }

    // Find the largest ring (outer boundary)
    const outerRing = rings.reduce((a, b) => a.length >= b.length ? a : b);

    // Use the first point as the local origin for TM reprojection
    const [originLon, originLat] = outerRing[0];
    const vertices = outerRing.map(([lon, lat]) => wgs84ToLocalFeet(lat, lon, originLat, originLon));

    const areaSqFt = shoelaceArea(vertices);
    const result = {
      vertices,
      areaSqFt,
      areaAcres: areaSqFt / 43560,
      source: 'BLM GeoCommunicator (Section)',
      vertexCount: vertices.length,
      originLat,
      originLon,
    };
    _sectionCache.set(cacheKey, result);
    return result;
  } catch (ex) {
    console.warn(`BLM GLO section lookup failed for ${cacheKey}: ${ex.message}`);
    _sectionCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Fetch a Government Lot polygon (irregular fractional section lots near water).
 * Returns same shape as getSectionBoundaryAsync, or null on failure.
 */
export async function getGovernmentLotAsync(township, range, section, lotNumber) {
  const cacheKey = `${township}-${range}-${section}-LOT${lotNumber}`.toUpperCase();
  if (_lotCache.has(cacheKey)) return _lotCache.get(cacheKey);

  try {
    // Government lots are in the Second Divisions layer (layer 4 in BLM PLSS service)
    const LOT_LAYER = 4;
    const tMatch = String(township).match(/^(\d+)\s*([NS])$/i);
    const rMatch = String(range).match(/^(\d+)\s*([EW])$/i);
    if (!tMatch || !rMatch) throw new Error(`Invalid T/R: ${township} / ${range}`);
    const tNum = parseInt(tMatch[1]), tDir = tMatch[2].toUpperCase();
    const rNum = parseInt(rMatch[1]), rDir = rMatch[2].toUpperCase();
    const secNum = parseInt(section);
    const lotNum = parseInt(String(lotNumber));

    const where = encodeURIComponent(
      `TWNSHPNO=${tNum} AND TWNSHPDIR='${tDir}' AND RANGENO=${rNum} AND RANGEDIR='${rDir}' AND FRSTDIVNO=${secNum} AND SCNDDIVNO=${lotNum} AND SCNDDIVTYP='Lot'`
    );
    const url = `${BLM_BASE}/${LOT_LAYER}/query?where=${where}&outFields=*&returnGeometry=true&geometryType=esriGeometryPolygon&outSR=4326&f=json`;
    console.log(`BLM GLO: Fetching Gov Lot ${lotNumber} in ${township} ${range} Sec ${section}…`);
    const data = await rateLimitedFetch(url);

    if (!data.features || data.features.length === 0) {
      console.warn(`BLM GLO: No Gov Lot ${lotNumber} for ${cacheKey}`);
      _lotCache.set(cacheKey, null);
      return null;
    }

    const rings = data.features[0].geometry?.rings;
    if (!rings || rings.length === 0) { _lotCache.set(cacheKey, null); return null; }

    const outerRing = rings.reduce((a, b) => a.length >= b.length ? a : b);
    const [originLon, originLat] = outerRing[0];
    const vertices = outerRing.map(([lon, lat]) => wgs84ToLocalFeet(lat, lon, originLat, originLon));

    const areaSqFt = shoelaceArea(vertices);
    const result = {
      vertices,
      areaSqFt,
      areaAcres: areaSqFt / 43560,
      source: `BLM GeoCommunicator (Government Lot ${lotNumber})`,
      vertexCount: vertices.length,
      originLat,
      originLon,
    };
    _lotCache.set(cacheKey, result);
    return result;
  } catch (ex) {
    console.warn(`BLM GLO lot lookup failed for ${cacheKey}: ${ex.message}`);
    _lotCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Convert a BLM polygon result to an array of traversable DeedCall-like courses.
 * Each edge becomes a { type, bearing, distance } line course.
 */
export function polygonToDeedCourses(vertices) {
  if (!vertices || vertices.length < 2) return [];
  const courses = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const p1 = vertices[i];
    const p2 = vertices[i + 1];
    const dN = p2.northing - p1.northing;
    const dE = p2.easting  - p1.easting;
    const dist = Math.sqrt(dN * dN + dE * dE);
    if (dist < 0.01) continue;
    const bearing = vectorToBearing(dN, dE);
    courses.push({ type: 'Line', bearing, distance: Math.round(dist * 100) / 100, isUnknown: false });
  }
  return courses;
}

// ── Manual Transverse Mercator WGS84 → local survey feet ─────────────────────
// Ported from BlmGloService.WGS84ToLocalFeet (C# BoundaryQC skill).
// No npm packages — self-contained math.
// Accuracy: ≤0.01 ft at 5 miles from origin.
function wgs84ToLocalFeet(lat, lon, originLat, originLon) {
  const FT_PER_METER = 3.280839895013123;
  const a  = 6378137.0;        // WGS84 semi-major axis (m)
  const e2 = 0.00669437999014; // WGS84 eccentricity squared
  const latR    = lat    * Math.PI / 180.0;
  const lonR    = lon    * Math.PI / 180.0;
  const origLatR = originLat * Math.PI / 180.0;
  const origLonR = originLon * Math.PI / 180.0;

  // Prime vertical radius
  function N(phi) { return a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2); }
  // Meridional arc
  function M(phi) {
    const c0 =  1.0 - e2 * (3/4) - e2**2 * (45/64)  - e2**3 * (175/512);
    const c2 =        e2 * (3/4) + e2**2 * (15/16)   + e2**3 * (525/512);
    const c4 =                    e2**2 * (15/64)   + e2**3 * (105/256);
    const c6 =                                        e2**3 * (35/512);
    return a * (c0 * phi - c2 * Math.sin(2*phi)/2 + c4 * Math.sin(4*phi)/4 - c6 * Math.sin(6*phi)/6);
  }

  const dLon  = lonR - origLonR;
  const Nv    = N(latR);
  const t     = Math.tan(latR);
  const eta2  = e2 / (1 - e2) * Math.cos(latR) ** 2;
  const dM    = M(latR) - M(origLatR);

  // Easting (x)
  const eastM = Nv * Math.cos(latR) * dLon
    + (Nv / 6)  * Math.cos(latR) ** 3 * (1 - t**2 + eta2) * dLon**3
    + (Nv / 120) * Math.cos(latR) ** 5 * (5 - 18*t**2 + t**4) * dLon**5;

  // Northing (y)
  const northM = dM
    + (Nv / 2) * Math.sin(latR) * Math.cos(latR) * dLon**2
    + (Nv / 24) * Math.sin(latR) * Math.cos(latR) ** 3 * (5 - t**2 + 9*eta2 + 4*eta2**2) * dLon**4;

  return {
    northing: northM * FT_PER_METER,
    easting:  eastM  * FT_PER_METER,
  };
}

// ── Shoelace area (sq ft) ─────────────────────────────────────────────────────
function shoelaceArea(pts) {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += pts[i].easting  * pts[j].northing;
    sum -= pts[j].easting  * pts[i].northing;
  }
  return Math.abs(sum) / 2.0;
}

// ── Vector → bearing string ───────────────────────────────────────────────────
function vectorToBearing(dN, dE) {
  const azRad = Math.atan2(dE, dN);
  let azDeg = azRad * 180 / Math.PI;
  if (azDeg < 0) azDeg += 360;
  const quad = azDeg <= 90 ? ['N', 'E', azDeg] :
               azDeg <= 180 ? ['S', 'E', 180 - azDeg] :
               azDeg <= 270 ? ['S', 'W', azDeg - 180] :
                              ['N', 'W', 360 - azDeg];
  const [ns, ew, ang] = quad;
  const d = Math.floor(ang);
  const mf = (ang - d) * 60;
  const m = Math.floor(mf);
  const s = Math.round((mf - m) * 60);
  return `${ns}${d}°${String(m).padStart(2,'0')}'${String(s).padStart(2,'0')}"${ew}`;
}
