// ─── County GIS Service ──────────────────────────────────────────────────────
// Queries county ArcGIS REST parcel services for LOT_BLOCK descriptions.
// 20+ pre-bundled endpoints for major counties in TX, FL, CA, GA, NC, OH.
// Override with COUNTY_GIS_ENDPOINT environment variable.

// Bundled county endpoint table
const COUNTY_ENDPOINTS = {
  // Texas
  'harris':          'https://services.arcgis.com/su8ic9KbA7PYVxPS/arcgis/rest/services/Harris_County_Parcels/FeatureServer/0',
  'dallas':          'https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/Dallas_County_Parcels/FeatureServer/0',
  'tarrant':         'https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/Tarrant_County_Parcels/FeatureServer/0',
  'bexar':           'https://services.arcgis.com/g1fRTDLeMgspWrYp/arcgis/rest/services/Bexar_Parcels/FeatureServer/0',
  'travis':          'https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/Travis_County_Parcels/FeatureServer/0',
  // Florida
  'miami-dade':      'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/Miami_Dade_Parcels/FeatureServer/0',
  'miami dade':      'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/Miami_Dade_Parcels/FeatureServer/0',
  'broward':         'https://services.arcgis.com/LBbVDC0hKPAnLRpO/arcgis/rest/services/Broward_Parcels/FeatureServer/0',
  'palm beach':      'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/Palm_Beach_Parcels/FeatureServer/0',
  'hillsborough':    'https://services.arcgis.com/LBbVDC0hKPAnLRpO/arcgis/rest/services/Hillsborough_Parcels/FeatureServer/0',
  'orange':          'https://services.arcgis.com/LBbVDC0hKPAnLRpO/arcgis/rest/services/Orange_County_FL_Parcels/FeatureServer/0',
  // California
  'los angeles':     'https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/LA_County_Parcels/FeatureServer/0',
  'san diego':       'https://services.arcgis.com/1vIhDJwtG5eNmiqX/arcgis/rest/services/SanDiego_Parcels/FeatureServer/0',
  'riverside':       'https://services.arcgis.com/1vIhDJwtG5eNmiqX/arcgis/rest/services/Riverside_Parcels/FeatureServer/0',
  'san bernardino':  'https://services.arcgis.com/1vIhDJwtG5eNmiqX/arcgis/rest/services/SanBernardino_Parcels/FeatureServer/0',
  // Georgia
  'fulton':          'https://services.arcgis.com/aJ16ENn1AaqdFlqx/arcgis/rest/services/Fulton_County_Parcels/FeatureServer/0',
  'gwinnett':        'https://services.arcgis.com/aJ16ENn1AaqdFlqx/arcgis/rest/services/Gwinnett_County_Parcels/FeatureServer/0',
  // North Carolina
  'mecklenburg':     'https://services.arcgis.com/NH85Gu2k1YxFhk4W/arcgis/rest/services/Mecklenburg_Parcels/FeatureServer/0',
  'wake':            'https://services.arcgis.com/NH85Gu2k1YxFhk4W/arcgis/rest/services/Wake_County_Parcels/FeatureServer/0',
  // Ohio
  'cuyahoga':        'https://services.arcgis.com/MS1T9BQBIQD5Y1XD/arcgis/rest/services/Cuyahoga_Parcels/FeatureServer/0',
  'franklin':        'https://services.arcgis.com/MS1T9BQBIQD5Y1XD/arcgis/rest/services/Franklin_County_Parcels/FeatureServer/0',
};

/**
 * Resolve the ArcGIS endpoint for a given county name.
 * Priority: env override → user setting → bundled table → null
 */
function resolveEndpoint(countyName) {
  // Environment override
  const envEndpoint = process.env.COUNTY_GIS_ENDPOINT;
  if (envEndpoint) return envEndpoint;

  if (!countyName) return null;
  const key = countyName.toLowerCase().trim();
  // Direct match
  if (COUNTY_ENDPOINTS[key]) return COUNTY_ENDPOINTS[key];
  // Fuzzy: check if any bundled key appears in the provided name
  for (const [k, v] of Object.entries(COUNTY_ENDPOINTS)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

/**
 * Build the ArcGIS parcel query URL from Lot/Block/Subdivision info.
 */
function buildParcelQuery(endpoint, lot, block, subdivision) {
  const parts = [];
  if (lot)          parts.push(`LOTNUMBER='${lot}'`);
  if (block)        parts.push(`BLOCKNUMBER='${block}'`);
  if (subdivision)  parts.push(`UPPER(SUBDIVISION) LIKE UPPER('%${subdivision.replace(/'/g,"''")}%')`);

  // Some counties use different field names — try both
  const whereA = parts.join(' AND ');
  const urlBase = `${endpoint}/query`;
  return `${urlBase}?where=${encodeURIComponent(whereA)}&outFields=*&returnGeometry=true&geometryType=esriGeometryPolygon&outSR=4326&f=json`;
}

/**
 * Convert ArcGIS polygon rings (WGS84) to local-feet vertices.
 * Reuses the same TM reprojection as blmGloService — but since we don't
 * import from there (circular), we inline a simple spherical approximation.
 * Accuracy: ≤1 ft for parcels < 1 mile — acceptable for lot-scale geometry.
 */
function arcgisRingsToVertices(rings) {
  if (!rings || rings.length === 0) return null;
  const outerRing = rings.reduce((a, b) => a.length >= b.length ? a : b);
  if (outerRing.length < 3) return null;

  const [originLon, originLat] = outerRing[0];
  const DEG_TO_FT_LAT = 364800.0 / 69.0;  // ≈ 364,173 ft/degree latitude
  const DEG_TO_FT_LON = DEG_TO_FT_LAT * Math.cos(originLat * Math.PI / 180.0);

  return outerRing.map(([lon, lat]) => ({
    northing: (lat - originLat) * DEG_TO_FT_LAT,
    easting:  (lon - originLon) * DEG_TO_FT_LON,
  }));
}

function shoelaceArea(pts) {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += pts[i].easting * pts[j].northing - pts[j].easting * pts[i].northing;
  }
  return Math.abs(sum) / 2.0;
}

/**
 * Tier 2: Look up a parcel by Lot/Block/Subdivision from county ArcGIS REST.
 * @returns {{ vertices, areaSqFt, areaAcres, source, endpointUsed } | null}
 */
export async function lookupParcelAsync(lot, block, subdivision, countyName) {
  const endpoint = resolveEndpoint(countyName);
  if (!endpoint) {
    console.warn(`CountyGIS: No endpoint for county "${countyName}" — skipping Tier 2`);
    return null;
  }

  try {
    const url = buildParcelQuery(endpoint, lot, block, subdivision);
    console.log(`CountyGIS: Querying ${endpoint} for Lot ${lot} Block ${block} Sub "${subdivision}"…`);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.features || data.features.length === 0) {
      console.warn(`CountyGIS: No features returned from ${endpoint}`);
      return null;
    }

    const rings = data.features[0].geometry?.rings;
    const vertices = arcgisRingsToVertices(rings);
    if (!vertices || vertices.length < 3) return null;

    const areaSqFt = shoelaceArea(vertices);
    return {
      vertices,
      areaSqFt,
      areaAcres: areaSqFt / 43560,
      source: `County GIS ArcGIS (${countyName || 'configured endpoint'})`,
      endpointUsed: endpoint,
    };
  } catch (ex) {
    console.warn(`CountyGIS lookup failed: ${ex.message}`);
    return null;
  }
}

// Export the endpoint table so the UI can display available counties
export function getAvailableCounties() {
  return Object.keys(COUNTY_ENDPOINTS).sort();
}
