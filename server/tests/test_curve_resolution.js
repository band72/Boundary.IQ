import { compute } from '../services/traverse.js';
import assert from 'assert';

console.log('Running curve resolution tests...');

const pob = { northing: 5000, easting: 5000 };

// Test Case 1: Curve missing chordDistance, chordBearing, and delta (provided: radius, arcLength)
// Direction: Right, incoming azimuth: 90 degrees (East)
const courses1 = [
  { type: 'Line', bearing: 'E', distance: 100 }, // Sets incoming tangent to 90 deg
  {
    type: 'Curve',
    radius: 100,
    arcLength: 50,
    curveDirection: 'Right'
  }
];

const res1 = compute({ pointOfBeginning: pob, courses: courses1, units: 'Feet', isOpenEnded: true });
const curve1 = res1.courses[1];

assert.ok(curve1.delta !== null, 'Delta should be resolved');
assert.ok(curve1.chordDistance !== null, 'Chord distance should be resolved');
assert.ok(curve1.chordBearing !== null, 'Chord bearing should be resolved');

// R=100, L=50 => Delta (rad) = 0.5 rad => Delta (deg) = 28.6479°
// Chord distance = 2 * 100 * sin(0.25) = 49.48079
assert.ok(Math.abs(curve1.delta - 28.6479) < 0.01, 'Delta incorrect: ' + curve1.delta);
assert.ok(Math.abs(curve1.chordDistance - 49.48) < 0.05, 'Chord distance incorrect: ' + curve1.chordDistance);
// Chord bearing: incoming is 90° (E), Right deflection, halfDelta = 14.32° => Chord Azimuth = 104.32°
// 104.32° is S75°40'48"E (approx S75°40'E)
assert.ok(curve1.chordBearing.startsWith('S75°') || curve1.chordBearing.startsWith('S75-'), 'Chord bearing incorrect: ' + curve1.chordBearing);

console.log('✓ Test Case 1 (Radius & Arc Length) passed!');

// Test Case 2: Curve missing arcLength, chordBearing, and delta (provided: radius, chordDistance)
const courses2 = [
  { type: 'Line', bearing: 'E', distance: 100 },
  {
    type: 'Curve',
    radius: 100,
    chordDistance: 49.48,
    curveDirection: 'Right'
  }
];

const res2 = compute({ pointOfBeginning: pob, courses: courses2, units: 'Feet', isOpenEnded: true });
const curve2 = res2.courses[1];
assert.ok(curve2.delta !== null);
assert.ok(curve2.arcLength !== null);
assert.ok(curve2.chordBearing !== null);
assert.ok(Math.abs(curve2.arcLength - 50.0) < 0.1, 'Arc length incorrect: ' + curve2.arcLength);
console.log('✓ Test Case 2 (Radius & Chord Distance) passed!');

// Test Case 3: Curve missing radius, chordBearing, and delta (provided: arcLength, chordDistance)
const courses3 = [
  { type: 'Line', bearing: 'E', distance: 100 },
  {
    type: 'Curve',
    arcLength: 50,
    chordDistance: 49.48,
    curveDirection: 'Right'
  }
];
const res3 = compute({ pointOfBeginning: pob, courses: courses3, units: 'Feet', isOpenEnded: true });
const curve3 = res3.courses[1];
assert.ok(curve3.radius !== null);
assert.ok(curve3.delta !== null);
assert.ok(curve3.chordBearing !== null);
assert.ok(Math.abs(curve3.radius - 100) < 1.0, 'Radius incorrect: ' + curve3.radius);
console.log('✓ Test Case 3 (Arc Length & Chord Distance) passed!');

console.log('All curve resolution tests passed!');
