// ─── Plat Lookup Service ─────────────────────────────────────────────────────
// Three-tier orchestrator for LOT_BLOCK and PLSS descriptions.
// Tier 1: BLM GeoCommunicator (PLSS sections and Government Lots)
// Tier 2: County ArcGIS REST parcel service (LOT_BLOCK)
// Tier 3: Manual flag — caller must provide coordinates (UI dialog)
//
// Returns polygon vertices in local survey feet, ready for traverse computation.

import * as blm from './blmGloService.js';
import * as countyGis from './countyGisService.js';
import * as plssParser from './plssParser.js';

/**
 * Resolve a LOT_BLOCK description to polygon vertices.
 * Extraction must contain: lotNumber, blockNumber, subdivisionName, countyName.
 *
 * @param {object} extraction - AI extraction result
 * @param {string} countyName - County name for endpoint lookup
 * @returns {{ vertices, areaSqFt, areaAcres, source, tier, needsManual }}
 */
export async function resolveLotBlock(extraction, countyName) {
  const lot   = extraction.lotNumber   || extraction.LotNumber   || null;
  const block = extraction.blockNumber || extraction.BlockNumber || null;
  const sub   = extraction.subdivisionName || extraction.SubdivisionName
              || extraction.plat || extraction.Plat || null;

  console.log(`PlatLookup LOT_BLOCK: Lot=${lot} Block=${block} Sub="${sub}" County="${countyName}"`);

  // ── Tier 2: County GIS ArcGIS ─────────────────────────────────────────────
  if (lot || block || sub) {
    const gisResult = await countyGis.lookupParcelAsync(lot, block, sub, countyName);
    if (gisResult) {
      console.log(`PlatLookup Tier 2 SUCCESS: ${gisResult.source}`);
      return { ...gisResult, tier: 2, needsManual: false };
    }
  }

  // ── Tier 3: Manual entry needed ───────────────────────────────────────────
  console.warn(`PlatLookup: Tier 2 failed — returning Tier 3 (manual entry required)`);
  return {
    vertices: null,
    areaSqFt: null,
    areaAcres: null,
    source: 'Manual Entry Required',
    tier: 3,
    needsManual: true,
    lot,
    block,
    subdivision: sub,
  };
}

/**
 * Resolve a PLSS (SECTION_BREAKDOWN / QUALIFIED_PLSS) description to polygon vertices.
 * Accepts raw deed text or a pre-parsed PLSS object.
 *
 * @param {string|object} textOrParsed - Raw deed text OR pre-parsed { township, range, section, fractions, governmentLot }
 * @param {object} pob - { northing, easting } — used as offset origin for returned vertices
 * @returns {{ vertices, areaSqFt, areaAcres, source, tier, needsManual, courses }}
 */
