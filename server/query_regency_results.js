import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const REGENCY_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF/Regency-Title';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';

async function main() {
  if (!fs.existsSync(REGENCY_DIR)) {
    console.error(`Folder not found: ${REGENCY_DIR}`);
    return;
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    return;
  }

  const db = new Database(DB_PATH);
  const files = fs.readdirSync(REGENCY_DIR).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.pdf', '.doc', '.docx', '.txt'].includes(ext);
  }).sort();

  console.log(`\n=== Regency-Title Test Suite Database Query (${files.length} supported files) ===\n`);

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
      if (row.Status === 'PASS') passed++;
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
      resultsTable.push({
        file: fileName,
        status: 'PENDING / NO RECORD',
        parcel: 'N/A',
        error: 'N/A',
        precision: 'N/A',
        stage: 'N/A'
      });
    }
  }

  // Print results
  console.log(`File`.padEnd(50) + `Status`.padEnd(12) + `Parcel`.padEnd(30) + `Linear Error`.padEnd(15) + `Precision`.padEnd(15) + `Stage`);
  console.log(`-`.repeat(150));
  
  for (const r of resultsTable) {
    let statusColored = r.status;
    if (r.status === 'PASS') statusColored = `\x1b[32mPASS\x1b[0m`;
    else if (r.status === 'FAIL') statusColored = `\x1b[31mFAIL\x1b[0m`;
    else if (r.status === 'SKIPPED') statusColored = `\x1b[33mSKIPPED\x1b[0m`;
    else if (r.status === 'ERROR') statusColored = `\x1b[35mERROR\x1b[0m`;

    console.log(
      r.file.substring(0, 48).padEnd(50) + 
      statusColored.padEnd(20) + // Adjust padding to account for ANSI color codes
      r.parcel.substring(0, 28).padEnd(30) + 
      r.error.padEnd(15) + 
      r.precision.padEnd(15) + 
      r.stage
    );
  }

  console.log(`\n=== Summary Statistics ===`);
  console.log(`Total Scanned Files: ${files.length}`);
  console.log(`Passed:             \x1b[32m${passed}\x1b[0m`);
  console.log(`Failed:             \x1b[31m${failed}\x1b[0m`);
  console.log(`Skipped:            \x1b[33m${skipped}\x1b[0m`);
  console.log(`Errored:            \x1b[35m${errored}\x1b[0m`);
  console.log(`No Db Record:       ${noRecord}`);
}

main();
