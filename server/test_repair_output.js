import { solveFromCourses } from './services/deedTextSolver.js';

function isPassing(r) {
  if (!r) return false;
  const le = r.closure.linearError;
  console.log('le:', le);
  if (le < 0.30) return true;
  const parts = r.closure.precisionRatio.split(':');
  console.log('parts:', parts);
  if (parts.length > 1) {
    const v = parseFloat(parts[1].replace(/,/g, '').replace('∞', '999999999'));
    console.log('v:', v);
    if (v >= 10000) return true;
  }
  return false;
}

const courses = [
  {
    type: 'Line',
    bearing: 'S54°40\'00"W',
    distance: 458.1,
    isUnknown: false,
    chordBearing: null,
    chordDistance: null,
    radius: null,
    delta: null,
    arcLength: null,
    curveDirection: null
  },
  {
    type: 'Curve',
    bearing: null,
    distance: null,
    isUnknown: false,
    chordBearing: 'S16°38\'52"E',
    chordDistance: 93.43,
    radius: 424.73,
    delta: '93°62\'00"',
    arcLength: 93.43,
    curveDirection: 'Left'
  },
  {
    type: 'Line',
    bearing: 'S22°57\'45"E',
    distance: 36.1,
    isUnknown: false,
    chordBearing: null,
    chordDistance: null,
    radius: null,
    delta: null,
    arcLength: null,
    curveDirection: null
  },
  {
    type: 'Curve',
    bearing: null,
    distance: null,
    isUnknown: false,
    chordBearing: 'S63°30\'55"W',
    chordDistance: 87.28,
    radius: 710.48,
    delta: '87°32\'100"',
    arcLength: 87.28,
    curveDirection: 'Left'
  },
  {
    type: 'Line',
    bearing: 'S64°40\'00"W',
    distance: 51.39,
    isUnknown: false,
    chordBearing: null,
    chordDistance: null,
    radius: null,
    delta: null,
    arcLength: null,
    curveDirection: null
  },
  {
    type: 'Line',
    bearing: 'S14°58\'30"E',
    distance: 636,
    isUnknown: false,
    chordBearing: null,
    chordDistance: null,
    radius: null,
    delta: null,
    arcLength: null,
    curveDirection: null
  },
  {
    type: 'Line',
    bearing: 'N52°46\'44.44"E',
    distance: 602.68,
    isUnknown: false,
    chordBearing: null,
    chordDistance: null,
    radius: null,
    delta: null,
    arcLength: null,
    curveDirection: null
  },
  {
    type: 'Line',
    bearing: 'N14°58\'30"W',
    distance: 723,
    isUnknown: false,
    chordBearing: null,
    chordDistance: null,
    radius: null,
    delta: null,
    arcLength: null,
    curveDirection: null
  }
];

const pob = { northing: 5000, easting: 5000 };
const result = solveFromCourses(courses, { pobNorthing: 5000, pobEasting: 5000, units: 'Feet' });
console.log('Result status:', result.status);
console.log('Result traverse:', result.traverse);
if (result.traverse) {
  console.log('isPassing:', isPassing(result.traverse));
}
