import 'dotenv/config';
import { solveFromCourses } from './services/deedTextSolver.js';

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
  },
  {
    type: 'Curve',
    curveDirection: 'Left',
    radius: 710.48,
    delta: '87°32\'100.00"',
    arcLength: 87.28,
    chordBearing: 'S63°30\'55"W',
    chordDistance: 87.28,
    isUnknown: false
  },
  {
    type: 'Line',
    bearing: 'S64°40\'00"W',
    distance: 51.39,
    isUnknown: false
  },
  {
    type: 'Line',
    bearing: 'S14°58\'30"E',
    distance: 636.00,
    isUnknown: false
  },
  {
    type: 'Line',
    bearing: 'N52°46\'44.44"E',
    distance: 602.68,
    isUnknown: false
  },
  {
    type: 'Line',
    bearing: 'N14°58\'30"W',
    distance: 723.00,
    isUnknown: false
  }
];

async function main() {
  console.log('Running deterministic COGO solver and repair on extracted courses...');
  const solveResult = solveFromCourses(courses, {
    pobNorthing: 5000,
    pobEasting: 5000,
    units: 'Feet'
  });
  
  console.log('\n=========================================');
  console.log('             SOLVER RESULTS              ');
  console.log('=========================================');
  console.log(`Status: ${solveResult.status}`);
  console.log(`Trust Level: ${solveResult.trustLevel} (Score: ${solveResult.trustScore}/100)`);
  console.log(`Linear Error: ${solveResult.traverse?.closure?.linearError?.toFixed(4)} feet`);
  console.log(`Precision Ratio: ${solveResult.traverse?.closure?.precisionRatio}`);
  console.log(`Perimeter: ${solveResult.traverse?.perimeter?.toFixed(2)} feet`);
  console.log(`Area: ${solveResult.traverse?.areaAcres?.toFixed(4)} acres (${solveResult.traverse?.areaSqFt?.toFixed(2)} sq ft)`);
  
  console.log('\nCorrection Table:');
  console.table(solveResult.correctionTable.map(c => ({
    '#': c.courseNumber,
    'Type': c.originalBearing ? 'Line' : 'Curve',
    'Original Bearing': c.originalBearing || 'N/A',
    'Original Distance': c.originalDistance || 'N/A',
    'Repaired Bearing': c.bearing || 'N/A',
    'Repaired Distance': c.distance || 'N/A',
    'Status': c.status,
    'Hypothesis': c.hypothesis || 'None'
  })));
  
  console.log('\nRepaired Legal Description:');
  console.log(solveResult.legalDescription);
}

main();
