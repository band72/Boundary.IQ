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

/**
 * Generate a LandXML string from traverse points, courses, and metadata.
 *
 * @param {Array<{northing:number,easting:number}>} stations
 * @param {Array<object>} courses
 * @param {object} meta
 * @returns {string} LandXML XML string
 */
export function toLandXml(stations, courses, meta = {}) {
  const pts = stations;
  if (!pts || pts.length < 2) {
    throw new Error('At least 2 stations are required to generate LandXML.');
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toTimeString().slice(0, 8);
  const unitName = (meta.units || 'Feet').toLowerCase() === 'meters' ? 'metric' : 'imperial';
  const linearUnit = unitName === 'metric' ? 'meter' : 'foot';
  const areaUnit = unitName === 'metric' ? 'squareMeter' : 'squareFoot';

  let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
  xml += `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" version="1.2" date="${dateStr}" time="${timeStr}">\n`;
  xml += `  <Project name="${meta.parcel ? meta.parcel.replace(/[^a-zA-Z0-9_-]/g, '_') : 'Subject_Parcel'}"/>\n`;
  xml += `  <Units>\n`;
  if (unitName === 'metric') {
    xml += `    <Metric areaUnit="${areaUnit}" linearUnit="${linearUnit}" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBar"/>\n`;
  } else {
    xml += `    <Imperial areaUnit="${areaUnit}" linearUnit="${linearUnit}" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inHG"/>\n`;
  }
  xml += `  </Units>\n`;

  // CgPoints
  xml += `  <CgPoints>\n`;
  pts.forEach((p, idx) => {
    xml += `    <CgPoint pntNo="${idx + 1}" desc="${idx === 0 ? 'POB' : `PT_${idx + 1}`}">${p.northing.toFixed(4)} ${p.easting.toFixed(4)}</CgPoint>\n`;
  });
  xml += `  </CgPoints>\n`;

  // Parcel
  const parcelName = meta.parcel ? meta.parcel.replace(/[^a-zA-Z0-9_-]/g, '_') : 'Parcel_1';
  const area = meta.areaAcres ? meta.areaAcres * 43560.0 : 0;
  xml += `  <Parcels>\n`;
  xml += `    <Parcel name="${parcelName}" area="${area.toFixed(4)}" desc="Boundary.IQ Solved Parcel">\n`;
  xml += `      <CoordGeom>\n`;

  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];

    if (!p1 || !p2) continue;

    if ((c.type || '').toLowerCase() !== 'curve') {
      xml += `        <Line>\n`;
      xml += `          <Start>${p1.northing.toFixed(4)} ${p1.easting.toFixed(4)}</Start>\n`;
      xml += `          <End>${p2.northing.toFixed(4)} ${p2.easting.toFixed(4)}</End>\n`;
      xml += `        </Line>\n`;
    } else {
      const r = parseFloat(c.radius) || 0;
      let centerXml = '';
      let rot = 'cw';
      if (r > 0.001) {
        try {
          const cx = (p1.easting + p2.easting) / 2;
          const cy = (p1.northing + p2.northing) / 2;
          const chord = Math.sqrt(Math.pow(p2.easting - p1.easting, 2) + Math.pow(p2.northing - p1.northing, 2));
          const halfChord = chord / 2;
          let dSq = r * r - halfChord * halfChord;
          if (dSq < 0) dSq = 0;
          const dd = Math.sqrt(dSq);
          const chordLen = chord > 1e-9 ? chord : 1e-9;
          const perpChordX = -(p2.northing - p1.northing) / chordLen;
          const perpChordY = (p2.easting - p1.easting) / chordLen;
          
          const curveLeft = (c.curveDirection || c.direction || '').toLowerCase() === 'left';
          const sign = curveLeft ? 1 : -1;
          const centX = cx + sign * perpChordX * dd;
          const centY = cy + sign * perpChordY * dd;

          centerXml = `          <Center>${centY.toFixed(4)} ${centX.toFixed(4)}</Center>\n`;
          rot = curveLeft ? 'ccw' : 'cw';
        } catch {
          // ignore center calculation error
        }
      }
      xml += `        <Curve rot="${rot}">\n`;
      xml += `          <Start>${p1.northing.toFixed(4)} ${p1.easting.toFixed(4)}</Start>\n`;
      if (centerXml) xml += centerXml;
      xml += `          <End>${p2.northing.toFixed(4)} ${p2.easting.toFixed(4)}</End>\n`;
      xml += `          <Radius>${r.toFixed(4)}</Radius>\n`;
      xml += `        </Curve>\n`;
    }
  }

  xml += `      </CoordGeom>\n`;
  xml += `    </Parcel>\n`;
  xml += `  </Parcels>\n`;
  xml += `</LandXML>\n`;

  return xml;
}

