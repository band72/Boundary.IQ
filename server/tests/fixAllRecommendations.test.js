import { describe, it, expect } from 'vitest';
import { disambiguateQuadrants } from '../services/Scripting/quadrantDisambiguator.js';
import { compute, detectSelfIntersection } from '../services/Scripting/traverse.js';

describe('Quadrant Disambiguation Engine', () => {
  it('corrects a single flipped quadrant to resolve a boundary', () => {
    // 100x100 square with one quadrant flipped: N00-00-00E, S90-00-00W (should be E), S00-00-00W, S90-00-00W
    const courses = [
      { type: 'Line', bearing: 'N00°00\'00"E', distance: 100 },
      { type: 'Line', bearing: 'S90°00\'00"W', distance: 100 }, // Flipped E -> W
      { type: 'Line', bearing: 'S00°00\'00"W', distance: 100 },
      { type: 'Line', bearing: 'S90°00\'00"W', distance: 100 }, // Correct closing leg (closes West)
    ];

    // Baseline: this has a massive error because it goes North, West, South, West (ends at E=-200, N=0 instead of 0,0)
    const baseline = compute({
      pointOfBeginning: { northing: 5000, easting: 5000 },
      courses,
      units: 'Feet',
      isOpenEnded: false,
    });
    expect(baseline.closure.linearError).toBeGreaterThan(150);

    // Run disambiguator
    const result = disambiguateQuadrants(courses, 5000, 5000);
    expect(result.correctedCount).toBe(1);
    expect(result.corrections[0].courseIndex).toBe(1);
    expect(result.corrections[0].original).toBe('S90°00\'00"W');
    // It should flip to S90°00'00"E (or N90°00'00"E which is geometrically identical)
    expect(result.corrections[0].corrected).toMatch(/[NS]90°00'00"E/i);

    // The corrected course set should close perfectly
    const finalTrav = compute({
      pointOfBeginning: { northing: 5000, easting: 5000 },
      courses: result.courses,
      units: 'Feet',
      isOpenEnded: false,
    });
    expect(finalTrav.closure.linearError).toBeLessThan(1.0);
    expect(detectSelfIntersection(finalTrav.stations)).toBe(false);
  });
});
