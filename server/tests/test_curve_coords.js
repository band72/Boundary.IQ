import { solveFromCourses } from '../services/Scripting/deedTextSolver.js';
import fs from 'fs';

const courses = [
  {
    type: 'Line',
    bearing: 'S54°40\'00"W',
    distance: 458.10,
    isUnknown: false
  },
  {
    type: 'Curve',
    curveDirection: 'Left',
    radius: 424.73,
    delta: '93°62\'00.00"',
    arcLength: 93.43,
    chordBearing: 'S16°38\'52"E',
    chordDistance: 93.43,
    isUnknown: false
  },
  {
    type: 'Line',
    bearing: 'S22°57\'45"E',
    distance: 36.10,
    isUnknown: false
  }
];

const solveResult = solveFromCourses(courses, {
  pobNorthing: 5000,
  pobEasting: 5000,
  units: 'Feet'
});

const p1 = solveResult.traverse.stations[1]; // End of line 1
const p2 = solveResult.traverse.stations[2]; // End of curve 1

console.log('Start of curve p1:', p1.easting, p1.northing);
console.log('End of curve p2:', p2.easting, p2.northing);

// Math from sketchRenderer.js
const R = 424.73;
const dx = p2.easting - p1.easting;
const dy = p2.northing - p1.northing;
const chord = Math.hypot(dx, dy);
console.log('Chord distance calculated:', chord);

const rSq = R * R;
const halfChordSq = (chord / 2) * (chord / 2);
const h = Math.sqrt(rSq - halfChordSq);
console.log('Midpoint to center distance (h):', h);

const mx = (p1.easting + p2.easting) / 2;
const my = (p1.northing + p2.northing) / 2;

const ux = -dy / chord;
const uy = dx / chord;

const isLeft = true;
const cx = isLeft ? mx + h * ux : mx - h * ux;
const cy = isLeft ? my + h * uy : my - h * uy;

console.log('Center of circle:', cx, cy);

const a1 = Math.atan2(p1.northing - cy, p1.easting - cx);
const a2 = Math.atan2(p2.northing - cy, p2.easting - cx);

console.log('Angles (a1, a2) in degrees:', a1 * 180 / Math.PI, a2 * 180 / Math.PI);

let diff = a2 - a1;
if (isLeft) {
  if (diff < 0) diff += 2 * Math.PI;
} else {
  if (diff > 0) diff -= 2 * Math.PI;
}
console.log('Diff angle in degrees:', diff * 180 / Math.PI);

console.log('\nIntermediate points:');
for (let s = 0; s <= 5; s++) {
  const t = s / 5;
  const angle = a1 + diff * t;
  const px = cx + R * Math.cos(angle);
  const py = cy + R * Math.sin(angle);
  console.log(`t = ${t.toFixed(1)}: Easting = ${px.toFixed(3)}, Northing = ${py.toFixed(3)}`);
}
