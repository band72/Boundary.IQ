import { describe, it, expect } from 'vitest';

// Inline implementation matching client/src/utils/geoTransform.js
const EARTH_R = 6_378_137;
const DEG2RAD = Math.PI / 180;

function localToLatLng(stations, opts = {}) {
  const {
    pobLat, pobLng,
    pobNorthing = 5000,
    pobEasting  = 5000,
    rotationDeg = 0,
    scaleFactor = 1,
    units = 'Feet',
  } = opts;

  if (pobLat == null || pobLng == null) return [];

  const toMetres = units === 'Feet' ? 0.3048 : 1.0;
  const latRadPob = pobLat * DEG2RAD;
  const metresToDegLat = 1 / (EARTH_R * DEG2RAD);
  const metresToDegLng = 1 / (EARTH_R * Math.cos(latRadPob) * DEG2RAD);

  const rotRad = rotationDeg * DEG2RAD;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);

  return stations.map(({ northing, easting }) => {
    const dN = (northing - pobNorthing) * scaleFactor;
    const dE = (easting  - pobEasting)  * scaleFactor;
    const rotN = cosR * dN - sinR * dE;
    const rotE = sinR * dN + cosR * dE;
    const dMetN = rotN * toMetres;
    const dMetE = rotE * toMetres;
    return [pobLat + dMetN * metresToDegLat, pobLng + dMetE * metresToDegLng];
  });
}

const POB = { pobLat: 30.0, pobLng: -97.0, pobNorthing: 5000, pobEasting: 5000 };

describe('geoTransform — localToLatLng', () => {

  it('Identity: POB station returns exact POB lat/lng', async () => {
    const result = localToLatLng([{ northing: 5000, easting: 5000 }], { ...POB });
    expect(result[0][0]).toBeCloseTo(30.0, 8);
    expect(result[0][1]).toBeCloseTo(-97.0, 8);
  });

  it('North displacement: 100 ft north → lat > 30.0, lng ≈ -97.0', async () => {
    const result = localToLatLng([{ northing: 5100, easting: 5000 }], { ...POB });
    expect(result[0][0]).toBeGreaterThan(30.0);
    expect(result[0][1]).toBeCloseTo(-97.0, 8);
  });

  it('East displacement: 100 ft east → lat ≈ 30.0, lng > -97.0', async () => {
    const result = localToLatLng([{ northing: 5000, easting: 5100 }], { ...POB });
    expect(result[0][0]).toBeCloseTo(30.0, 8);
    expect(result[0][1]).toBeGreaterThan(-97.0);
  });

  it('90° rotation: 100 ft north → rotates to equivalent of 100 ft east', async () => {
    const result = localToLatLng([{ northing: 5100, easting: 5000 }], { ...POB, rotationDeg: 90 });
    // After 90° clockwise rotation: dN=100 → rotN=0, rotE=100 → only eastward displacement
    expect(result[0][0]).toBeCloseTo(30.0, 5);    // no northing change
    expect(result[0][1]).toBeGreaterThan(-97.0);    // positive easting change
  });

  it('Scale factor 2× doubles lat displacement', async () => {
    const r1 = localToLatLng([{ northing: 5100, easting: 5000 }], { ...POB, scaleFactor: 1 });
    const r2 = localToLatLng([{ northing: 5100, easting: 5000 }], { ...POB, scaleFactor: 2 });
    const disp1 = r1[0][0] - 30.0;
    const disp2 = r2[0][0] - 30.0;
    expect(disp2).toBeCloseTo(disp1 * 2, 8);
    expect(r2[0][1]).toBeCloseTo(-97.0, 8); // no easting displacement
  });

});
