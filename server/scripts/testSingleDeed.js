import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { solveFromText } from '../services/deedTextSolver.js';

const DEED_FILE = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/_extracted/REGENCY_2525.894 - Monument Road.txt';

if (!fs.existsSync(DEED_FILE)) {
  console.error(`Deed file not found: ${DEED_FILE}`);
  process.exit(1);
}

const text = fs.readFileSync(DEED_FILE, 'utf8');

try {
  const result = solveFromText(text, { pobNorthing: 5000, pobEasting: 5000, units: 'Feet', isOpenEnded: true });
  console.log(`\n🎉 Success! Status: ${result.status}`);
  console.log(`Reference point name: ${result.referencePointName}`);
  console.log(`Commencement courses count: ${(result.commencementSegments || []).length}`);
  result.commencementSegments?.forEach((c, idx) => {
    console.log(`  [C${idx+1}] type=${c.type} bearing=${c.bearing} distance=${c.distance} ft`);
  });
  console.log(`Boundary courses count: ${(result.repairedCourses || []).length}`);
  result.repairedCourses?.forEach((c, idx) => {
    console.log(`  [B${idx+1}] type=${c.type} bearing=${c.bearing} distance=${c.distance} ft`);
  });
  console.log(`Linear error: ${result.traverse?.closure?.linearError} ft`);
  console.log(`Precision: ${result.traverse?.closure?.precisionRatio}`);
} catch (err) {
  console.error(`Solver failed: ${err.message}`);
  console.error(err.stack);
}
