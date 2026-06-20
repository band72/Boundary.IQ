/**
 * exportEngine.js — GeoJSON (RFC 7946) and KML 2.2 export utilities
 *
 * Generates standards-compliant export files from traverse station arrays.
 * If georeferencing parameters are supplied, real-world WGS84 coordinates
 * are used; otherwise the local grid coordinates are written as-is.
 *
 * Usage:
 *   import { toGeoJson, toKml } from '../utils/exportEngine';
 *   const geojson = toGeoJson(stations, courses, meta, geoRef);
 *   const kml     = toKml(stations, courses, meta, geoRef);
 */

import { localToLatLng, isGeoRefValid } from './geoTransform.js';

// ── Coordinate helpers ────────────────────────────────────────────────────────

function buildCoordinates(stations, geoRef) {
  if (isGeoRefValid(geoRef)) {
    const latLngs = localToLatLng(stations, {
      pobLat:      parseFloat(geoRef.pobLat),
      pobLng:      parseFloat(geoRef.pobLng),
      pobNorthing: parseFloat(geoRef.pobNorthing ?? 5000),
      pobEasting:  parseFloat(geoRef.pobEasting  ?? 5000),
      rotationDeg: parseFloat(geoRef.rotationDeg ?? 0),
      scaleFactor: parseFloat(geoRef.scaleFactor ?? 1),
      units:       geoRef.units ?? 'Feet',
    });
    // GeoJSON uses [lng, lat] order
    const ring = latLngs.map(([lat, lng]) => [lng, lat]);
    // Close the ring
    if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push(ring[0]);
    }
    return ring;
  }
  // Fallback: write local grid as pseudo-coordinates (not real-world)
  const ring = stations.map(s => [s.easting, s.northing]);
  if (ring.length > 0) ring.push(ring[0]);
  return ring;
}

// ── GeoJSON ───────────────────────────────────────────────────────────────────

/**
 * Generate an RFC 7946 GeoJSON FeatureCollection string.
 *
 * @param {Array<{northing:number,easting:number}>} stations
 * @param {Array<object>} courses
 * @param {object} meta  { parcel, county, state, units, areaAcres, perimeter, precisionRatio }
 * @param {object|null} [geoRef]  Georeferencing parameters
 * @returns {string}  Pretty-printed GeoJSON
 */
export function toGeoJson(stations, courses, meta = {}, geoRef = null) {
  if (!stations || stations.length < 2) throw new Error('Need at least 2 stations');

  const coordinates = buildCoordinates(stations, geoRef);

  const feature = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [coordinates],
    },
    properties: {
      parcelName:      meta.parcel       ?? 'Subject Parcel',
      county:          meta.county       ?? null,
      state:           meta.state        ?? null,
      units:           meta.units        ?? 'Feet',
      areaAcres:       meta.areaAcres    ?? null,
      perimeterFt:     meta.perimeter    ?? null,
      precisionRatio:  meta.precisionRatio ?? null,
      courseCount:     courses?.length   ?? 0,
      georeferenced:   isGeoRefValid(geoRef),
      generatedBy:     'Boundary.IQ',
      generatedAt:     new Date().toISOString(),
    },
  };

  const fc = {
    type: 'FeatureCollection',
    features: [feature],
  };

  return JSON.stringify(fc, null, 2);
}

// ── KML ───────────────────────────────────────────────────────────────────────

function xmlEscape(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate a KML 2.2 document string.
 *
 * @param {Array<{northing:number,easting:number}>} stations
 * @param {Array<object>} courses
 * @param {object} meta
 * @param {object|null} [geoRef]
 * @returns {string}  KML XML string
 */
export function toKml(stations, courses, meta = {}, geoRef = null) {
  if (!stations || stations.length < 2) throw new Error('Need at least 2 stations');

  let coordinates;
  if (isGeoRefValid(geoRef)) {
    const latLngs = localToLatLng(stations, {
      pobLat:      parseFloat(geoRef.pobLat),
      pobLng:      parseFloat(geoRef.pobLng),
      pobNorthing: parseFloat(geoRef.pobNorthing ?? 5000),
      pobEasting:  parseFloat(geoRef.pobEasting  ?? 5000),
      rotationDeg: parseFloat(geoRef.rotationDeg ?? 0),
      scaleFactor: parseFloat(geoRef.scaleFactor ?? 1),
      units:       geoRef.units ?? 'Feet',
    });
    // KML uses lng,lat,alt
    const ring = latLngs.map(([lat, lng]) => `${lng.toFixed(8)},${lat.toFixed(8)},0`);
    // Close ring
    if (ring.length > 0) ring.push(ring[0]);
    coordinates = ring.join('\n          ');
  } else {
    // Local grid fallback
    const ring = stations.map(s => `${s.easting.toFixed(4)},${s.northing.toFixed(4)},0`);
    if (ring.length > 0) ring.push(ring[0]);
    coordinates = ring.join('\n          ');
  }

  const parcelName = xmlEscape(meta.parcel ?? 'Subject Parcel');
  const county     = xmlEscape(meta.county ?? '');
  const state      = xmlEscape(meta.state  ?? '');
  const areaAcres  = meta.areaAcres != null ? `${Number(meta.areaAcres).toFixed(4)} acres` : 'Unknown';
  const perimeterFt = meta.perimeter != null ? `${Number(meta.perimeter).toFixed(2)} ft` : 'Unknown';
  const georef     = isGeoRefValid(geoRef) ? 'Yes' : 'No (local grid coordinates)';

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${parcelName}</name>
    <description>Generated by Boundary.IQ on ${new Date().toISOString()}</description>
    <Style id="boundaryStyle">
      <LineStyle>
        <color>ff3d7fff</color>
        <width>2</width>
      </LineStyle>
      <PolyStyle>
        <color>193d7fff</color>
      </PolyStyle>
    </Style>
    <Placemark>
      <name>${parcelName}</name>
      <description><![CDATA[
        <b>County:</b> ${county || 'Unknown'}<br/>
        <b>State:</b> ${state || 'Unknown'}<br/>
        <b>Area:</b> ${areaAcres}<br/>
        <b>Perimeter:</b> ${perimeterFt}<br/>
        <b>Courses:</b> ${courses?.length ?? 0}<br/>
        <b>Georeferenced:</b> ${georef}
      ]]></description>
      <styleUrl>#boundaryStyle</styleUrl>
      <Polygon>
        <extrude>0</extrude>
        <altitudeMode>clampToGround</altitudeMode>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
          ${coordinates}
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;
}
