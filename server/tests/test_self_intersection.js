import { detectSelfIntersection } from '../services/traverse.js';

console.log('Running Self-Intersection Validation Tests...\n');

// Case 1: Simple closed square (should NOT self-intersect)
const square = [
  { seq: 0, easting: 0, northing: 0 },
  { seq: 1, easting: 0, northing: 100 },
  { seq: 2, easting: 100, northing: 100 },
  { seq: 3, easting: 100, northing: 0 },
  { seq: 4, easting: 0, northing: 0 } // closing station
];

// Case 2: Bowtie shape (self-intersects at center)
const bowtie = [
  { seq: 0, easting: 0, northing: 0 },
  { seq: 1, easting: 100, northing: 100 },
  { seq: 2, easting: 0, northing: 100 },
  { seq: 3, easting: 100, northing: 0 },
  { seq: 4, easting: 0, northing: 0 } // closing station
];

// Case 3: Star shape (complex self-intersection)
const star = [
  { seq: 0, easting: 50, northing: 0 },
  { seq: 1, easting: 20, northing: 90 },
  { seq: 2, easting: 90, northing: 30 },
  { seq: 3, easting: 10, northing: 30 },
  { seq: 4, easting: 80, northing: 90 },
  { seq: 5, easting: 50, northing: 0 }
];

const testCases = [
  { name: 'Simple Square', stations: square, expected: false },
  { name: 'Bowtie / Figure-8', stations: bowtie, expected: true },
  { name: 'Self-Intersecting Star', stations: star, expected: true }
];

let failed = false;

testCases.forEach((tc) => {
  const result = detectSelfIntersection(tc.stations);
  const status = result === tc.expected ? '✓ PASSED' : '✗ FAILED';
  console.log(`Test: ${tc.name}`);
  console.log(`  Expected: ${tc.expected}`);
  console.log(`  Actual:   ${result}`);
  console.log(`  Status:   ${status}\n`);
  if (result !== tc.expected) {
    failed = true;
  }
});

if (failed) {
  console.error('Some tests failed!');
  process.exit(1);
} else {
  console.log('All self-intersection tests completed successfully.');
  process.exit(0);
}
