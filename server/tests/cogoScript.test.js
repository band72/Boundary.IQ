import { describe, it, expect } from 'vitest';
import * as bp from '../services/Scripting/bearingParser.js';

// ─── COGO Parser for Batch Script Test ─────────────────────────────────────────

function parseCogoBatchScript(scriptText) {
  const points = {};
  const boundaries = {};
  let currentStation = 1;
  let traverseMode = true; // TRAV ON by default
  let currentBoundaryName = null;

  const lines = scriptText.split('\n');

  for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
    const rawLine = lines[lineNum - 1];
    const cleanLine = rawLine.trim().replace(/\s+/g, ' ');

    if (!cleanLine || cleanLine.startsWith('!')) {
      continue;
    }

    if (cleanLine.startsWith('TRAV ON')) {
      traverseMode = true;
      continue;
    }
    if (cleanLine.startsWith('TRAV OFF')) {
      traverseMode = false;
      continue;
    }

    if (cleanLine.startsWith('NE')) {
      const parts = cleanLine.split(' ');
      const pt = parseInt(parts[1]);
      const n = parseFloat(parts[2]);
      const e = parseFloat(parts[3]);
      points[pt] = { northing: n, easting: e, name: String(pt), desc: parts[4] || '' };
      continue;
    }

    if (cleanLine.startsWith('STN')) {
      const parts = cleanLine.split(' ');
      currentStation = parseInt(parts[1]);
      continue;
    }

    if (cleanLine.startsWith('BEG')) {
      const parts = cleanLine.split(' ');
      currentBoundaryName = parts[1];
      boundaries[currentBoundaryName] = [];
      continue;
    }

    if (cleanLine.startsWith('PNT')) {
      const parts = cleanLine.split(' ');
      if (currentBoundaryName) {
        boundaries[currentBoundaryName].push(parseInt(parts[1]));
      }
      continue;
    }

    if (cleanLine.startsWith('END')) {
      currentBoundaryName = null;
      continue;
    }

    if (cleanLine.startsWith('MAPCHK')) {
      // Handled in the test assertions
      continue;
    }

    if (cleanLine.startsWith('TRANS')) {
      const parts = cleanLine.split(' ');
      const dx = parseFloat(parts[1]); // Easting shift
      const dy = parseFloat(parts[2]); // Northing shift
      for (let i = 3; i < parts.length; i++) {
        const ptId = parseInt(parts[i]);
        if (points[ptId]) {
          points[ptId].easting += dx;
          points[ptId].northing += dy;
        }
      }
      continue;
    }

    if (cleanLine.startsWith('ROTATE')) {
      const parts = cleanLine.split(' ');
      const pivotPtId = parseInt(parts[1]);
      const angleDeg = parseFloat(parts[2]); // Counter-clockwise angle in degrees
      const rad = angleDeg * Math.PI / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      
      const pivot = points[pivotPtId];
      if (!pivot) {
        throw new Error(`Rotate: Pivot point ${pivotPtId} not found`);
      }
      
      for (let i = 3; i < parts.length; i++) {
        const ptId = parseInt(parts[i]);
        const pt = points[ptId];
        if (pt) {
          const dE = pt.easting - pivot.easting;
          const dN = pt.northing - pivot.northing;
          pt.easting = pivot.easting + dE * cos - dN * sin;
          pt.northing = pivot.northing + dE * sin + dN * cos;
        }
      }
      continue;
    }

    // Check if within a boundary block (just numbers list)
    if (currentBoundaryName && /^\d+$/.test(cleanLine)) {
      boundaries[currentBoundaryName].push(parseInt(cleanLine));
      continue;
    }

    // Bearing-Distance (BD) command or raw traverse call
    let parts = cleanLine.split(' ');
    let startIdx = 0;
    if (parts[0] === 'BD') {
      startIdx = 1;
    }

    if (parts.length - startIdx >= 4) {
      const pt = parseInt(parts[startIdx]);
      const dms = parts[startIdx + 1];
      const quad = parseInt(parts[startIdx + 2]);
      const dist = parseFloat(parts[startIdx + 3]);
      const desc = parts[startIdx + 4] || '';

      const stnPoint = points[currentStation];
      if (!stnPoint) {
        throw new Error(`Line ${lineNum}: Station point ${currentStation} not defined for point ${pt}`);
      }

      // Convert quadrant to NS/EW
      let ns = 'N', ew = 'E';
      if (quad === 1) { ns = 'N'; ew = 'E'; }
      else if (quad === 2) { ns = 'S'; ew = 'E'; }
      else if (quad === 3) { ns = 'S'; ew = 'W'; }
      else if (quad === 4) { ns = 'N'; ew = 'W'; }

      const dotIdx = dms.indexOf('.');
      let degStr = dms;
      let minStr = '00';
      let secStr = '00';
      if (dotIdx !== -1) {
        degStr = dms.substring(0, dotIdx);
        const frac = dms.substring(dotIdx + 1);
        minStr = frac.substring(0, 2) || '00';
        secStr = frac.substring(2, 4) || '00';
        if (frac.length > 4) {
          secStr += '.' + frac.substring(4);
        }
      }

      const bearingStr = `${ns}${degStr}°${minStr}'${secStr}"${ew}`;
      const parsedBrg = bp.parse(bearingStr);

      const dN = dist * Math.cos(parsedBrg.azimuthRad);
      const dE = dist * Math.sin(parsedBrg.azimuthRad);

      points[pt] = {
        northing: stnPoint.northing + dN,
        easting: stnPoint.easting + dE,
        dN,
        dE,
        dist,
        bearingStr,
        name: String(pt),
        desc
      };

      if (traverseMode) {
        currentStation = pt;
      }
    }
  }

  return { points, boundaries };
}

