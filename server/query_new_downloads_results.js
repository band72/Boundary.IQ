import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TARGET_DIR = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001';
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

  console.log(`\n=== New Downloads Folder Database Query (${files.length} supported files) ===\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  let noRecord = 0;

  const resultsTable = [];

  for (const fileName of files) {
    // Query latest entry for this file
    const row = db.prepare(`
      SELECT FileName, ParcelName, Status, PrecisionRatio, LinearError, RepairStageUsed, Timestamp 
      FROM DeedLogs 
      WHERE FileName = ? OR FileName LIKE ? 
      ORDER BY Timestamp DESC 
      LIMIT 1
    `).get(fileName, `%${path.parse(fileName).name}%`);

    if (row) {
      if (row.Status === 'PASS' || row.Status === 'MEANDER') passed++;
      else if (row.Status === 'FAIL') failed++;
      else if (row.Status === 'SKIPPED') skipped++;
      else errored++;

      resultsTable.push({
        file: fileName,
        status: row.Status,
        parcel: row.ParcelName || 'N/A',
        error: row.LinearError != null && row.LinearError !== 999 ? `${row.LinearError.toFixed(4)} ft` : 'N/A',
        precision: row.PrecisionRatio != null && row.PrecisionRatio > 0 ? `1:${Math.round(row.PrecisionRatio).toLocaleString()}` : 'N/A',
        stage: row.RepairStageUsed || 'N/A'
      });
    } else {
      noRecord++;
    }
  }

  console.log(`=== Summary Statistics for New Downloads ===`);
  console.log(`Total Scanned Files: ${files.length}`);
  console.log(`Passed (Cache hit): \x1b[32m${passed}\x1b[0m`);
  console.log(`Failed:             \x1b[31m${failed}\x1b[0m`);
  console.log(`Skipped:            \x1b[33m${skipped}\x1b[0m`);
  console.log(`Errored:            \x1b[35m${errored}\x1b[0m`);
  console.log(`No Db Record:       ${noRecord}`);
}

main();
