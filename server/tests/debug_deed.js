import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { solveFromText, solveDeedText } from '../services/deedTextSolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
process.chdir(SERVER_DIR);

const { init: initDb } = await import('../services/db/core.js');
initDb?.();

const args = process.argv.slice(2);
const useAi = args.includes('--use-ai');
const modelArg = args.find(arg => arg.startsWith('--model='))?.split('=')[1];
const fileName = args.find(arg => !arg.startsWith('--'));

if (!fileName) {
  console.error("Please specify a filename, e.g. 11780A.doc");
  process.exit(1);
}

// Find text in process.env.DEED_DIR/_extracted/
const DEED_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions';
const baseName = path.basename(fileName, path.extname(fileName));
const cachedPath = path.join(DEED_DIR, '_extracted', baseName + '.txt');

if (!fs.existsSync(cachedPath)) {
  console.error(`Cached text file not found at ${cachedPath}`);
  process.exit(1);
}

const text = fs.readFileSync(cachedPath, 'utf8');
console.log(`--- TEXT CONTENT FOR ${fileName} ---`);
console.log(text);
console.log(`------------------------------------`);

let result;
if (useAi) {
  const modelName = modelArg || 'gemma4:26b';
  console.log(`Using AI Solver (Model: ${modelName})...`);
  result = await solveDeedText(text, modelName, { pobNorthing: 5000, pobEasting: 5000, units: 'Feet' });
} else {
  console.log("Using Local Regex Solver...");
  result = solveFromText(text, { pobNorthing: 5000, pobEasting: 5000, units: 'Feet' });
}

console.log('Original Courses detected:');
console.log(JSON.stringify(result.originalCourses, null, 2));

console.log('\nRepaired Courses:');
console.log(JSON.stringify(result.repairedCourses || result.originalCourses, null, 2));

console.log('\nTraverse Result:');
console.log(JSON.stringify(result.traverse, null, 2));

console.log('\nResult Status:', result.status);
process.exit(0);
