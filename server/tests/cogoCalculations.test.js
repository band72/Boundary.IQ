import { describe, it, expect } from 'vitest';
import * as bp from '../services/Scripting/bearingParser.js';
import * as traverseSvc from '../services/Scripting/traverse.js';

// ── Helpers for COGO Scripting Tests ──────────────────────────────────────────

/**
 * Calculates the perpendicular offset of a line segment.
 * @param {{northing: number, easting: number}} p1 - Start point
 * @param {{northing: number, easting: number}} p2 - End point
 * @param {number} offsetDist - Offset distance (positive for right, negative for left)
 * @returns {[{northing: number, easting: number}, {northing: number, easting: number}]} - Offset segment
 */
function calculateOffsetLine(p1, p2, offsetDist) {
  const dN = p2.northing - p1.northing;
  const dE = p2.easting - p1.easting;
  const length = Math.sqrt(dN * dN + dE * dE);
  if (length === 0) return [p1, p2];

  // Perpendicular unit vector (pointing to the right of direction of travel)
  // Direction vector is (dN, dE)
  // Perpendicular vector is (dE, -dN) normalized
  const perpN = dE / length;
  const perpE = -dN / length;

  const o1 = {
    northing: p1.northing + perpN * offsetDist,
    easting: p1.easting + perpE * offsetDist
  };
  const o2 = {
    northing: p2.northing + perpN * offsetDist,
    easting: p2.easting + perpE * offsetDist
  };
  return [o1, o2];
}

/**
 * Calculates the intersection of two bearing-based lines.
 * Line 1 starts at point A with azimuth az1.
 * Line 2 starts at point B with azimuth az2.
 * @returns {{northing: number, easting: number}|null} - Intersection point, or null if parallel
 */
function calculateLineIntersection(pointA, az1Deg, pointB, az2Deg) {
  const r1 = az1Deg * Math.PI / 180;
  const r2 = az2Deg * Math.PI / 180;

  const cos1 = Math.cos(r1);
  const sin1 = Math.sin(r1);
  const cos2 = Math.cos(r2);
  const sin2 = Math.sin(r2);

  // System of equations:
  // A_N + t1 * cos1 = B_N + t2 * cos2
  // A_E + t1 * sin1 = B_E + t2 * sin2
  //
  // Re-arranged:
  // t1 * cos1 - t2 * cos2 = B_N - A_N
  // t1 * sin1 - t2 * sin2 = B_E - A_E

  const dN = pointB.northing - pointA.northing;
  const dE = pointB.easting - pointA.easting;

  // Determinant
  const det = -cos1 * sin2 - (-cos2 * sin1); // -cos1*sin2 + cos2*sin1 = sin(r1 - r2)
  if (Math.abs(det) < 1e-9) {
    return null; // Parallel or collinear lines
  }

  const t1 = (-dN * sin2 - (-cos2 * dE)) / det;
  
  return {
    northing: pointA.northing + t1 * cos1,
    easting: pointA.easting + t1 * sin1
  };
}

/**
 * Computes a side shot from a station.
 * A side shot is a radial measurement to a point off the main traverse.
 * @returns {{northing: number, easting: number}}
 */
