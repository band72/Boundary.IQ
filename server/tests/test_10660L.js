import { solveFromText } from '../services/deedTextSolver.js';
import fs from 'fs';

console.log('Testing 10660L problem deed...');

const deedText = fs.readFileSync('/home/artwalk/Downloads/problem-deed/10660L_corrected_deed.txt', 'utf8');

try {
  const result = solveFromText(deedText, {
    pobNorthing: 5000.00,
    pobEasting: 5000.00,
    units: 'Feet'
  });

  console.log('Solve status:', result.status);
  console.log('Linear error:', result.traverse?.closure?.linearError);
  console.log('Precision Ratio:', result.traverse?.closure?.precisionRatio);
  console.log('Area:', result.traverse?.areaAcres, 'acres');

  // Print the curves to verify parameter resolution
  console.log('Repaired courses:');
  console.log(JSON.stringify(result.repairedCourses, null, 2));

} catch (err) {
  console.error('Error during solve:', err);
}
