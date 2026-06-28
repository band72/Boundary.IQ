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
      else {
        throw new Error(`Line ${lineNum}: Invalid quadrant ${quad}`);
      }

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

  if (coords.length === 0) {
    return { perimeter: 0, linErr: 0, precision: Infinity, areaSqFt: 0, areaAcres: 0 };
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

// ─── Test Suite for COGO Scripting Line Work commands ──────────────────────────

describe('COGO Commands & Line Work - Detailed Verification Suite', () => {

  // 1-3. Basic Line and Comments Parsing
  it('1. ignores comment lines starting with !', () => {
    const script = `
      ! This is a comment
      NE 1 100.0 200.0 POB
      ! Another comment
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[1]).toBeDefined();
    expect(points[1].northing).toBe(100.0);
    expect(points[1].easting).toBe(200.0);
  });

  it('2. ignores completely empty or whitespace-only lines', () => {
    const script = `
      
      NE 1 100.0 200.0 POB
        
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[1]).toBeDefined();
  });

  it('3. supports inline and trailing spaces gracefully', () => {
    const script = `   NE   1   500.5   600.75   POINT_DESC   `;
    const { points } = parseCogoBatchScript(script);
    expect(points[1]).toBeDefined();
    expect(points[1].northing).toBe(500.5);
    expect(points[1].easting).toBe(600.75);
    expect(points[1].desc).toBe('POINT_DESC');
  });

  // 4-8. NE Point definition checks
  it('4. NE command parses positive coordinates correctly', () => {
    const { points } = parseCogoBatchScript('NE 10 123.456 789.012');
    expect(points[10].northing).toBe(123.456);
    expect(points[10].easting).toBe(789.012);
  });

  it('5. NE command parses negative northing and easting', () => {
    const { points } = parseCogoBatchScript('NE 2 -150.25 -300.5 POB_NEG');
    expect(points[2].northing).toBe(-150.25);
    expect(points[2].easting).toBe(-300.5);
  });

  it('6. NE command preserves description parameter', () => {
    const { points } = parseCogoBatchScript('NE 1 0.0 0.0 START_MONUMENT');
    expect(points[1].desc).toBe('START_MONUMENT');
  });

  it('7. NE command defaults description to empty string if missing', () => {
    const { points } = parseCogoBatchScript('NE 1 0.0 0.0');
    expect(points[1].desc).toBe('');
  });

  it('8. NE command handles zero coordinates', () => {
    const { points } = parseCogoBatchScript('NE 5 0 0');
    expect(points[5].northing).toBe(0);
    expect(points[5].easting).toBe(0);
  });

  // 9-11. STN Station command checks
  it('9. STN command updates active traverse station', () => {
    const script = `
      NE 1 1000 1000 POB
      NE 2 2000 2000 STN2
      STN 2
      BD 3 45.0000 1 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[3]).toBeDefined();
    // Since station is 2, point 3 should calculate relative to (2000, 2000)
    expect(points[3].northing).toBeGreaterThan(2000);
    expect(points[3].easting).toBeGreaterThan(2000);
  });

  it('10. STN command throws error if station is not defined when processing BD', () => {
    const script = `
      STN 99
      BD 1 45.0000 1 100.0
    `;
    expect(() => parseCogoBatchScript(script)).toThrow('Station point 99 not defined');
  });

  it('11. STN defaults to station 1 at start of script', () => {
    const script = `
      NE 1 100 100 POB
      BD 2 00.0000 1 50.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].northing).toBe(150);
  });

  // 12-14. TRAV ON / OFF checks
  it('12. TRAV ON advances station automatically on traverse steps', () => {
    const script = `
      NE 1 0 0
      TRAV ON
      BD 2 00.0000 1 50.0
      BD 3 90.0000 1 50.0
    `;
    const { points } = parseCogoBatchScript(script);
    // Point 3 should compute from Point 2 (0, 50) because station advanced to 2
    expect(points[3].northing).toBe(50);
    expect(points[3].easting).toBe(50);
  });

  it('13. TRAV OFF keeps the active station locked', () => {
    const script = `
      NE 1 0 0
      TRAV OFF
      BD 2 00.0000 1 50.0
      BD 3 90.0000 1 50.0
    `;
    const { points } = parseCogoBatchScript(script);
    // Point 3 should compute from Point 1 (0, 0) because station did not advance
    expect(points[3].northing).toBeCloseTo(0, 4);
    expect(points[3].easting).toBeCloseTo(50, 4);
  });

  it('14. TRAV ON can be re-enabled after TRAV OFF', () => {
    const script = `
      NE 1 0 0
      TRAV OFF
      BD 2 00.0000 1 50.0
      STN 2
      TRAV ON
      BD 3 90.0000 1 50.0
    `;
    const { points } = parseCogoBatchScript(script);
    // Point 3 should compute from Point 2 (0, 50) because TRAV ON was re-enabled
    expect(points[3].northing).toBeCloseTo(50, 4);
    expect(points[3].easting).toBeCloseTo(50, 4);
  });

  // 15-20. TRANS translation checks
  it('15. TRANS shifts specified points by dx, dy', () => {
    const script = `
      NE 1 10 10
      NE 2 20 20
      TRANS 5 10 1 2
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[1].easting).toBe(15);
    expect(points[1].northing).toBe(20);
    expect(points[2].easting).toBe(25);
    expect(points[2].northing).toBe(30);
  });

  it('16. TRANS handles negative dx and dy shifts', () => {
    const script = `
      NE 1 10 10
      TRANS -5 -10 1
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[1].easting).toBe(5);
    expect(points[1].northing).toBe(0);
  });

  it('17. TRANS leaves unlisted points untouched', () => {
    const script = `
      NE 1 10 10
      NE 2 20 20
      TRANS 10 10 1
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[1].northing).toBe(20);
    expect(points[2].northing).toBe(20);
  });

  it('18. TRANS handles non-existent points in parameters without failing', () => {
    const script = `
      NE 1 10 10
      TRANS 5 5 1 999
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[1].northing).toBe(15);
  });

  // 21-25. ROTATE rotation checks
  it('21. ROTATE rotates coordinates around pivot point', () => {
    // Pivot at (0,0), point at (10, 0), rotate 90 deg CCW
    // Expected: (0, 10)
    const script = `
      NE 1 0 0 pivot
      NE 2 0 10 target
      ROTATE 1 90.0 2
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].easting).toBeCloseTo(0, 4);
    expect(points[2].northing).toBeCloseTo(10, 4);
  });

  it('22. ROTATE handles 180 degree rotation', () => {
    // Pivot at (0,0), point at (10, 0), rotate 180 deg CCW
    // Expected: (-10, 0)
    const script = `
      NE 1 0 0 pivot
      NE 2 0 10 target
      ROTATE 1 180.0 2
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].easting).toBeCloseTo(-10, 4);
    expect(points[2].northing).toBeCloseTo(0, 4);
  });

  it('23. ROTATE throws error if pivot point is missing', () => {
    const script = `
      NE 2 10 10
      ROTATE 99 90.0 2
    `;
    expect(() => parseCogoBatchScript(script)).toThrow('Pivot point 99 not found');
  });

  it('24. ROTATE skips target points that do not exist', () => {
    const script = `
      NE 1 0 0
      ROTATE 1 90.0 999
    `;
    expect(() => parseCogoBatchScript(script)).not.toThrow();
  });

  it('25. ROTATE handles 0 degree rotation', () => {
    const script = `
      NE 1 0 0 pivot
      NE 2 10 10 target
      ROTATE 1 0 2
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].easting).toBe(10);
    expect(points[2].northing).toBe(10);
  });

  // 26-30. BD and Quadrant checks
  it('26. BD command parses Quadrant 1 (NE)', () => {
    // Quadrant 1: N 45° E. azimuth = 45. dist = 100.
    // dN = 100 * cos(45) ≈ 70.71, dE = 100 * sin(45) ≈ 70.71
    const script = `
      NE 1 0 0
      BD 2 45.0000 1 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].northing).toBeCloseTo(70.7107, 2);
    expect(points[2].easting).toBeCloseTo(70.7107, 2);
  });

  it('27. BD command parses Quadrant 2 (SE)', () => {
    // Quadrant 2: S 45° E. azimuth = 135. dist = 100.
    // dN = -70.71, dE = 70.71
    const script = `
      NE 1 0 0
      BD 2 45.0000 2 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].northing).toBeCloseTo(-70.7107, 2);
    expect(points[2].easting).toBeCloseTo(70.7107, 2);
  });

  it('28. BD command parses Quadrant 3 (SW)', () => {
    // Quadrant 3: S 45° W. azimuth = 225. dist = 100.
    // dN = -70.71, dE = -70.71
    const script = `
      NE 1 0 0
      BD 2 45.0000 3 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].northing).toBeCloseTo(-70.7107, 2);
    expect(points[2].easting).toBeCloseTo(-70.7107, 2);
  });

  it('29. BD command parses Quadrant 4 (NW)', () => {
    // Quadrant 4: N 45° W. azimuth = 315. dist = 100.
    // dN = 70.71, dE = -70.71
    const script = `
      NE 1 0 0
      BD 2 45.0000 4 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].northing).toBeCloseTo(70.7107, 2);
    expect(points[2].easting).toBeCloseTo(-70.7107, 2);
  });

  it('30. BD throws error for invalid quadrant numbers', () => {
    const script = `
      NE 1 0 0
      BD 2 45.0000 5 100.0
    `;
    expect(() => parseCogoBatchScript(script)).toThrow('Invalid quadrant 5');
  });

  // 31-35. Packed DMS bearings & coordinates format checks
  it('31. BD command parses plain DMS with no minutes or seconds (.0000)', () => {
    const script = `
      NE 1 0 0
      BD 2 90.0000 1 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].northing).toBeCloseTo(0, 4);
    expect(points[2].easting).toBeCloseTo(100.0, 4);
  });

  it('32. BD command parses fractional seconds (e.g. 45.303025)', () => {
    const script = `
      NE 1 0 0
      BD 2 45.303025 1 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].bearingStr).toBe('N45°30\'30.25"E');
  });

  it('33. BD command supports implicit quadrant bearings (plain text numbers)', () => {
    const script = `
      NE 1 0 0
      2 90.0000 1 100.0 IMPLICIT_LINE
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2]).toBeDefined();
    expect(points[2].easting).toBeCloseTo(100, 4);
    expect(points[2].desc).toBe('IMPLICIT_LINE');
  });

  it('34. BD command parses DMS value without dot as whole degrees', () => {
    const script = `
      NE 1 0 0
      BD 2 45 1 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].bearingStr).toBe('N45°00\'00"E');
  });

  it('35. BD parses short decimal DMS fraction correctly (e.g. .5 to minutes=50)', () => {
    const script = `
      NE 1 0 0
      BD 2 45.50 1 100.0
    `;
    const { points } = parseCogoBatchScript(script);
    expect(points[2].bearingStr).toBe('N45°50\'00"E');
  });

  // 36-40. Boundary Definitions (BEG, PNT, END)
  it('36. BEG/PNT/END structures a boundary array', () => {
    const script = `
      BEG TRACTA
      PNT 1
      PNT 2
      PNT 3
      END
    `;
    const { boundaries } = parseCogoBatchScript(script);
    expect(boundaries.TRACTA).toEqual([1, 2, 3]);
  });

  it('37. BEG/END supports inline numbers for point lists', () => {
    const script = `
      BEG TRACTB
      10
      11
      12
      END
    `;
    const { boundaries } = parseCogoBatchScript(script);
    expect(boundaries.TRACTB).toEqual([10, 11, 12]);
  });

  it('38. ignores comments inside boundary definition blocks', () => {
    const script = `
      BEG TRACTC
      1
      ! this is a comment inside boundary
      2
      END
    `;
    const { boundaries } = parseCogoBatchScript(script);
    expect(boundaries.TRACTC).toEqual([1, 2]);
  });

  it('39. supports multiple boundaries in the same script file', () => {
    const script = `
      BEG B1
      1
      2
      END
      BEG B2
      3
      4
      END
    `;
    const { boundaries } = parseCogoBatchScript(script);
    expect(boundaries.B1).toEqual([1, 2]);
    expect(boundaries.B2).toEqual([3, 4]);
  });

  it('40. ignores boundaries with no points', () => {
    const script = `
      BEG BEMPTY
      END
    `;
    const { boundaries } = parseCogoBatchScript(script);
    expect(boundaries.BEMPTY).toEqual([]);
  });

  // 41-45. MAPCHK and math checks
  it('41. computeMapCheck returns correct values for an exact square', () => {
    const points = {
      1: { northing: 0, easting: 0 },
      2: { northing: 100, easting: 0 },
      3: { northing: 100, easting: 100 },
      4: { northing: 0, easting: 100 }
    };
    const bPoints = [1, 2, 3, 4];
    const mc = computeMapCheck(bPoints, points);
    expect(mc.perimeter).toBeCloseTo(300, 2);
    expect(mc.linErr).toBeCloseTo(100, 2); // (0,100) to (0,0) is 100 ft error
    expect(mc.precision).toBeCloseTo(3, 2);
    expect(mc.areaSqFt).toBeCloseTo(10000, 2);
  });

  it('42. computeMapCheck returns Infinity precision for exact closure', () => {
    const points = {
      1: { northing: 0, easting: 0 },
      2: { northing: 100, easting: 0 },
      3: { northing: 100, easting: 100 },
      4: { northing: 0, easting: 100 },
      5: { northing: 0, easting: 0 }
    };
    const bPoints = [1, 2, 3, 4, 5];
    const mc = computeMapCheck(bPoints, points);
    expect(mc.linErr).toBe(0);
    expect(mc.precision).toBe(Infinity);
  });

  it('43. computeMapCheck throws error for missing point references', () => {
    const points = {
      1: { northing: 0, easting: 0 }
    };
    expect(() => computeMapCheck([1, 999], points)).toThrow('Point 999 not found in coordinate database');
  });

  it('44. computeMapCheck handles empty boundary arrays', () => {
    const mc = computeMapCheck([], {});
    expect(mc.perimeter).toBe(0);
    expect(mc.linErr).toBe(0);
    expect(mc.precision).toBe(Infinity);
    expect(mc.areaSqFt).toBe(0);
  });

  // 45-48. Complex scenarios & integration
  it('45. runs a complete traverse sequence and verifies MAPCHK results', () => {
    const script = `
      NE 1 5000 5000 POB
      TRAV ON
      BD 2 00.0000 1 100.0
      BD 3 90.0000 1 100.0
      BD 4 00.0000 2 100.0
      BD 5 90.0000 3 100.0
      BEG PARCEL
      1
      2
      3
      4
      5
      END
    `;
    const { points, boundaries } = parseCogoBatchScript(script);
    const mc = computeMapCheck(boundaries.PARCEL, points);

    // Verify all points calculated
    expect(points[1]).toBeDefined();
    expect(points[5]).toBeDefined();

    // Verify point coordinates
    expect(points[3].northing).toBe(5100);
    expect(points[3].easting).toBe(5100);

    // Verify mapcheck closure metrics
    expect(mc.perimeter).toBe(400);
    expect(mc.linErr).toBe(0);
    expect(mc.precision).toBe(Infinity);
    expect(mc.areaSqFt).toBe(10000);
    expect(mc.areaAcres).toBeCloseTo(10000 / 43560, 4);
  });

  it('46. processes sequential transformations (TRANS and ROTATE)', () => {
    const script = `
      NE 1 0 0 pivot
      NE 2 10 0 target
      ! Shift right by 5, then rotate 90
      TRANS 5 0 2
      ROTATE 1 90.0 2
    `;
    const { points } = parseCogoBatchScript(script);
    // target (2) starts at (northing 10, easting 0). TRANS 5 0 shifts easting by 5 => (northing 10, easting 5).
    // ROTATE 90 CCW around (0,0) => E' = 5*cos(90) - 10*sin(90) = -10, N' = 5*sin(90) + 10*cos(90) = 5.
    expect(points[2].northing).toBeCloseTo(5, 4);
    expect(points[2].easting).toBeCloseTo(-10, 4);
  });

  it('47. parses multiple parameters with float coordinates and negative offsets', () => {
    const script = `
      NE 1 -100.25 500.5
      STN 1
      BD 2 45.0000 1 141.4214
    `;
    const { points } = parseCogoBatchScript(script);
    // N 45 E, distance 141.4214. dN = 100, dE = 100.
    // Pt 2: northing = -0.25, easting = 600.5
    expect(points[2].northing).toBeCloseTo(-0.25, 2);
    expect(points[2].easting).toBeCloseTo(600.5, 2);
  });

  it('48. tests bearing conversion helpers from bearingParser', () => {
    const brg = bp.parse('N45°22\'10"E');
    expect(brg.azimuthDeg).toBeCloseTo(45.369444, 4);
    expect(brg.quadrant).toBe(1);
    
    const display = bp.toDisplayString(brg.azimuthDeg);
    expect(display).toBe('N45°22\'10.00"E');
  });

});
