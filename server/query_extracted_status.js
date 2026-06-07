import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TARGET_DIR = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/_extracted';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';

async function main() {
  if (!fs.existsSync(TARGET_DIR)) {
    console.error(`Folder not found: ${TARGET_DIR}`);
    return;
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    return;
  }

  const db = new Database(DB_PATH);
  const files = fs.readdirSync(TARGET_DIR).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.pdf', '.doc', '.docx', '.txt'].includes(ext);
  }).sort();

  console.log(`\n=== _extracted Folder Database Query (${files.length} files) ===\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  let noRecord = 0;

  for (const fileName of files) {
    const row = db.prepare(`
      SELECT Status, PrecisionRatio, LinearError, RepairStageUsed, Timestamp 
      FROM DeedLogs 
      WHERE FileName = ?
      ORDER BY Timestamp DESC 
      LIMIT 1
    `).get(fileName);

    if (row) {
      if (row.Status === 'PASS') passed++;
      else if (row.Status === 'FAIL') failed++;
      else if (row.Status === 'SKIPPED') skipped++;
      else errored++;
      
      console.log(`- ${fileName}: ${row.Status} | Error: ${row.LinearError} | Stage: ${row.RepairStageUsed}`);
    } else {
      noRecord++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total Files:   ${files.length}`);
  console.log(`Passed:        ${passed}`);
  console.log(`Failed:        ${failed}`);
  console.log(`Skipped:       ${skipped}`);
  console.log(`Errored:       ${errored}`);
  console.log(`No Db Record:  ${noRecord}`);
}

main();