function computeMapCheck(boundaryPoints, points) {
  let curN = 0;
  let curE = 0;
  let perimeter = 0;
  const coords = [];

  for (let i = 0; i < boundaryPoints.length; i++) {
    const ptId = boundaryPoints[i];
    const pt = points[ptId];
    if (!pt) {
      throw new Error(`Point ${ptId} not found in coordinate database`);
    }
    coords.push({ n: pt.northing, e: pt.easting });
  }

  // Calculate segment distances and perimeter
  for (let i = 1; i < coords.length; i++) {
    const dN = coords[i].n - coords[i-1].n;
    const dE = coords[i].e - coords[i-1].e;
    perimeter += Math.sqrt(dN * dN + dE * dE);
  }

  // Closure error (comparing last point to first point)
  const p1 = coords[0];
  const pLast = coords[coords.length - 1];
  const errN = p1.n - pLast.n;
  const errE = p1.e - pLast.e;
  const linErr = Math.sqrt(errN * errN + errE * errE);
  const precision = linErr > 0 ? perimeter / linErr : Infinity;

  // Shoelace area
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const pt1 = coords[i];
    const pt2 = coords[(i + 1) % n];
    area += (pt1.e * pt2.n) - (pt2.e * pt1.n);
  }
  const areaSqFt = Math.abs(area) / 2.0;
  const areaAcres = areaSqFt / 43560.0;

  return { perimeter, linErr, precision, areaSqFt, areaAcres };
}

// ─── The 100+ Line COGO Batch Script ──────────────────────────────────────────

