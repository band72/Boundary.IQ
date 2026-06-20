import fs from 'fs';

/**
 * Generate a GeoJSON FeatureCollection from traverse points and metadata.
 * Coordinates are local Projected Coordinate System (Easting, Northing).
 */
export function generateGeoJson(stations, adjusted, courses, meta = {}) {
  const pts = (adjusted && adjusted.length >= 2) ? adjusted : stations;
  if (!pts || pts.length < 2) {
    throw new Error('At least 2 stations are required to generate GeoJSON.');
  }

  const coordinates = pts.map(p => [p.easting, p.northing]);
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  if (start[0] !== end[0] || start[1] !== end[1]) {
    coordinates.push([start[0], start[1]]);
  }

  const feature = {
    type: 'Feature',
    properties: {
      parcelName: meta.parcel || 'Subject Parcel',
      county: meta.county || '',
      state: meta.state || '',
      areaAcres: meta.areaAcres || 0,
      perimeter: meta.perimeter || 0,
      units: meta.units || 'Feet',
      basisOfBearings: meta.basisOfBearings || 'Deed of Record'
    },
    geometry: {
      type: 'Polygon',
      coordinates: [coordinates]
    }
  };

  return JSON.stringify({
    type: 'FeatureCollection',
    features: [feature]
  }, null, 2);
}

/**
 * Generate a combined GeoJSON FeatureCollection for multiple parcels.
 */
export function generateCombinedGeoJson(parcels) {
  const features = parcels.map((parcel, idx) => {
    const pts = (parcel.adjustedStations && parcel.adjustedStations.length >= 2)
      ? parcel.adjustedStations
      : (parcel.stations || []);
    
    if (pts.length < 2) return null;

    const coordinates = pts.map(p => [p.easting, p.northing]);
    const start = coordinates[0];
    const end = coordinates[coordinates.length - 1];
    if (start[0] !== end[0] || start[1] !== end[1]) {
      coordinates.push([start[0], start[1]]);
    }

    return {
      type: 'Feature',
      properties: {
        parcelName: parcel.parcelName || parcel.fileName || `Parcel_${idx + 1}`,
        county: parcel.county || '',
        state: parcel.state || '',
        areaAcres: parcel.areaAcres || 0,
        perimeter: parcel.perimeter || 0,
        units: parcel.units || 'Feet',
        basisOfBearings: parcel.basisOfBearings || 'Deed of Record'
      },
      geometry: {
        type: 'Polygon',
        coordinates: [coordinates]
      }
    };
  }).filter(Boolean);

  return JSON.stringify({
    type: 'FeatureCollection',
    features
  }, null, 2);
}

/**
 * Generate a LandXML string from traverse points, courses, and metadata.
 */
export function generateLandXml(stations, adjusted, courses, meta = {}) {
  const pts = (adjusted && adjusted.length >= 2) ? adjusted : stations;
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
  xml += `  <Project name="${meta.parcel ? meta.parcel.replace(/[^a-zA-Z0-9_\-]/g, '_') : 'Subject_Parcel'}"/>\n`;
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
  const parcelName = meta.parcel ? meta.parcel.replace(/[^a-zA-Z0-9_\-]/g, '_') : 'Parcel_1';
  const area = meta.areaAcres ? meta.areaAcres * 43560.0 : 0;
  xml += `  <Parcels>\n`;
  xml += `    <Parcel name="${parcelName}" area="${area.toFixed(4)}" desc="Boundary.IQ Solved Parcel">\n`;
  xml += `      <CoordGeom>\n`;

  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];

    if ((c.type || '').toLowerCase() !== 'curve') {
      xml += `        <Line>\n`;
      xml += `          <Start>${p1.northing.toFixed(4)} ${p1.easting.toFixed(4)}</Start>\n`;
      xml += `          <End>${p2.northing.toFixed(4)} ${p2.easting.toFixed(4)}</End>\n`;
      xml += `        </Line>\n`;
    } else {
      const r = c.radius || 0;
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
          
          const curveLeft = (c.curveDirection || '').toLowerCase() === 'left';
          const sign = curveLeft ? 1 : -1;
          const centX = cx + sign * perpChordX * dd;
          const centY = cy + sign * perpChordY * dd;

          centerXml = `          <Center>${centY.toFixed(4)} ${centX.toFixed(4)}</Center>\n`;
          rot = curveLeft ? 'ccw' : 'cw';
        } catch {}
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

