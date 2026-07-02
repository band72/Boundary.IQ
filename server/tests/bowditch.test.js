import { describe, it, expect } from 'vitest';

// ── Inline Bowditch (Compass Rule) implementation ──────────────────────────────
// The Compass Rule distributes closure error proportionally to leg distance.
//
//   correction_i_N = (cumDist_i / totalPerimeter) * errorN
//   adjustedN_i    = rawN_i - correction_i_N
//
// errorN = endN - startN  (should be 0 for a closed traverse)

function bowditchAdjust(courses, stations) {
  const n = stations.length;
  if (n <= 1 || courses.length === 0) return stations;

  const start = stations[0];
  const end   = stations[n - 1];

  // Misclosure components
  const errorN = end.northing - start.northing;
  const errorE = end.easting  - start.easting;

  const totalLength = courses.reduce((sum, c) => sum + (c.distance || 0), 0);
  if (totalLength === 0) return stations;

  const adjusted = [{ ...start }];
  let cumDist = 0;

  for (let i = 0; i < courses.length; i++) {
    cumDist += courses[i].distance || 0;
    const corrN = (cumDist / totalLength) * errorN;
    const corrE = (cumDist / totalLength) * errorE;
    adjusted.push({
      northing: stations[i + 1].northing - corrN,
      easting:  stations[i + 1].easting  - corrE,
    });
  }

  return adjusted;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Bowditch (Compass Rule) Adjustment', () => {

  // ── Case 1: Misclose of 0.01 ft in easting ───────────────────────────────
  const COURSES_ERR = [
    { distance: 100 },
    { distance: 100 },
    { distance: 100 },
    { distance: 100 },
  ];
  const STATIONS_ERR = [
    { northing: 5000.00, easting: 5000.00 },  // POB
    { northing: 5100.00, easting: 5000.00 },
    { northing: 5100.00, easting: 5100.00 },
    { northing: 5000.00, easting: 5100.00 },
    { northing: 5000.00, easting: 5000.01 },  // 0.01 ft east misclosure
  ];

  it('Last adjusted station closes back to POB (northing)', async () => {
    const adj = bowditchAdjust(COURSES_ERR, STATIONS_ERR);
    expect(adj[adj.length - 1].northing).toBeCloseTo(adj[0].northing, 8);
  });

  it('Last adjusted station closes back to POB (easting)', async () => {
    const adj = bowditchAdjust(COURSES_ERR, STATIONS_ERR);
    expect(adj[adj.length - 1].easting).toBeCloseTo(adj[0].easting, 8);
  });

  // ── Case 2: Error distribution ────────────────────────────────────────────
  it('Correction applied to final station equals total misclosure error', async () => {
    const courses = [
      { distance: 200 },
      { distance: 100 },
      { distance: 200 },
      { distance: 100 },
    ];
    const stations = [
      { northing: 5000.00, easting: 5000.00 },
      { northing: 5200.00, easting: 5000.00 },
      { northing: 5200.00, easting: 5100.00 },
      { northing: 5000.00, easting: 5100.00 },
      { northing: 5000.02, easting: 4999.97 },  // deliberate misclosure
    ];

    const totalErrN = stations[4].northing - stations[0].northing; // +0.02
    const totalErrE = stations[4].easting  - stations[0].easting;  // -0.03

    const adj = bowditchAdjust(courses, stations);

    const finalCorrN = stations[4].northing - adj[4].northing;
    const finalCorrE = stations[4].easting  - adj[4].easting;

    expect(finalCorrN).toBeCloseTo(totalErrN, 8);
    expect(finalCorrE).toBeCloseTo(totalErrE, 8);
  });

  // ── Case 3: Perfect closure — no corrections applied ─────────────────────
  it('Zero misclosure: adjusted stations equal raw stations', async () => {
    const courses = [
      { distance: 100 },
      { distance: 100 },
      { distance: 100 },
      { distance: 100 },
    ];
    const stations = [
      { northing: 5000, easting: 5000 },
      { northing: 5100, easting: 5000 },
      { northing: 5100, easting: 5100 },
      { northing: 5000, easting: 5100 },
      { northing: 5000, easting: 5000 }, // perfect closure
    ];

    const adj = bowditchAdjust(courses, stations);

    adj.forEach((a, i) => {
      expect(a.northing).toBeCloseTo(stations[i].northing, 8);
      expect(a.easting).toBeCloseTo(stations[i].easting, 8);
    });
  });

  // ── Case 4: Edge — empty / single station ────────────────────────────────
  it('Returns input unchanged when stations array has 1 or fewer entries', async () => {
    const result = bowditchAdjust([], [{ northing: 5000, easting: 5000 }]);
    expect(result).toHaveLength(1);
    expect(result[0].northing).toBe(5000);
  });

});