export async function resolvePlss(textOrParsed, pob) {
  const parsed = (typeof textOrParsed === 'string')
    ? plssParser.parsePlss(textOrParsed)
    : textOrParsed;

  if (!parsed) {
    console.warn('PlatLookup PLSS: Could not parse T/R/S from text');
    return { vertices: null, areaSqFt: null, areaAcres: null, source: null, tier: 3, needsManual: true };
  }

  const { township, range, section, fractions, governmentLot } = parsed;
  console.log(`PlatLookup PLSS: T${township} R${range} Sec ${section} fractions=[${fractions.join(',')}] GL=${governmentLot}`);

  // ── Tier 1a: Government Lot ────────────────────────────────────────────────
  if (governmentLot != null) {
    const lotResult = await blm.getGovernmentLotAsync(township, range, section, governmentLot);
    if (lotResult) {
      const offsetVerts = applyPobOffset(lotResult.vertices, pob);
      const courses = blm.polygonToDeedCourses(offsetVerts);
      console.log(`PlatLookup Tier 1 SUCCESS (Gov Lot ${governmentLot}): ${lotResult.areaAcres.toFixed(4)} ac`);
      return { ...lotResult, vertices: offsetVerts, courses, tier: 1, needsManual: false };
    }
  }

  // ── Tier 1b: Section boundary ─────────────────────────────────────────────
  const sectionResult = await blm.getSectionBoundaryAsync(township, range, section);
  if (sectionResult) {
    // Apply aliquot fractions to clip the section polygon
    let vertices = sectionResult.vertices;
    let areaSqFt = sectionResult.areaSqFt;
    let areaAcres = sectionResult.areaAcres;
    let source = sectionResult.source;

    if (fractions.length > 0) {
      // Compute bounding box of the section polygon
      const minN = Math.min(...vertices.map(v => v.northing));
      const maxN = Math.max(...vertices.map(v => v.northing));
      const minE = Math.min(...vertices.map(v => v.easting));
      const maxE = Math.max(...vertices.map(v => v.easting));
      const clipped = plssParser.fractionsToBounds(fractions, { minN, maxN, minE, maxE });
      vertices  = clipped.vertices;
      areaSqFt  = clipped.areaSqFt;
      areaAcres = clipped.areaAcres;
      source    = `${source} (${fractions.join(' of ')})`;
    }

    const offsetVerts = applyPobOffset(vertices, pob);
    const courses = blm.polygonToDeedCourses(offsetVerts);
    console.log(`PlatLookup Tier 1 SUCCESS (Section): ${areaAcres.toFixed(4)} ac, ${courses.length} courses`);
    return { vertices: offsetVerts, areaSqFt, areaAcres, source, courses, tier: 1, needsManual: false };
  }

  // ── Tier 1c: Theoretical section grid (5280×5280 ft fallback) ────────────
  console.warn(`PlatLookup: BLM API failed — using theoretical section grid for T${township} R${range} Sec ${section}`);
  const SECTION_FT = 5280.0;
  const theoreticalBounds = { minN: 0, maxN: SECTION_FT, minE: 0, maxE: SECTION_FT };

  let vertices, areaSqFt, areaAcres;
  if (fractions.length > 0) {
    const clipped = plssParser.fractionsToBounds(fractions, theoreticalBounds);
    vertices  = clipped.vertices;
    areaSqFt  = clipped.areaSqFt;
    areaAcres = clipped.areaAcres;
  } else {
    vertices  = [
      { northing: 0,         easting: 0         },
      { northing: SECTION_FT, easting: 0        },
      { northing: SECTION_FT, easting: SECTION_FT },
      { northing: 0,         easting: SECTION_FT },
      { northing: 0,         easting: 0         },
    ];
    areaSqFt  = SECTION_FT * SECTION_FT;
    areaAcres = areaSqFt / 43560;
  }

  const offsetVerts = applyPobOffset(vertices, pob);
  const courses = blm.polygonToDeedCourses(offsetVerts);
  console.log(`PlatLookup Tier 1c FALLBACK (theoretical): ${areaAcres.toFixed(4)} ac`);
  return {
    vertices: offsetVerts,
    areaSqFt,
    areaAcres,
    source: `Theoretical Section Grid (BLM API unavailable) — T${township} R${range} Sec ${section}`,
    courses,
    tier: 1,
    needsManual: false,
    isFallback: true,
  };
}

/**
 * When manual coordinates are provided (Tier 3), compute traverse from them.
 * @param {{ northing, easting }[]} manualCoords
 * @returns {{ vertices, areaSqFt, areaAcres, courses, source, tier, needsManual }}
 */
export function resolveManualCoords(manualCoords) {
  if (!manualCoords || manualCoords.length < 3) {
    throw new Error('At least 3 coordinate pairs required for manual entry.');
  }
  // Close the polygon
  const verts = [...manualCoords];
  if (verts[0].northing !== verts[verts.length - 1].northing ||
      verts[0].easting  !== verts[verts.length - 1].easting) {
    verts.push({ ...verts[0] });
  }

  const areaSqFt = shoelaceArea(verts);
  const courses = [];
  for (let i = 0; i < verts.length - 1; i++) {
    const p1 = verts[i], p2 = verts[i + 1];
    const dN = p2.northing - p1.northing, dE = p2.easting - p1.easting;
    const dist = Math.sqrt(dN * dN + dE * dE);
    if (dist < 0.01) continue;
    const bearing = vectorToBearing(dN, dE);
    courses.push({ type: 'Line', bearing, distance: Math.round(dist * 100) / 100 });
  }

  return {
    vertices: verts,
    areaSqFt,
    areaAcres: areaSqFt / 43560,
    courses,
    source: 'Manual Coordinate Entry (Tier 3)',
    tier: 3,
    needsManual: false,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function applyPobOffset(vertices, pob) {
  if (!pob || !vertices) return vertices;
  const baseN = pob.northing || 5000;
  const baseE = pob.easting  || 5000;
  return vertices.map(v => ({
    northing: v.northing + baseN,
    easting:  v.easting  + baseE,
  }));
}

function shoelaceArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    sum += pts[i].easting * pts[j].northing - pts[j].easting * pts[i].northing;
  }
  return Math.abs(sum) / 2.0;
}

function vectorToBearing(dN, dE) {
  const az = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
  const [ns, ew, a] = az <= 90  ? ['N','E', az] :
                      az <= 180 ? ['S','E', 180-az] :
                      az <= 270 ? ['S','W', az-180] :
                                  ['N','W', 360-az];
  const d = Math.floor(a), m = Math.floor((a-d)*60), s = Math.round(((a-d)*60-m)*60);
  return `${ns}${d}°${String(m).padStart(2,'0')}'${String(s).padStart(2,'0')}"${ew}`;
}
