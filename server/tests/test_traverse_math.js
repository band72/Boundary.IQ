import { compute } from '../services/Scripting/traverse.js';

const courses = [
  {
    type: 'Line',
    bearing: 'S54°40\'00"W',
    distance: 458.10
  },
  {
    type: 'Curve',
    radius: 424.73,
    delta: 94.0200, // 93°62'00" normalized
    arcLength: 93.43,
    chordBearing: 'S16°38\'52"E',
    chordDistance: 93.43,
    curveDirection: 'Left'
  },
  {
    type: 'Line',
    bearing: 'S22°57\'45"E',
    distance: 36.10
  },
  {
    type: 'Curve',
    radius: 710.48,
    delta: 87.3340, // 87°32'100" normalized (32' + 100" = 33' 40")
    arcLength: 87.28,
    chordBearing: 'S63°30\'55"W',
    chordDistance: 87.28,
    curveDirection: 'Left'
  },
  {
    type: 'Line',
    bearing: 'S64°40\'00"W',
    distance: 51.39
  },
  {
    type: 'Line',
    bearing: 'S14°58\'30"E',
    distance: 636.00
  },
  {
    type: 'Line',
    bearing: 'N52°46\'44.44"E',
    distance: 602.68
  },
  {
    type: 'Line',
    bearing: 'N14°58\'30"W',
    distance: 723.00
  }
];

const pob = { northing: 5000, easting: 5000 };

try {
  const result = compute({ pointOfBeginning: pob, courses, units: 'Feet', isOpenEnded: false });
  console.log('Closure results:');
  console.log(JSON.stringify(result.closure, null, 2));
  console.log('Area:', result.areaAcres, 'acres');
  console.log('Perimeter:', result.perimeter, 'feet');
} catch (err) {
  console.error('Error:', err);
}
