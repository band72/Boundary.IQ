// server/tests/legalWriterErrors.test.js
import { describe, it, expect } from 'vitest';
import * as legalWriter from '../services/Scripting/legalWriter.js';

describe('legalWriter formatBearing & precision tests', () => {
  it('formats bearing with whole seconds (precision=0) and truncates (does not round up)', () => {
    // S79°37'05.72"E with precision 0 should truncate to S79°37'05"E, not round up to 06"
    const req = {
      courses: [{ type: 'Line', bearing: 'S79-37-05.72E', distance: 85.01 }],
      pobNorthing: 5000,
      pobEasting: 5000,
      bearingSecondsDecimals: 0,
      units: 'feet',
    };
    const desc = legalWriter.write(req);
    expect(desc).toContain('S79°37\'05"E');
    expect(desc).not.toContain('S79°37\'06"E');
  });

  it('formats bearing with 1 decimal place (precision=1) correctly', () => {
    const req = {
      courses: [{ type: 'Line', bearing: 'S79-37-05.72E', distance: 85.01 }],
      pobNorthing: 5000,
      pobEasting: 5000,
      bearingSecondsDecimals: 1,
      units: 'feet',
    };
    const desc = legalWriter.write(req);
    expect(desc).toContain('S79°37\'05.7"E');
  });

  it('formats bearing with 2 decimal places (precision=2) correctly', () => {
    const req = {
      courses: [{ type: 'Line', bearing: 'S79-37-05.72E', distance: 85.01 }],
      pobNorthing: 5000,
      pobEasting: 5000,
      bearingSecondsDecimals: 2,
      units: 'feet',
    };
    const desc = legalWriter.write(req);
    expect(desc).toContain('S79°37\'05.72"E');
  });

  it('gracefully handles null / NaN / undefined values for bearingSecondsDecimals by defaulting to 0', () => {
    const reqNull = {
      courses: [{ type: 'Line', bearing: 'S79-37-05.72E', distance: 85.01 }],
      pobNorthing: 5000,
      pobEasting: 5000,
      bearingSecondsDecimals: null,
      units: 'feet',
    };
    const descNull = legalWriter.write(reqNull);
    expect(descNull).toContain('S79°37\'05"E');

    const reqUndefined = {
      courses: [{ type: 'Line', bearing: 'S79-37-05.72E', distance: 85.01 }],
      pobNorthing: 5000,
      pobEasting: 5000,
      bearingSecondsDecimals: undefined,
      units: 'feet',
    };
    const descUndefined = legalWriter.write(reqUndefined);
    expect(descUndefined).toContain('S79°37\'05"E');

    const reqNaN = {
      courses: [{ type: 'Line', bearing: 'S79-37-05.72E', distance: 85.01 }],
      pobNorthing: 5000,
      pobEasting: 5000,
      bearingSecondsDecimals: 'abc',
      units: 'feet',
    };
    const descNaN = legalWriter.write(reqNaN);
    expect(descNaN).toContain('S79°37\'05"E');
  });

  it('preserves invalid or shorthand format if unable to match quadrant pattern', () => {
    const reqInvalid = {
      courses: [{ type: 'Line', bearing: 'INVALID_BEARING_FORMAT', distance: 85.01 }],
      pobNorthing: 5000,
      pobEasting: 5000,
      bearingSecondsDecimals: 0,
      units: 'feet',
    };
    const desc = legalWriter.write(reqInvalid);
    expect(desc).toContain('INVALID_BEARING_FORMAT');
  });
});
