import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const REPORT_FILE = path.resolve(SERVER_DIR, '../deed_batch_report.json');

if (!fs.existsSync(REPORT_FILE)) {
  console.error(`Report file not found at ${REPORT_FILE}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
const skipped = report.results.filter(r => r.status === 'SKIPPED');

console.log(`🔍 Total Skipped Deeds: ${skipped.length}\n`);

// Group by skip reason
const grouped = {};
for (const item of skipped) {
  const reason = item.skipReason || 'UNKNOWN';
  if (!grouped[reason]) grouped[reason] = [];
  grouped[reason].push(item);
}

for (const [reason, list] of Object.entries(grouped)) {
  console.log(`📁 Skip Reason: ${reason} (Count: ${list.length})`);
  console.log('='.repeat(50));
  // Sample 5 files of each reason
  const sample = list.slice(0, 5);
  for (const item of sample) {
    console.log(`📄 File: ${item.fileName}`);
    console.log(`   Snippet: ${item.snippet ? item.snippet.replace(/\r?\n/g, ' ').slice(0, 200) : 'None'}`);
    console.log('-');
  }
  console.log('\n');
}
