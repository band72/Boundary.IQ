import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const DEED_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions';
const EXTRACT_DIR = path.join(DEED_DIR, '_extracted');
const REPORT_FILE = path.resolve(SERVER_DIR, '../deed_batch_report.json');

if (!fs.existsSync(REPORT_FILE)) {
  console.error(`Report file not found at ${REPORT_FILE}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
const skipped = report.results.filter(r => r.status === 'SKIPPED');

console.log(`Analyzing ${skipped.length} skipped deeds for POB + Cardinal patterns...\n`);

const pobRegex = /\b(?:POINT\s+OF\s+BEGINNING|P\.?O\.?B\.?)\b/i;
const cardinalPattern = /\b(?:NORTH|SOUTH|EAST|WEST|NORTHERLY|SOUTHERLY|EASTERLY|WESTERLY)\b.*\b\d+(?:\.\d+)?\s*(?:FEET|FT|METERS|M\b)/i;

const potentialMisses = [];

for (const item of skipped) {
  const ext = path.extname(item.fileName).toLowerCase();
  const base = path.basename(item.fileName, ext);
  const textPath = path.join(EXTRACT_DIR, base + '.txt');

  if (!fs.existsSync(textPath)) continue;

  const text = fs.readFileSync(textPath, 'utf8');
  
  const hasPob = pobRegex.test(text);
  const hasCardinalMove = cardinalPattern.test(text);

  if (hasPob && hasCardinalMove) {
    potentialMisses.push({
      fileName: item.fileName,
      snippet: text.slice(0, 300).replace(/\r?\n/g, ' ')
    });
  }
}

console.log(`🚨 Found ${potentialMisses.length} potential missed cardinal boundary descriptions:\n`);
for (const miss of potentialMisses) {
  console.log(`📄 File: ${miss.fileName}`);
  console.log(`   Snippet: ${miss.snippet}`);
  console.log('-'.repeat(50));
}