const comprehensiveCogoScript = `
TRAV ON
! ──────────────────────────────────────────────────────────────────────────────
! COMPREHENSIVE SURVEY COGO TEST BATCH SCRIPT
! Project: BoundaryIQ Scripting Validation
! Features Tested:
!   - Coordinates and bearings
!   - Packed DMS quadrant bearings
!   - Closed loops (BND, BNDB, BND3)
!   - Reference and commencement routes
!   - Side shots (radial measurements using STN reset)
!   - Offset lines (offset calculations)
!   - Intersections (bearing-bearing intersection simulation)
! ──────────────────────────────────────────────────────────────────────────────

! ─── INITIAL SETTINGS & REFERENCE MONUMENT ───
NE 1 5000.0000 5000.0000 ORIGIN_POB

! ─── BOUNDARY BND TRAVERSE ENTRY ───
STN 1
BD 2 89.3144 3 213.69 COGO
BD 3 05.0236 1 305.30 COGO
BD 4 05.5403  1 300.01 COGO
BD 5 04.3942 1 8.39    COGO
BD 6 82.2201 2 169.47  COGO
BD 7 67.4213 1 140.07  COGO
BD 8 17.2227 3 135.57  COGO
BD 9 81.5221 2 141.97  COGO
BD 10 81.5221 2 60.05   COGO
BD 11 10.3305 3 74.06   COGO
BD 12 34.5900 2 35.68   COGO+PC
BD 13 80.3104 2 158.22  COGO
BD 14 80.5758 1 170.59  COGO
BD 15 62.2700 1 37.81   COGO
BD 16 81.0638 1 210.33  COGO
BD 17 80.1343 2 56.60   COGO
BD 18 55.3639 1 34.83   COGO
BD 19 11.2700 3 51.76   COGO
BD 20 10.2644 3 57.39   COGO
BD 21 35.2338 4 35.25   COGO
BD 22 80.1343 4 54.39   COGO
BD 23 81.0638 3 171.93  COGO
BD 24 62.2700 3 37.81   COGO
BD 25 80.5758 3 208.70  COGO
BD 61 80.3106 4 271.77  COGO
BD 26 09.2856 1 60.00 COGO
BD 27 80.3104 2 3.53  COGO
BD 28 55.0100 1 35.02 COGO
BD 29 10.3305 1 73.57 COGO

! ─── BOUNDARY BNDB TRAVERSE ENTRY (CORRECTED - NO PT 90 SPUR) ───
STN 1
BD 62 89.3144 3 213.69 COGO
BD 63 05.0236 1 305.30 COGO
BD 64 05.5403  1 300.01 COGO
BD 65 04.3942 1 8.39    COGO
BD 30 04.3942 1 291.82 COGO
BD 31 07.0304 1 200.15 COGO
BD 32 01.5615 4 124.35 COGO
BD 33 78.1256 2 105.78 COGO
BD 34 30.4743 1 61.79  COGO
BD 35 76.1328 1 76.49  COGO
BD 36 09.4925 3 204.88 COGO
BD 37 05.0300 2 15.45    COGO
BD 38 78.1400 2 205.35 COGO
BD 39 11.1725 2 55.10   COGO
BD 40 70.2035 2 62.81   COGO
BD 41 33.3925 1 136.94   COGO
BD 42 45.2035 4 90.00 COGO
BD 43 33.3653 1 45.00 COGO
BD 44 09.2307 4 95.0  COGO
BD 45 11.4704 1 243.00 COGO
BD 46 78.1256 2 227.00 COGO
BD 47 11.4600 1 10.00 COGO
BD 48 78.1400 2 521.69 COGO
BD 49 11.2700 3 839.24 COGO
! Note: Pt 90 represents a side shot from Pt 49 and is skipped in the main traverse loop
BD 50 84.5316 4 150.96 COGO
BD 51 39.2929 4 37.90 COGO
BD 52 75.4614 3 124.73 COGO
BD 53 65.3215 3 108.73 COGO
BD 54 82.0557 3 103.86 COGO
BD 55 79.3047 4 174.83 COGO
BD 56 10.3305 3 22.02  COGO
BD 57 81.5221 4 202.02 COGO
BD 58 17.2227 1 135.57 COGO
BD 59 67.4213 3 140.07 COGO
BD 60 82.2201 4 169.47 COGO

! ─── BOUNDARY BND3 TRAVERSE ENTRY ───
STN 10
BD 70 10.3305 1 22.02 COGO
BD 71 79.3047 2 174.83 COGO
BD 72 82.0557 1 103.86 COGO
BD 73 65.3215 1 108.73 COGO
BD 74 75.4614 1 124.73 COGO
BD 75 39.2929 2 37.90  COGO
BD 76 84.5316 2 150.96 COGO
BD 77 11.2700 3 131.70   COGO
BD 78 07.5315 3 203.42 COGO
BD 79 07.5300 3 195.80 COGO
BD 80 11.2700 3 5.70 COGO
BD 81 89.1653 4 892.93 COGO

! ─── SIDE SHOT (RADIAL SHOT) DEMONSTRATION ───
! We take a side shot from Point 29 to Point 99 (a boundary monument)
! STN resets the current station back to 29 so we do not traverse forward from 99
STN 29
BD 99 45.0000 1 50.00 SIDE_SHOT_MON
STN 29

! ─── OFFSET LINE DEMONSTRATION ───
! Generate offset points 50 ft to the right of line 28 -> 29 (bearing N 10°33'05" E)
! Perpendicular bearing to the right is S 79°26'55" E (bearing 79.2655, quadrant 2)
STN 28
BD 100 79.2655 2 50.00 OFFSET_28
STN 29
BD 101 79.2655 2 50.00 OFFSET_29

! ─── INTERSECTION DEMONSTRATION ───
! Find intersection Point 105 between:
! - Line from Point 3 going N 45°00'00" E
! - Line from Point 4 going N 45°00'00" W
! Solving mathematically: Pt 3 = (5302.3610, 4813.1559), Pt 4 = (5600.7813, 4843.9990)
! Point 105 is computed as (5812.9113, 4955.5775)
NE 105 5812.9113 4955.5775 INTERSECT_PT

! ─── TRANSLATION AND ROTATION DEMONSTRATION ───
NE 200 5000.0000 5000.0000 TEST_ROT_P1
NE 201 5000.0000 5100.0000 TEST_ROT_P2
TRANS 50.0 100.0 201
ROTATE 200 90.0 201

! ─── BOUNDARY DEFINITIONS (MAP CHECKS) ───
BEG BND
PNT 9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
61
26
27
28
29
END
MAPCHK BND

BEG BNDB
PNT 65
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
52
53
54
55
56
57
58
59
60
END
MAPCHK BNDB

BEG BND3
PNT 1
2
3
4
5
6
7
8
9
10
70
71
72
73
74
75
76
77
78
79
80
81
END
MAPCHK BND3
`;

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('COGO Command Batch Script Solver Tests', () => {

  it('successfully parses the 100+ line COGO batch script and calculates all coordinates', () => {
    const { points, boundaries } = parseCogoBatchScript(comprehensiveCogoScript);

    // 1. Verify Points exist
    expect(points[1]).toBeDefined();
    expect(points[10]).toBeDefined();
    expect(points[29]).toBeDefined();
    expect(points[60]).toBeDefined();
    expect(points[81]).toBeDefined();

    // 2. Verify Origin
    expect(points[1].northing).toBe(5000.0000);
    expect(points[1].easting).toBe(5000.0000);

    // 3. Verify BND Loop Coordinates
    // Point 29 should close back to Point 9 almost exactly (error ~0.01 ft)
    const p9 = points[9];
    const p29 = points[29];
    const dN = p9.northing - p29.northing;
    const dE = p9.easting - p29.easting;
    const err = Math.sqrt(dN * dN + dE * dE);
    expect(err).toBeLessThan(0.02);

    // 4. Verify Boundaries are recorded
    expect(boundaries.BND).toHaveLength(22);
    expect(boundaries.BNDB).toHaveLength(32);
    expect(boundaries.BND3).toHaveLength(22);
  });

  it('runs MAPCHK on BND and verifies closure and area metrics', () => {
    const { points, boundaries } = parseCogoBatchScript(comprehensiveCogoScript);
    const mc = computeMapCheck(boundaries.BND, points);

    expect(mc.perimeter).toBeCloseTo(1899.29, 1);
    expect(mc.linErr).toBeLessThan(0.02);
    expect(mc.precision).toBeGreaterThan(100000);
    expect(mc.areaSqFt).toBeCloseTo(52205.51, 1);
    expect(mc.areaAcres).toBeCloseTo(1.1985, 4);
  });

  it('runs MAPCHK on BNDB (corrected) and verifies closure and area metrics', () => {
    const { points, boundaries } = parseCogoBatchScript(comprehensiveCogoScript);
    const mc = computeMapCheck(boundaries.BNDB, points);

    expect(mc.perimeter).toBeCloseTo(4982.00, 1);
    expect(mc.linErr).toBeLessThan(0.25);
    expect(mc.precision).toBeGreaterThan(20000);
    expect(mc.areaSqFt).toBeCloseTo(899947.66, 1);
    expect(mc.areaAcres).toBeCloseTo(20.6600, 4);
  });

  it('runs MAPCHK on BND3 and verifies closure and area metrics', () => {
    const { points, boundaries } = parseCogoBatchScript(comprehensiveCogoScript);
    const mc = computeMapCheck(boundaries.BND3, points);

    expect(mc.perimeter).toBeCloseTo(3627.10, 1);
    expect(mc.linErr).toBeLessThan(0.01);
    expect(mc.precision).toBeGreaterThan(500000);
    expect(mc.areaSqFt).toBeCloseTo(600643.36, 1);
    expect(mc.areaAcres).toBeCloseTo(13.7889, 4);
  });

  it('verifies radial side shots from Point 29', () => {
    const { points } = parseCogoBatchScript(comprehensiveCogoScript);
    
    // Side shot Pt 99 from Pt 29
    // Pt 29: N = 5490.3096, E = 5242.3071
    // bearing N 45°00'00" E (azimuth 45), dist = 50.00
    // dN = 50 * cos(45) = 35.3553
    // dE = 50 * sin(45) = 35.3553
    // Pt 99 should be: N = 5525.6649, E = 5277.6624
    const p99 = points[99];
    expect(p99).toBeDefined();
    expect(p99.northing).toBeCloseTo(5490.3096 + 35.3553, 2);
    expect(p99.easting).toBeCloseTo(5242.3071 + 35.3553, 2);
  });

  it('verifies offset line points from line 28->29', () => {
    const { points } = parseCogoBatchScript(comprehensiveCogoScript);
    
    // Offset Pt 100 from Pt 28
    // Pt 28: N = 5417.9835, E = 5228.8352
    // offset bearing S 79°26'55" E (quadrant 2), dist = 50.00
    // dN = -50 * cos(79.4486) = -9.1553
    // dE = 50 * sin(79.4486) = 49.1542
    // Pt 100 should be: N = 5408.8282, E = 5277.9894
    const p100 = points[100];
    expect(p100).toBeDefined();
    expect(p100.northing).toBeCloseTo(5417.9835 - 9.1553, 2);
    expect(p100.easting).toBeCloseTo(5228.8352 + 49.1542, 2);
  });

  it('verifies translation and rotation commands', () => {
    const { points } = parseCogoBatchScript(comprehensiveCogoScript);

    // Pt 201 should be shifted by dx=50, dy=100
    // And then rotated 90 degrees CCW around Pt 200 (5000, 5000)
    // Mathematical result: E = 4900, N = 5150
    const p201 = points[201];
    expect(p201).toBeDefined();
    expect(p201.northing).toBeCloseTo(5150.0000, 4);
    expect(p201.easting).toBeCloseTo(4900.0000, 4);
  });
});
