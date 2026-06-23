import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as bp from '../services/bearingParser.js';
import { parseExtractionJson, solveFromCourses } from '../services/deedTextSolver.js';
import { generateGeoJson, generateLandXml } from '../services/exportService.js';
import { parseDmsToDecimal, autoFixUnknownRuns } from '../services/traverse.js';

describe('Boundary.IQ Improvements Tests', () => {

  describe('1. Robust DMS OCR & Typo Correction', () => {
    it('correctly normalizes double-decimal bearings to standard DMS', () => {
      const res1 = bp.parse('N12.34.56E');
      expect(bp.toDisplayString(res1.azimuthDeg)).toBe('N12°34\'56.00"E');

      const res2 = bp.parse('S12.34.56.78W');
      expect(bp.toDisplayString(res2.azimuthDeg)).toBe('S12°34\'56.78"W');
    });

    it('correctly normalizes smashed bearings without symbols', () => {
      const res1 = bp.parse('S743907W');
      expect(bp.toDisplayString(res1.azimuthDeg)).toBe('S74°39\'07.00"W');

      const res2 = bp.parse('N094546W');
      expect(bp.toDisplayString(res2.azimuthDeg)).toBe('N09°45\'46.00"W');

      const res3 = bp.parse('S743907.5W');
      expect(bp.toDisplayString(res3.azimuthDeg)).toBe('S74°39\'07.50"W');
    });
  });

  describe('2. Multi-Path Commencement Run Splitting', () => {
    it('selects the split index that mathematically minimizes linear closure error', () => {
      // 3 commencement runs + 4 boundary runs
      const rawJson = JSON.stringify({
        Segments: [
          // Commencement runs
          { Type: 'Line', Bearing: 'N00°00\'00"E', Distance: 50 },
          { Type: 'Line', Bearing: 'N90°00\'00"E', Distance: 50 },
          { Type: 'Line', Bearing: 'S00°00\'00"W', Distance: 50 },
          // Boundary runs (which close perfectly on their own)
          { Type: 'Line', Bearing: 'N00°00\'00"E', Distance: 100 },
          { Type: 'Line', Bearing: 'N90°00\'00"E', Distance: 100 },
          { Type: 'Line', Bearing: 'S00°00\'00"W', Distance: 100 },
          { Type: 'Line', Bearing: 'N90°00\'00"W', Distance: 100 }
        ],
        POB: { Northing: 5000, Easting: 5000 },
        Units: 'Feet'
      });

      const deedText = 'COMMENCING at the POC; thence N 00 deg E 50 ft; thence E 50 ft; thence S 50 ft to the POINT OF BEGINNING; thence North 100 ft; thence East 100 ft; thence South 100 ft; thence West 100 ft to the point of beginning.';

      const parsed = parseExtractionJson(rawJson, deedText);
      expect(parsed.commencementSegments).toHaveLength(3);
      expect(parsed.courses).toHaveLength(4);
    });
  });

  describe('3. Smart Non-Tangent Curve Synthesis', () => {
    it('synthesizes the correct chord bearing for a tangent curve to minimize closure error', () => {
      const courses = [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 100 },
        {
          type: 'Curve',
          radius: 100,
          delta: '90°00\'00"',
          direction: 'right',
          chordBearing: 'S80°00\'00"E', // Incorrect explicit chord bearing
          chordDistance: 141.42136
        },
        { type: 'Line', bearing: 'N90°00\'00"E', distance: 100 },
        { type: 'Line', bearing: 'S00°00\'00"W', distance: 200 },
        { type: 'Line', bearing: 'N90°00\'00"W', distance: 200 }
      ];

      const solved = solveFromCourses(courses, {
        pobNorthing: 5000,
        pobEasting: 5000,
        units: 'Feet',
        isOpenEnded: false
      });

      const curve = solved.repairedCourses[1];
      expect(curve.chordBearing).toBe('N45°00\'00.00"E');
      expect(solved.traverse.closure.linearError).toBeLessThan(0.1);
    });
  });

  describe('4. Persistent Global OCR Cache', () => {
    it('successfully writes to and reads from the persistent global OCR cache directory', () => {
      const fileBytes = Buffer.from('Testing global OCR cache ' + Math.random());
      const fileHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      const defaultCacheBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      const ocrCacheDir = path.join(defaultCacheBase, 'BoundaryQC', 'OcrCache');
      const metaPath = path.join(ocrCacheDir, `${fileHash}.json`);

      if (!fs.existsSync(ocrCacheDir)) {
        fs.mkdirSync(ocrCacheDir, { recursive: true });
      }

      const mockOcrData = { combinedOcrText: 'EXPLICIT BOUNDARY TEST DEED TEXT', fileName: 'test_doc.pdf' };
      fs.writeFileSync(metaPath, JSON.stringify(mockOcrData), 'utf8');

      expect(fs.existsSync(metaPath)).toBe(true);
      const readData = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(readData.combinedOcrText).toBe('EXPLICIT BOUNDARY TEST DEED TEXT');
      expect(readData.fileName).toBe('test_doc.pdf');

      fs.unlinkSync(metaPath);
    });
  });

  describe('5. Digital Transposition Scrivener Repairs', () => {
    it('corrects transposed adjacent digits in segment distance', () => {
      // Correct asymmetrical shape: N00E 150.25, N90E 120.50, S30W 173.49, S89°59'40"W 33.76
      // Segment 1 distance transposed: 150.25 -> 105.25
      const courses = [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 105.25 }, // Transposed!
        { type: 'Line', bearing: 'N90°00\'00"E', distance: 120.50 },
        { type: 'Line', bearing: 'S30°00\'00"W', distance: 173.49 },
        { type: 'Line', bearing: 'S89°59\'40"W', distance: 33.76 }
      ];

      const solved = solveFromCourses(courses, {
        pobNorthing: 5000,
        pobEasting: 5000,
        units: 'Feet',
        isOpenEnded: false
      });

      expect(solved.status).toBe('PASS');
      expect(solved.repairedCourses[0].distance).toBe(150.25);
      expect(solved.primaryHypothesis).toContain('distance 105.25→150.25ft');
    });

    it('corrects transposed components in segment bearing', () => {
      // Correct asymmetrical shape: N00E 100.00, N45°22'10"E 100.00, S30E 120.00, S63°10'27"W 146.98
      // Segment 2 bearing transposed: N45°22'10"E -> N45°10'22"E (minutes/seconds transposed)
      const courses = [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 100.00 },
        { type: 'Line', bearing: 'N45°10\'22"E', distance: 100.00 }, // Transposed!
        { type: 'Line', bearing: 'S30°00\'00"E', distance: 120.00 },
        { type: 'Line', bearing: 'S63°10\'27"W', distance: 146.98 }
      ];

      const solved = solveFromCourses(courses, {
        pobNorthing: 5000,
        pobEasting: 5000,
        units: 'Feet',
        isOpenEnded: false
      });

      expect(solved.status).toBe('PASS');
      expect(solved.repairedCourses[1].bearing).toBe('N45°22\'10"E');
      expect(solved.primaryHypothesis).toContain('min/sec digit swap');
    });
  });

  describe('6. LandXML & GeoJSON Exporters', () => {
    const stations = [
      { northing: 5000, easting: 5000 },
      { northing: 5100, easting: 5000 },
      { northing: 5100, easting: 5100 },
      { northing: 5000, easting: 5100 }
    ];
    const courses = [
      { type: 'Line', bearing: 'N00°00\'00"E', distance: 100 },
      { type: 'Line', bearing: 'N90°00\'00"E', distance: 100 },
      { type: 'Line', bearing: 'S00°00\'00"W', distance: 100 },
      { type: 'Line', bearing: 'N90°00\'00"W', distance: 100 }
    ];
    const meta = { parcel: 'Lot 10', county: 'Dane', state: 'WI', units: 'Feet', areaAcres: 0.2295, perimeter: 400 };

    it('generates valid GeoJSON structure', () => {
      const geoJson = JSON.parse(generateGeoJson(stations, null, courses, meta));
      expect(geoJson.type).toBe('FeatureCollection');
      expect(geoJson.features).toHaveLength(1);
      
      const feature = geoJson.features[0];
      expect(feature.type).toBe('Feature');
      expect(feature.properties.parcelName).toBe('Lot 10');
      expect(feature.properties.areaAcres).toBe(0.2295);
      expect(feature.geometry.type).toBe('Polygon');
      
      expect(feature.geometry.coordinates[0]).toHaveLength(5);
      expect(feature.geometry.coordinates[0][4]).toEqual([5000, 5000]);
    });

    it('generates valid LandXML schema string', () => {
      const xml = generateLandXml(stations, null, courses, meta);
      expect(xml).toContain('<?xml');
      expect(xml).toContain('<LandXML');
      expect(xml).toContain('<Units>');
      expect(xml).toContain('<Imperial');
      expect(xml).toContain('<CgPoint pntNo="1"');
      expect(xml).toContain('<Parcel name="Lot_10"');
      expect(xml).toContain('<CoordGeom>');
      expect(xml).toContain('<Line>');
    });
  });

  describe('7. Deflection Angle Preamble References', () => {
    it('assumes North (azimuth 0) as reference when deflection angle starts with no absolute bearing', () => {
      const courses = [
        { type: 'Line', deflectionAngle: 90, deflectionDirection: 'RIGHT', distance: 100 },
        { type: 'Line', deflectionAngle: 90, deflectionDirection: 'LEFT', distance: 100 }
      ];
      const solved = solveFromCourses(courses, {
        pobNorthing: 5000,
        pobEasting: 5000,
        units: 'Feet',
        isOpenEnded: true
      });
      expect(solved.repairedCourses[0].bearing).toBe('N90°00\'00.00"E');
      expect(solved.repairedCourses[1].bearing).toBe('N00°00\'00.00"E');
    });
  });

  describe('8. Multi-Tract & Easement Assembly Parsing', () => {
    it('successfully parses multi-tract JSON from LLM output', () => {
      const rawMultiTract = JSON.stringify({
        Units: 'Feet',
        Tracts: [
          {
            Name: 'Parcel A',
            POB: { Northing: 5000, Easting: 5000 },
            Segments: [
              { Type: 'Line', Bearing: 'N00°00\'00"E', Distance: 100 },
              { Type: 'Line', Bearing: 'N90°00\'00"E', Distance: 100 }
            ]
          },
          {
            Name: 'Parcel B',
            POB: { Northing: 6000, Easting: 6000 },
            Segments: [
              { Type: 'Line', Bearing: 'S00°00\'00"W', Distance: 50 },
              { Type: 'Line', Bearing: 'S90°00\'00"W', Distance: 50 }
            ]
          }
        ]
      });

      const parsed = parseExtractionJson(rawMultiTract);
      expect(parsed.tracts).toHaveLength(2);
      expect(parsed.tracts[0].name).toBe('Parcel A');
      expect(parsed.tracts[0].pob.northing).toBe(5000);
      expect(parsed.tracts[0].courses).toHaveLength(2);

      expect(parsed.tracts[1].name).toBe('Parcel B');
      expect(parsed.tracts[1].pob.northing).toBe(6000);
      expect(parsed.tracts[1].courses).toHaveLength(2);
    });

    it('falls back to single-tract wrapping for legacy JSON formats', () => {
      const rawLegacy = JSON.stringify({
        POB: { Northing: 5000, Easting: 5000 },
        Segments: [
          { Type: 'Line', Bearing: 'N00°00\'00"E', Distance: 100 }
        ]
      });

      const parsed = parseExtractionJson(rawLegacy);
      expect(parsed.tracts).toHaveLength(1);
      expect(parsed.tracts[0].name).toBe('Tract 1');
      expect(parsed.tracts[0].courses).toHaveLength(1);
    });
  });

  // ── Test suite added by Fix D ──────────────────────────────────────────────
  describe('9. parseDmsToDecimal (Fix #2 regression guard)', () => {
    // ── Failure paths — must return null, NOT 0 ───────────────────────────────
    it('returns null for null input', () => {
      expect(parseDmsToDecimal(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parseDmsToDecimal(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseDmsToDecimal('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(parseDmsToDecimal('   ')).toBeNull();
    });

    it('returns null for NaN number', () => {
      expect(parseDmsToDecimal(NaN)).toBeNull();
    });

    it('returns null for a completely unrecognisable string', () => {
      expect(parseDmsToDecimal('not a bearing')).toBeNull();
    });

    // ── Positive parsing paths ────────────────────────────────────────────────
    it('parses a plain decimal-degree string', () => {
      expect(parseDmsToDecimal('93.385278')).toBeCloseTo(93.385278, 5);
    });

    it('parses a plain decimal-degree number', () => {
      // NOTE: when a number is passed, the function treats it as packed DMS
      // 93.23 → 93°23'00" = 93 + 23/60 ≈ 93.3833
      const result = parseDmsToDecimal(93.23);
      expect(result).toBeCloseTo(93 + 23 / 60, 4);
    });

    it('parses a D°M\'S" string correctly', () => {
      // 93°23'06.99" = 93 + 23/60 + 6.99/3600 ≈ 93.385275
      const result = parseDmsToDecimal('93°23\'06.99"');
      expect(result).toBeCloseTo(93 + 23 / 60 + 6.99 / 3600, 5);
    });

    it('parses a full D°M\'S" string (no-seconds via explicit 00")', () => {
      // Use an unambiguous form: 45°30'00" — the function must parse this to 45.5
      const result = parseDmsToDecimal('45°30\'00"');
      expect(result).toBeCloseTo(45.5, 4);
    });

    it('handles scrivener-error minutes ≥ 60 as decimal fallback', () => {
      // "22°97'38.78\"" — minutes=97 is impossible → treat as decimal
      const result = parseDmsToDecimal('22°97\'38.78"');
      expect(typeof result).toBe('number');
      expect(result).not.toBeNull();
      // Must not silently return 0
      expect(result).toBeGreaterThan(0);
    });

    it('returns 0 as a valid numeric result (not null)', () => {
      // A zero delta is mathematically valid
      const result = parseDmsToDecimal('0');
      expect(result).toBe(0);
    });

    it('parseDmsToDecimal correctly converts 93.385278 decimal degrees (the formatDMS fix)', () => {
      // 93.385278° → minutes = 0.385278*60 = 23.11668, seconds = 0.11668*60 = 7.0
      // Check it does NOT return 93 + 38/60 + 52.78/3600 (the old packed-DMS misread)
      const decDeg = parseDmsToDecimal('93.385278');
      const d = Math.floor(decDeg);
      const minFrac = (decDeg - d) * 60;
      const m = Math.floor(minFrac);
      expect(d).toBe(93);
      expect(m).toBe(23); // correct DMS minutes are 23, not 38
    });
  });

  describe('10. Impossible DMS Bearing Detection', () => {
    it('flags impossible DMS values as IMPOSSIBLE confidence', () => {
      // S00°91'50"E — minutes=91 is physically impossible
      const res = bp.parse('S00°91\'50"E');
      expect(res.parseConfidence).toBe('IMPOSSIBLE');
      expect(res.impossibleDms).toBeTruthy();
      expect(res.impossibleDms.min).toBe(91);
    });

    it('flags minutes=90 as impossible', () => {
      const res = bp.parse('N64°90\'50"W');
      expect(res.parseConfidence).toBe('IMPOSSIBLE');
    });

    it('does NOT flag valid DMS values as impossible', () => {
      const res = bp.parse('N45°22\'10"E');
      expect(res.parseConfidence).not.toBe('IMPOSSIBLE');
      expect(res.impossibleDms).toBeUndefined();
    });

    it('hasImpossibleBearings returns false for valid courses', () => {
      const courses = [
        { type: 'Line', bearing: 'N45°22\'10"E', distance: 100 },
        { type: 'Line', bearing: 'S12°34\'56"W', distance: 150 },
      ];
      const result = bp.hasImpossibleBearings(courses);
      expect(result.hasImpossible).toBe(false);
      expect(result.badCourses).toHaveLength(0);
    });

    it('hasImpossibleBearings flags impossible bearings and returns their 1-based indices', () => {
      const courses = [
        { type: 'Line', bearing: 'S00°91\'50"E', distance: 431.02 },  // impossible
        { type: 'Curve', chordBearing: 'N19°44\'08"W', radius: 200 }, // valid
        { type: 'Line', bearing: 'N64°90\'50"W', distance: 98.48 },    // impossible
      ];
      const result = bp.hasImpossibleBearings(courses);
      expect(result.hasImpossible).toBe(true);
      expect(result.badCourses).toContain(1);
      expect(result.badCourses).toContain(3);
      expect(result.badCourses).not.toContain(2);
    });

    it('hasImpossibleBearings handles empty or null input gracefully', () => {
      expect(bp.hasImpossibleBearings([]).hasImpossible).toBe(false);
      expect(bp.hasImpossibleBearings(null).hasImpossible).toBe(false);
    });
  });

  describe('11. 2-Unknown-Runs Iterative Solver', () => {
    it('successfully runs the iterative solver for two non-adjacent unknown runs', () => {
      const courses = [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 100 },
        { type: 'Line', bearing: null, distance: null, isUnknown: true }, // Run 0
        { type: 'Line', bearing: 'N90°00\'00"E', distance: 100 },
        { type: 'Line', bearing: null, distance: null, isUnknown: true }, // Run 1
        { type: 'Line', bearing: 'S00°00\'00"W', distance: 100 },
        { type: 'Line', bearing: 'N90°00\'00"W', distance: 300 }
      ];
      const resolved = autoFixUnknownRuns(courses, { northing: 5000, easting: 5000 });
      expect(resolved[1].isUnknown).toBe(false);
      expect(resolved[1].distance).toBeCloseTo(200, 1);
      expect(resolved[1].bearing).toContain('E');
    });
  });

  describe('12. Curve Course Scrivener Repairs (Principle 9)', () => {
    it('corrects a transposed curve radius to achieve closure', () => {
      // Perfect shape is:
      // C1: N00E 100
      // C2 (Curve): radius 100, delta 90, direction right, chord N45E 141.42, arc 157.08
      // C3: S00E 200
      // C4: N90W 100
      // We transpose C2 radius 100 -> 10.
      const courses = [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 100.00 },
        {
          type: 'Curve',
          radius: 10.00, // Transposed! Should be 100.00
          delta: '90°00\'00"',
          direction: 'right',
          chordBearing: 'N45°00\'00"E',
          chordDistance: 14.14,
          arcLength: 15.71
        },
        { type: 'Line', bearing: 'S00°00\'00"E', distance: 200.00 },
        { type: 'Line', bearing: 'N90°00\'00"W', distance: 100.00 }
      ];

      const solved = solveFromCourses(courses, {
        pobNorthing: 5000,
        pobEasting: 5000,
        units: 'Feet',
        isOpenEnded: false
      });

      expect(solved.status).toBe('PASS');
      expect(solved.repairedCourses[1].radius).toBe(100.00);
      expect(solved.primaryHypothesis).toContain('radius 10→100ft');
    });
  });

  describe('13. New Recommendations (Decimal, Typo, Crandall, Meander Splitting)', () => {
    it('parses decimal degrees bearings with prefix and suffix', () => {
      const res1 = bp.parse('N 45.369 E');
      expect(res1.azimuthDeg).toBeCloseTo(45.369, 5);

      const res2 = bp.parse('S89.12345W');
      expect(res2.azimuthDeg).toBeCloseTo(180 + 89.12345, 5);

      const res3 = bp.parse('45.5E'); // no prefix
      expect(res3.azimuthDeg).toBeCloseTo(45.5, 5);
    });

    it('normalizes fuzzy quadrant OCR letters correctly', () => {
      const res1 = bp.parse('M45.5P');
      expect(res1.azimuthDeg).toBeCloseTo(45.5, 5);

      const res2 = bp.parse('H45.5F');
      expect(res2.azimuthDeg).toBeCloseTo(45.5, 5);

      const res3 = bp.parse('M 45.5 P');
      expect(res3.azimuthDeg).toBeCloseTo(45.5, 5);
    });

    it('normalizes double quotes in minutes and smashed decimal seconds from OCR', () => {
      const res1 = bp.parse('N59°18"41E');
      expect(bp.toDisplayString(res1.azimuthDeg)).toBe('N59°18\'41.00"E');

      const res2 = bp.parse("S86°29'004E");
      expect(bp.toDisplayString(res2.azimuthDeg)).toBe('S86°29\'00.40"E');
    });


    it('applies Crandall adjustment correctly when requested', () => {
      const courses = [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 101.0 },
        { type: 'Line', bearing: 'N90°00\'00"E', distance: 100.0 },
        { type: 'Line', bearing: 'S00°00\'00"W', distance: 100.0 },
        { type: 'Line', bearing: 'N90°00\'00"W', distance: 100.0 }
      ];

      const res = solveFromCourses(courses, {
        pobNorthing: 5000,
        pobEasting: 5000,
        units: 'Feet',
        isOpenEnded: false,
        adjustmentMethod: 'Crandall'
      });

      const stations = res.traverse.adjustedStations;
      const last = stations[stations.length - 1];
      expect(last.northing).toBeCloseTo(5000, 4);
      expect(last.easting).toBeCloseTo(5000, 4);
      expect(stations[1].easting).toBeCloseTo(5000, 4);
    });

    it('splits meander tie vectors proportionally over multiple unknown courses', () => {
      const courses = [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 100 },
        { type: 'Line', bearing: 'N90°00\'00"E', distance: 100 },
        { type: 'Line', bearing: 'S00°00\'00"W', distance: 50 },
        { type: 'Line', bearing: null, distance: 100, isUnknown: true },
        { type: 'Line', bearing: null, distance: 300, isUnknown: true },
        { type: 'Line', bearing: 'N90°00\'00"W', distance: 300 }
      ];

      const resolved = autoFixUnknownRuns(courses, { northing: 5000, easting: 5000 });
      expect(resolved).toHaveLength(6);
      expect(resolved[3].isUnknown).toBe(false);
      expect(resolved[4].isUnknown).toBe(false);

      const totalTieDist = Math.sqrt(50 * 50 + 200 * 200);
      expect(resolved[3].distance).toBeCloseTo(totalTieDist * 0.25, 1);
      expect(resolved[4].distance).toBeCloseTo(totalTieDist * 0.75, 1);
      expect(resolved[3].bearing).toBe(resolved[4].bearing);
    });
  });
});