/**
 * Generate a combined LandXML string containing multiple parcels.
 */
export function generateCombinedLandXml(parcels) {
  if (!parcels || parcels.length === 0) {
    throw new Error('No parcels provided to combine.');
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toTimeString().slice(0, 8);
  const metaUnits = parcels[0]?.units || 'Feet';
  const unitName = metaUnits.toLowerCase() === 'meters' ? 'metric' : 'imperial';
  const linearUnit = unitName === 'metric' ? 'meter' : 'foot';
  const areaUnit = unitName === 'metric' ? 'squareMeter' : 'squareFoot';

  let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
  xml += `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" version="1.2" date="${dateStr}" time="${timeStr}">\n`;
  xml += `  <Project name="Combined_Parcels"/>\n`;
  xml += `  <Units>\n`;
  if (unitName === 'metric') {
    xml += `    <Metric areaUnit="${areaUnit}" linearUnit="${linearUnit}" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBar"/>\n`;
  } else {
    xml += `    <Imperial areaUnit="${areaUnit}" linearUnit="${linearUnit}" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inHG"/>\n`;
  }
  xml += `  </Units>\n`;

  // CgPoints (aggregate all points)
  xml += `  <CgPoints>\n`;
  let ptCount = 1;
  parcels.forEach((parcel, pIdx) => {
    const pts = (parcel.adjustedStations && parcel.adjustedStations.length >= 2)
      ? parcel.adjustedStations
      : (parcel.stations || []);
    
    pts.forEach((p, idx) => {
      xml += `    <CgPoint pntNo="${ptCount++}" desc="P${pIdx + 1}_${idx === 0 ? 'POB' : `PT_${idx + 1}`}">${p.northing.toFixed(4)} ${p.easting.toFixed(4)}</CgPoint>\n`;
    });
  });
  xml += `  </CgPoints>\n`;

  // Parcels
  xml += `  <Parcels>\n`;
  parcels.forEach((parcel, pIdx) => {
    const pts = (parcel.adjustedStations && parcel.adjustedStations.length >= 2)
      ? parcel.adjustedStations
      : (parcel.stations || []);
    
    if (pts.length < 2) return;

    const parcelName = parcel.parcelName ? parcel.parcelName.replace(/[^a-zA-Z0-9_\-]/g, '_') : (parcel.fileName ? parcel.fileName.replace(/[^a-zA-Z0-9_\-]/g, '_') : `Parcel_${pIdx + 1}`);
    const area = parcel.areaAcres ? parcel.areaAcres * 43560.0 : 0;
    xml += `    <Parcel name="${parcelName}" area="${area.toFixed(4)}" desc="Boundary.IQ Solved Parcel">\n`;
    xml += `      <CoordGeom>\n`;

    const courses = parcel.courses || [];
    for (let i = 0; i < courses.length; i++) {
      const c = courses[i];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];

      if ((c.type || '').toLowerCase() !== 'curve') {
        xml += `        <Line>\n`;
        xml += `          <Start>${p1.northing.toFixed(4)} ${p1.easting.toFixed(4)}</Start>\n`;
        xml += `          <End>${p2.northing.toFixed(4)} ${p2.easting.toFixed(4)}</End>\n`;
        xml += `        </Line>\n`;
      } else {
        const r = c.radius || 0;
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
            
            const curveLeft = (c.curveDirection || '').toLowerCase() === 'left';
            const sign = curveLeft ? 1 : -1;
            const centX = cx + sign * perpChordX * dd;
            const centY = cy + sign * perpChordY * dd;

            centerXml = `          <Center>${centY.toFixed(4)} ${centX.toFixed(4)}</Center>\n`;
            rot = curveLeft ? 'ccw' : 'cw';
          } catch {}
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
  });
  xml += `  </Parcels>\n`;
  xml += `</LandXML>\n`;

  return xml;
}
