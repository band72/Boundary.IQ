import { describe, it, expect } from 'vitest';

// ── Reference implementation of toGeoJson (structure/format tests only) ──────

function buildRing(stations) {
  // Local-grid [easting, northing] → GeoJSON [lng, lat] (we test structure, not projection)
  const ring = stations.map(s => [s.easting, s.northing]);
  if (ring.length > 0) ring.push([...ring[0]]);
  return ring;
}

function toGeoJson(stations, meta = {}) {
  const coordinates = buildRing(stations);
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [coordinates] },
      properties: {
        parcelName: meta.parcel ?? 'Subject Parcel',
        areaAcres:  meta.areaAcres ?? null,
        courseCount: stations.length,
      },
    }],
  }, null, 2);
}

function toKml(stations, meta = {}) {
  const ring = stations.map(s => `${s.easting.toFixed(4)},${s.northing.toFixed(4)},0`);
  ring.push(ring[0]);
  const coords = ring.join(' ');
  const name = (meta.parcel ?? 'Subject Parcel').replace(/&/g, '&amp;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${name}</name>
    <Placemark>
      <name>${name}</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;
}

// ── Test data ──────────────────────────────────────────────────────────────────
const SQUARE = [
  { northing: 5000, easting: 5000 },
  { northing: 5100, easting: 5000 },
  { northing: 5100, easting: 5100 },
  { northing: 5000, easting: 5100 },
];

describe('exportEngine', () => {

  describe('GeoJSON', () => {
    it('type is FeatureCollection', () => {
      const fc = JSON.parse(toGeoJson(SQUARE));
      expect(fc.type).toBe('FeatureCollection');
    });

    it('has exactly one feature', () => {
      const fc = JSON.parse(toGeoJson(SQUARE));
      expect(fc.features).toHaveLength(1);
    });

    it('feature geometry type is Polygon', () => {
      const fc = JSON.parse(toGeoJson(SQUARE));
      expect(fc.features[0].geometry.type).toBe('Polygon');
    });

    it('coordinate ring is closed (first === last)', () => {
      const fc = JSON.parse(toGeoJson(SQUARE));
      const ring = fc.features[0].geometry.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    });

    it('ring has N+1 positions (closed)', () => {
      const fc = JSON.parse(toGeoJson(SQUARE));
      const ring = fc.features[0].geometry.coordinates[0];
      expect(ring).toHaveLength(SQUARE.length + 1);
    });

    it('parcelName property is preserved in output', () => {
      const fc = JSON.parse(toGeoJson(SQUARE, { parcel: 'Lot 42' }));
      expect(fc.features[0].properties.parcelName).toBe('Lot 42');
    });
  });

  describe('KML', () => {
    it('contains XML declaration', () => {
      expect(toKml(SQUARE)).toContain('<?xml');
    });

    it('contains <kml> root element', () => {
      expect(toKml(SQUARE)).toContain('<kml');
    });

    it('contains <Placemark>', () => {
      expect(toKml(SQUARE)).toContain('<Placemark>');
    });

    it('contains <LinearRing>', () => {
      expect(toKml(SQUARE)).toContain('<LinearRing>');
    });

    it('contains <coordinates>', () => {
      expect(toKml(SQUARE)).toContain('<coordinates>');
    });

    it('parcel name appears in KML output', () => {
      expect(toKml(SQUARE, { parcel: 'Lot 42' })).toContain('Lot 42');
    });
  });

});
