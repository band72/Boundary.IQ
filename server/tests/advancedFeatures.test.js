import { describe, it, expect } from 'vitest';
import { compute } from '../services/Scripting/traverse.js';
import { toLandXml } from '../../client/src/utils/exportEngine.js';
import { getDocType } from '../services/docClassifier.js';
import fs from 'fs';
import path from 'path';

// ── Reproduce UI Validation Logic for Testing ───────────────────────────

function validateBearing(bearing) {
  if (!bearing) return false;
  const clean = bearing.trim();
  if (/^(N|S|E|W|NORTH|SOUTH|EAST|WEST)$/i.test(clean)) return true;
  const regex = /^[NSns]\s*\d+([\s°\-\d'"’.\u2032\u2033\u2034\u02B9\u02BA\uF0B0\uF0B2\uFEFF\u00BA\u02DA]*)\s*[EWew]?$/;
  return regex.test(clean);
}

function checkBearingWarning(bearing) {
  if (!bearing) return null;
  const clean = bearing.trim().toUpperCase();
  
  if (/^[MHPF]/.test(clean) || /[MHPF]$/.test(clean)) {
    return 'Fuzzy OCR characters detected (e.g., M/H/P/F). Will be auto-corrected in backend.';
  }
  
  const dmsMatch = clean.match(/^[NS]\s*(\d+(?:\.\d+)?)/);
  if (dmsMatch) {
    const deg = parseFloat(dmsMatch[1]);
    if (deg === 0 || deg === 90) {
      return `Cardinal directions (0° or 90°) should not have quadrant letters.`;
    }
  }

  if (/^[NSns]\s*\d{5,6}(?:\.\d+)?\s*[EWew]?$/i.test(clean)) {
    return 'Smashed digits detected. Will be parsed as DMS.';
  }

  if (/^[NSns]\s*\d+\.\d{4,}\s*[EWew]?$/i.test(clean)) {
    return 'Packed DMS format detected. Ensure digits represent DD.MMSS.';
  }

  return null;
}

// Helper to simulate the UI's handleAutoCalculateCurve logic
function autoCalculateCurve({ radius, delta, arcLength, chordDistance }) {
  let r = parseFloat(radius);
  let d = delta;
  let arc = parseFloat(arcLength);
  let chord = parseFloat(chordDistance);

  if (isNaN(r) || r <= 0) return { radius, delta, arcLength, chordDistance };

  let dDeg = null;
  if (d) {
    const dm = String(d).match(/(\d+)[°\-\s](\d+)['\-\s](\d+(?:\.\d+)?)["\s]*/);
    if (dm) {
      dDeg = +dm[1] + +dm[2] / 60 + +dm[3] / 3600;
    } else {
      const parsedD = parseFloat(d);
      if (!isNaN(parsedD)) dDeg = parsedD;
    }
  }

  if (dDeg && !isNaN(dDeg)) {
    const deltaRad = (dDeg * Math.PI) / 180;
    if (isNaN(arc) || arc <= 0) {
      arc = parseFloat((r * deltaRad).toFixed(2));
    }
    if (isNaN(chord) || chord <= 0) {
      chord = parseFloat((2 * r * Math.sin(deltaRad / 2)).toFixed(2));
    }
  } else if (arc && arc > 0) {
    const deltaRad = arc / r;
    const deg = (deltaRad * 180) / Math.PI;
    d = deg.toFixed(4);
    if (isNaN(chord) || chord <= 0) {
      chord = parseFloat((2 * r * Math.sin(deltaRad / 2)).toFixed(2));
    }
  } else if (chord && chord > 0 && chord <= 2 * r) {
    const deltaRad = 2 * Math.asin(chord / (2 * r));
    const deg = (deltaRad * 180) / Math.PI;
    d = deg.toFixed(4);
    if (isNaN(arc) || arc <= 0) {
      arc = parseFloat((r * deltaRad).toFixed(2));
    }
  }

  return {
    radius: String(r),
    delta: String(d),
    arcLength: isNaN(arc) ? '' : String(arc),
    chordDistance: isNaN(chord) ? '' : String(chord)
  };
}

describe('Advanced Traverse & UI Features', () => {

  // ── 1. Bowditch vs. Crandall Integration ──────────────────────────────
  describe('Bowditch vs. Crandall Adjustment Methods', () => {
    const courses = [
      { type: 'Line', bearing: 'N45-00-00E', distance: 100 },
      { type: 'Line', bearing: 'S45-00-00E', distance: 100 },
      { type: 'Line', bearing: 'S45-00-00W', distance: 100 },
      { type: 'Line', bearing: 'N45-00-00W', distance: 99.0 }, // 1.0 ft misclosure along diagonal
    ];

    it('applies Bowditch (Compass Rule) adjustment when specified', () => {
      const res = compute({
        pointOfBeginning: { northing: 5000, easting: 5000 },
        courses,
        units: 'Feet',
        isOpenEnded: false,
        adjustmentMethod: 'Compass',
      });

      // Verification: last adjusted station closes back to POB
      const last = res.adjustedStations[res.adjustedStations.length - 1];
      expect(last.northing).toBeCloseTo(5000, 4);
      expect(last.easting).toBeCloseTo(5000, 4);
    });

    it('applies Crandall adjustment when specified', () => {
      const res = compute({
        pointOfBeginning: { northing: 5000, easting: 5000 },
        courses,
        units: 'Feet',
        isOpenEnded: false,
        adjustmentMethod: 'Crandall',
      });

      // Crandall closes the traverse using least squares for angle error distribution
      const last = res.adjustedStations[res.adjustedStations.length - 1];
      expect(last.northing).toBeCloseTo(5000, 4);
      expect(last.easting).toBeCloseTo(5000, 4);
    });

    it('yields different intermediate stations under Crandall vs Bowditch', () => {
      const bowditchRes = compute({
        pointOfBeginning: { northing: 5000, easting: 5000 },
        courses,
        units: 'Feet',
        isOpenEnded: false,
        adjustmentMethod: 'Compass',
      });

      const crandallRes = compute({
        pointOfBeginning: { northing: 5000, easting: 5000 },
        courses,
        units: 'Feet',
        isOpenEnded: false,
        adjustmentMethod: 'Crandall',
      });

      // The adjusted stations coordinates must be slightly different
      const bStation = bowditchRes.adjustedStations[2];
      const cStation = crandallRes.adjustedStations[2];
      expect(bStation.northing).not.toBe(cStation.northing);
    });
  });

  // ── 2. LandXML Export Engine ──────────────────────────────────────────
  describe('LandXML Export Engine', () => {
    const stations = [
      { northing: 5000.0, easting: 5000.0 },
      { northing: 5100.0, easting: 5000.0 },
      { northing: 5100.0, easting: 5100.0 },
      { northing: 5000.0, easting: 5100.0 },
    ];
    const courses = [
      { type: 'Line', bearing: 'N00E', distance: 100 },
      { type: 'Line', bearing: 'N90E', distance: 100 },
      { type: 'Line', bearing: 'S00W', distance: 100 },
      { type: 'Curve', radius: 100, delta: '90-00-00', chordDistance: 141.42 },
    ];

    it('generates a valid LandXML string structure', () => {
      const xml = toLandXml(stations, courses, { parcel: 'Lot_A', units: 'Feet', areaAcres: 0.23 });

      expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
      expect(xml).toContain('<LandXML');
      expect(xml).toContain('linearUnit="foot"');
      expect(xml).toContain('<CgPoints>');
      expect(xml).toContain('<CgPoint pntNo="1" desc="POB">5000.0000 5000.0000</CgPoint>');
      expect(xml).toContain('<Parcel name="Lot_A"');
      expect(xml).toContain('<CoordGeom>');
      expect(xml).toContain('<Line>');
      expect(xml).toContain('<Curve');
      expect(xml).toContain('</LandXML>');
    });

    it('properly sanitizes parcel names in XML tags', () => {
      const xml = toLandXml(stations, courses, { parcel: 'Lot 10 & 11! (West)', units: 'Meters' });
      expect(xml).toContain('linearUnit="meter"');
      expect(xml).toContain('name="Lot_10___11___West_"');
    });
  });

  // ── 3. Fuzzy Bearing Validation ────────────────────────────────────────
  describe('Fuzzy Bearing Validation and Warning Tooltips', () => {
    it('flags OCR quadrant errors (M, H, P, F) with descriptive warnings', () => {
      expect(checkBearingWarning('M45-30-00E')).toContain('Fuzzy OCR characters');
      expect(checkBearingWarning('N45-30-00F')).toContain('Fuzzy OCR characters');
      expect(checkBearingWarning('H45-30-00W')).toContain('Fuzzy OCR characters');
    });

    it('flags cardinal direction mismatches (e.g. N0E or S90W)', () => {
      expect(checkBearingWarning('N0E')).toContain('Cardinal directions');
      expect(checkBearingWarning('S90.0W')).toContain('Cardinal directions');
      expect(checkBearingWarning('N 00°00\'00" W')).toContain('Cardinal directions');
    });

    it('flags smashed digits / invalid DMS formats', () => {
      expect(checkBearingWarning('N453000E')).toContain('Smashed digits');
      expect(checkBearingWarning('S123456W')).toContain('Smashed digits');
    });

    it('flags packed DMS format', () => {
      expect(checkBearingWarning('N45.3000E')).toContain('Packed DMS format');
      expect(checkBearingWarning('S12.0000W')).toContain('Packed DMS format');
    });

    it('returns null for correctly formatted bearings', () => {
      expect(checkBearingWarning('N45-30-00E')).toBeNull();
      expect(checkBearingWarning('S12°34\'56"W')).toBeNull();
      expect(checkBearingWarning('N89.5E')).toBeNull();
    });
  });

  // ── 4. Curve Auto-Calculate Helper ────────────────────────────────────
  describe('Curve Parameters Auto-Calculator', () => {
    it('calculates Arc Length and Chord Distance from Radius & Delta', () => {
      const result = autoCalculateCurve({
        radius: '100',
        delta: '90',
        arcLength: '',
        chordDistance: ''
      });
      // Arc = R * deltaRad = 100 * (PI / 2) = 157.08
      expect(parseFloat(result.arcLength)).toBeCloseTo(157.08, 1);
      // Chord = 2 * R * sin(deltaRad / 2) = 200 * sin(45) = 141.42
      expect(parseFloat(result.chordDistance)).toBeCloseTo(141.42, 1);
    });

    it('calculates Delta and Chord Distance from Radius & Arc Length', () => {
      const result = autoCalculateCurve({
        radius: '100',
        delta: '',
        arcLength: '157.08',
        chordDistance: ''
      });
      // delta = Arc / R = 1.5708 rad = 90 deg
      expect(parseFloat(result.delta)).toBeCloseTo(90.00, 1);
      expect(parseFloat(result.chordDistance)).toBeCloseTo(141.42, 1);
    });

    it('calculates Delta and Arc Length from Radius & Chord Distance', () => {
      const result = autoCalculateCurve({
        radius: '100',
        delta: '',
        arcLength: '',
        chordDistance: '141.42'
      });
      // delta = 2 * asin(Chord / 2R) = 2 * asin(141.42 / 200) = 90 deg
      expect(parseFloat(result.delta)).toBeCloseTo(90.00, 1);
      expect(parseFloat(result.arcLength)).toBeCloseTo(157.08, 1);
    });
  });

  // ── 5. Document Classifier Skip Bypass ───────────────────────────────
  describe('Document Classifier Skip Bypass', () => {
    const testDir = path.join(__dirname, '../../tmp_classifier_test');

    it('bypasses title commitment skip filename keyword if content contains traversable courses', () => {
      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

      const testFilePath = path.join(testDir, '180455 Title Commitment.txt');
      
      // 1. Text with NO traversable courses -> should return SKIP
      fs.writeFileSync(testFilePath, 'This is a Schedule A title commitment cover sheet with no courses.', 'utf-8');
      expect(getDocType(testFilePath, '180455 Title Commitment.txt')).toBe('SKIP');

      // 2. Text WITH traversable courses -> should bypass skip and return DEED
      fs.writeFileSync(testFilePath, 'This is a Schedule A title commitment. THENCE North 45 degrees East 100 feet to POB.', 'utf-8');
      expect(getDocType(testFilePath, '180455 Title Commitment.txt')).toBe('DEED');

      // Cleanup
      try {
        fs.unlinkSync(testFilePath);
        fs.rmdirSync(testDir);
      } catch {}
    });
  });

});

