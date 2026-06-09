import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TARGET_DIR = process.env.BOUNDARY_DOWNLOADS_DIR || process.argv[2] || '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001';
const DB_PATH = process.env.DATABASE_PATH || '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';

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

  console.log(`\n=== Detailed Failures & Errors in New Downloads ===\n`);

  for (const fileName of files) {
    const row = db.prepare(`
      SELECT FileName, Status, PrecisionRatio, LinearError, RepairStageUsed, ExtractionJson, Timestamp 
      FROM DeedLogs 
      WHERE (FileName = ? OR FileName LIKE ?)
      ORDER BY Timestamp DESC 
      LIMIT 1
    `).get(fileName, `%${path.parse(fileName).name}%`);

    if (row && (row.Status === 'FAIL' || row.Status === 'ERROR')) {
      console.log(`File: ${fileName}`);
      console.log(`  Status:       \x1b[31m${row.Status}\x1b[0m`);
      console.log(`  Timestamp:    ${row.Timestamp}`);
      console.log(`  Repair Stage: ${row.RepairStageUsed}`);
      console.log(`  Linear Error: ${row.LinearError != null && row.LinearError !== 999 ? row.LinearError.toFixed(4) + ' ft' : 'N/A'}`);
      console.log(`  Precision:    ${row.PrecisionRatio != null && row.PrecisionRatio > 0 ? '1:' + Math.round(row.PrecisionRatio).toLocaleString() : 'N/A'}`);
      
      let parsedExt = {};
      try {
        parsedExt = JSON.parse(row.ExtractionJson || '{}');
      } catch(e) {}
      
      console.log(`  Classification: ${parsedExt.classification || 'N/A'}`);
      if (parsedExt.message) {
        console.log(`  Message:      ${parsedExt.message}`);
      }
      if (parsedExt.courses) {
        console.log(`  Courses Count: ${parsedExt.courses.length}`);
      }
      console.log('-'.repeat(60));
    }
  }
}

main();