function calculateSideShot(station, bearingStr, distance) {
  const { azimuthRad } = bp.parse(bearingStr);
  return {
    northing: station.northing + distance * Math.cos(azimuthRad),
    easting: station.easting + distance * Math.sin(azimuthRad)
  };
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('Comprehensive COGO & Traverse Scripting Tests', () => {

  describe('1. Coordinates, Bearings, and Basic Traverse Loop Closure', () => {
    it('calculates loop closure and Shoelace area on a standard 5-leg traverse', () => {
      const pob = { northing: 5000, easting: 5000 };
      const courses = [
        { type: 'Line', bearing: 'N 00°00\'00" E', distance: 100 },
        { type: 'Line', bearing: 'N 90°00\'00" E', distance: 100 },
        { type: 'Line', bearing: 'S 00°00\'00" W', distance: 50 },
        { type: 'Line', bearing: 'S 45°00\'00" W', distance: 70.7107 }, // returns to easting 5050, northing 5000
        { type: 'Line', bearing: 'N 90°00\'00" W', distance: 50 }
      ];

      const res = traverseSvc.compute({
        pointOfBeginning: pob,
        courses,
        units: 'Feet',
        isOpenEnded: false
      });

      // Verify closing coordinates
      expect(res.stations).toHaveLength(6); // POB + 5 courses
      const finalStation = res.stations[5];
      
      // Verification of raw coordinates before adjustment
      expect(finalStation.northing).toBeCloseTo(pob.northing, 2);
      expect(finalStation.easting).toBeCloseTo(pob.easting, 2);

      // Verification of adjusted stations closing perfectly
      const finalAdjusted = res.adjustedStations[5];
      expect(finalAdjusted.northing).toBe(pob.northing);
      expect(finalAdjusted.easting).toBe(pob.easting);

      // Shoelace Area verification:
      // Shape is a 100x100 square minus a 50x50 corner (triangle / trapezoid):
      // Area of 100x100 rectangle = 10000.
      // Corner shape is trapezoid with height 50, widths 50 and 100?
      // Let's compute area exactly:
      // P1: (5000, 5000)
      // P2: (5100, 5000)
      // P3: (5100, 5100)
      // P4: (5050, 5100)
      // P5: (5000, 5050)
      // Shoelace Area verification:
      // Area = 8750 sq ft.
      expect(res.areaSqFt).toBeCloseTo(8750, 1);
      expect(res.areaAcres).toBeCloseTo(8750 / 43560, 4);
    });
  });

  describe('2. Curves and Reverse Curves Geometry', () => {
    it('computes tangent curves and verifies correct radial center alignment', () => {
      const pob = { northing: 5000, easting: 5000 };
      const courses = [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 100 },
        // Curve to the right: R=100, Delta=90, tangent to N00E.
        // Incoming tangent is North (azimuth 0). Deflection right 90 degrees.
        // Arc length = R * delta (in rad) = 100 * (PI / 2) ≈ 157.08
        // Chord distance = 2 * R * sin(delta/2) = 200 * sin(45) ≈ 141.42
        // Chord bearing = incoming azimuth + delta/2 = 45 deg (N45E)
        {
          type: 'Curve',
          radius: 100,
          delta: '90°00\'00"',
          direction: 'right'
        }
      ];

      const res = traverseSvc.compute({
        pointOfBeginning: pob,
        courses,
        units: 'Feet',
        isOpenEnded: true
      });

      const curveStation = res.stations[2];
      // Start of curve was (5100, 5000)
      // Chord is N45E, dist ≈ 141.42
      // dN = 141.42136 * cos(45) = 100
      // dE = 141.42136 * sin(45) = 100
      // End of curve should be (5200, 5100)
      expect(curveStation.northing).toBeCloseTo(5200, 2);
      expect(curveStation.easting).toBeCloseTo(5100, 2);
    });

    it('computes a reverse curve (Right-Left) sequence and verifies tangency transition', () => {
      const pob = { northing: 5000, easting: 5000 };
      const courses = [
        { type: 'Line', bearing: 'N00E', distance: 100 },
        // Curve 1: Right, R=100, Delta=45
        { type: 'Curve', radius: 100, delta: '45°00\'00"', direction: 'right' },
        // Curve 2: Left, R=100, Delta=45. Tangent to outgoing direction of Curve 1.
        { type: 'Curve', radius: 100, delta: '45°00\'00"', direction: 'left' }
      ];

      const res = traverseSvc.compute({
        pointOfBeginning: pob,
        courses,
        units: 'Feet',
        isOpenEnded: true
      });

      // Curve 1 incoming tangent: North (0 deg). Right turn 45 deg. Outgoing tangent: 45 deg (NE).
      // Curve 2 incoming tangent: 45 deg (NE). Left turn 45 deg. Outgoing tangent: 0 deg (North).
      // Since it's a reverse curve of equal radius and angle, the total deflection is 0,
      // and the final outgoing heading is back to North.
      expect(res.stations).toHaveLength(4);
      
      // Let's check Curve 2 chord bearing:
      // Incoming to C2 is 45 deg. Deflects Left 45.
      // C2 Chord bearing = incoming azimuth - delta/2 = 45 - 22.5 = 22.5 deg (N22°30'E).
      const c2 = res.courses[2];
      expect(c2.chordBearing).toContain('N22°30\'');
    });
  });

  describe('3. Offset Lines Calculations', () => {
    it('generates parallel offset lines to the right and left of a linear segment', () => {
      const p1 = { northing: 5000, easting: 5000 };
      const p2 = { northing: 5100, easting: 5100 }; // Segment going N45E, distance 141.42 ft
      
      // Offset 10 ft to the right (South-East direction relative to path of travel)
      const [o1R, o2R] = calculateOffsetLine(p1, p2, 10);
      
      // For line N45E, unit perp pointing right (SE) is (sin(45), -cos(45)) = (0.7071, -0.7071)
      // dN_offset = 10 * 0.7071 ≈ 7.07
      // dE_offset = -10 * 0.7071 ≈ -7.07
      expect(o1R.northing).toBeCloseTo(5000 + 7.07, 2);
      expect(o1R.easting).toBeCloseTo(5000 - 7.07, 2);
      expect(o2R.northing).toBeCloseTo(5100 + 7.07, 2);
      expect(o2R.easting).toBeCloseTo(5100 - 7.07, 2);

      // Offset 10 ft to the left (negative offset distance)
      const [o1L, o2L] = calculateOffsetLine(p1, p2, -10);
      expect(o1L.northing).toBeCloseTo(5000 - 7.07, 2);
      expect(o1L.easting).toBeCloseTo(5000 + 7.07, 2);
    });
  });

  describe('4. Intersections and Side Shots', () => {
    it('calculates the intersection of two bearing lines (bearing-bearing intersection)', () => {
      const pointA = { northing: 5000, easting: 5000 }; // Line A going North (0 azimuth)
      const pointB = { northing: 5100, easting: 5100 }; // Line B going West (270 azimuth)

      const intersect = calculateLineIntersection(pointA, 0, pointB, 270);
      
      // Line A (North from 5000,5000): easting remains 5000, northing increases
      // Line B (West from 5100,5100): northing remains 5100, easting decreases
      // Intersection should be at (5100, 5000)
      expect(intersect).not.toBeNull();
      expect(intersect.northing).toBeCloseTo(5100, 4);
      expect(intersect.easting).toBeCloseTo(5000, 4);
    });

    it('computes coordinates for radial side shots from traverse stations', () => {
      const station = { northing: 5100, easting: 5100 };
      const sideShotPoint = calculateSideShot(station, 'S45°00\'00"E', 141.4214);

      // S45E from (5100, 5100) by 141.4214 ft
      // dN = 141.4214 * cos(135) = -100
      // dE = 141.4214 * sin(135) = 100
      // Target coordinate should be (5000, 5200)
      expect(sideShotPoint.northing).toBeCloseTo(5000, 2);
      expect(sideShotPoint.easting).toBeCloseTo(5200, 2);
    });
  });

  describe('5. Map Checks & Self-Intersections (Bow-tie detection)', () => {
    it('detects a self-intersecting polygon (bowtie) and flags it', () => {
      // 4-sided shape crossing over itself (bowtie)
      // P1: (5000, 5000)
      // P2: (5100, 5100) (crossing leg 1)
      // P3: (5100, 5000)
      // P4: (5000, 5100) (crossing leg 2)
      // P5: (5000, 5000)
      const stations = [
        { seq: 0, northing: 5000, easting: 5000 },
        { seq: 1, northing: 5100, easting: 5100 },
        { seq: 2, northing: 5100, easting: 5000 },
        { seq: 3, northing: 5000, easting: 5100 },
        { seq: 4, northing: 5000, easting: 5000 }
      ];

      const isSelfIntersecting = traverseSvc.detectSelfIntersection(stations);
      expect(isSelfIntersecting).toBe(true);
    });

    it('correctly reports non-self-intersecting for standard convex boundaries', () => {
      const stations = [
        { seq: 0, northing: 5000, easting: 5000 },
        { seq: 1, northing: 5100, easting: 5000 },
        { seq: 2, northing: 5100, easting: 5100 },
        { seq: 3, northing: 5000, easting: 5100 },
        { seq: 4, northing: 5000, easting: 5000 }
      ];

      const isSelfIntersecting = traverseSvc.detectSelfIntersection(stations);
      expect(isSelfIntersecting).toBe(false);
    });
  });
});
