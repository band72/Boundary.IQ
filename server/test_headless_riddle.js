import { trySurveyorShapeCorrection, detectBacktracking } from './services/repair.js';
import * as traverseSvc from './services/traverse.js';

// Test Case 1: The uncorrected classic riddle deed (one missing bearing):
const degenerateRiddleWithMissing = {
  courses: [
    { type: 'Line', bearing: 'N45°22\'10"E', distance: 150.25 },
    { type: 'Line', bearing: 'S45°22\'10"W', distance: 150.25 },
    { type: 'Line', bearing: '', distance: 150.25 }, // Missing bearing!
    { type: 'Line', bearing: 'N45°22\'10"E', distance: 150.25 }
  ]
};

// Test Case 2: The exact OCR dropout deed provided by the user:
const degenerateRiddleWithNA = {
  courses: [
    { type: 'Line', bearing: 'N45°22\'10"E', distance: 150.25 },
    { type: 'Line', bearing: 'S45°22\'10"W', distance: 150.25 },
    { type: 'Line', bearing: 'S45°22\'10"E', distance: 150.25 },
    { type: 'Line', bearing: 'N/A', distance: 0 } // OCR bearing/distance dropout!
  ]
};

console.log('=====================================================');
console.log('         Surveyor Riddle Headless Test Running       ');
console.log('=====================================================');

const pob = { northing: 5000, easting: 5000 };

// --- 1. RUN TEST CASE 1 ---
console.log('\n--- Running Case 1: Missing Bearing Riddle ---');
const hasBack1 = detectBacktracking(degenerateRiddleWithMissing.courses);
console.log(`Backtracking check: ${hasBack1 ? 'DETECTED (✓ Correct)' : 'NOT DETECTED (✗ Fail)'}`);

const res1 = trySurveyorShapeCorrection(degenerateRiddleWithMissing);
console.log(`Reconstruction Message: ${res1.message}`);

const t1 = traverseSvc.compute({ pointOfBeginning: pob, courses: res1.courses, units: 'Feet', isOpenEnded: false });
console.log(`Linear Closure Error: ${t1.closure.linearError.toFixed(4)} ft`);
console.log(`Shoelace Area: ${t1.areaSqFt.toFixed(2)} sq ft`);

const isBox1Correct = 
  res1.courses.length === 4 &&
  res1.courses[1].bearing.includes('S44°37\'50') && 
  res1.courses[3].bearing.includes('N44°37\'50') &&
  t1.closure.linearError < 0.30;


// --- 2. RUN TEST CASE 2 ---
console.log('\n--- Running Case 2: User\'s OCR Dropout (N/A & 0 Dist) ---');
const hasBack2 = detectBacktracking(degenerateRiddleWithNA.courses);
console.log(`Backtracking check: ${hasBack2 ? 'DETECTED (✓ Correct)' : 'NOT DETECTED (✗ Fail)'}`);

const res2 = trySurveyorShapeCorrection(degenerateRiddleWithNA);
console.log(`Reconstruction Message: ${res2.message}`);

const t2 = traverseSvc.compute({ pointOfBeginning: pob, courses: res2.courses, units: 'Feet', isOpenEnded: false });
console.log(`Linear Closure Error: ${t2.closure.linearError.toFixed(4)} ft`);
console.log(`Shoelace Area: ${t2.areaSqFt.toFixed(2)} sq ft`);

const isBox2Correct = 
  res2.courses.length === 4 &&
  res2.courses[1].bearing.includes('S44°37\'50') && 
  res2.courses[3].bearing.includes('N44°37\'50') &&
  res2.courses[3].distance === 150.25 && // Confirm healed distance!
  t2.closure.linearError < 0.30;


if (isBox1Correct && isBox2Correct) {
  console.log('\n=====================================================');
  console.log(' 🎉 HEADLESS VERIFICATION SUCCESSFUL!');
  console.log(' Both missing bearings and OCR dropouts are fully corrected.');
  console.log('=====================================================');
  process.exit(0);
} else {
  console.error('\n=====================================================');
  console.error(' ✗ HEADLESS VERIFICATION FAILED!');
  console.error(` Box 1 Correct: ${isBox1Correct} | Box 2 Correct: ${isBox2Correct}`);
  console.error('=====================================================');
  process.exit(1);
}
