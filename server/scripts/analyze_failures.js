import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const REPORT_FILE = path.resolve(SERVER_DIR, '../deed_batch_report.json');
const DEED_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions';
const EXTRACT_DIR = path.join(DEED_DIR, '_extracted');

if (!fs.existsSync(REPORT_FILE)) {
  console.error(`Report file not found at ${REPORT_FILE}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
const fails = report.results.filter(r => r.status === 'FAIL');

console.log(`❌ Analyzing ${fails.length} failed deeds...\n`);

// Group by number of courses to see if there are simple 1-course or 2-course ones that should be meanders or open-ended
const grouped = {};
for (const f of fails) {
  const cCount = f.courses || 0;
  if (!grouped[cCount]) grouped[cCount] = [];
  grouped[cCount].push(f);
}

console.log('--- Failure distribution by course count ---');
for (const [count, list] of Object.entries(grouped)) {
  console.log(`Courses: ${count} -> Count: ${list.length}`);
}
console.log('\n');

// Sample failures with 2 to 6 courses (these should be solvable or might have simple typos)
const sampleCounts = [1, 2, 3, 4, 5];
for (const cCount of sampleCounts) {
  const list = grouped[cCount] || [];
  if (list.length === 0) continue;
  console.log(`======================================================================`);
  console.log(`SAMPLE OF FAILURES WITH ${cCount} COURSES (Total: ${list.length})`);
  console.log(`======================================================================`);
  
  const sample = list.slice(0, 5);
  for (const item of sample) {
    const ext = path.extname(item.fileName).toLowerCase();
    const base = path.basename(item.fileName, ext);
    const textPath = path.join(EXTRACT_DIR, base + '.txt');
    
    let text = '';
    if (fs.existsSync(textPath)) {
      text = fs.readFileSync(textPath, 'utf8').replace(/\s+/g, ' ').slice(0, 400);
    }
    
    console.log(`📄 File: ${item.fileName}`);
    console.log(`   Err:  ${item.linearError} ft`);
    console.log(`   Text: "${text}"`);
    console.log('-'.repeat(60));
  }
}
