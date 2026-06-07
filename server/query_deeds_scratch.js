import Database from 'better-sqlite3';
import path from 'path';

const dbPath = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(dbPath);

const row = db.prepare("SELECT * FROM DeedLogs WHERE FileName LIKE '%1-2-19%' ORDER BY Timestamp DESC LIMIT 1").get();
if (row) {
  console.log(`FileName: ${row.FileName}`);
  console.log(`Status: ${row.Status}`);
  console.log(`Stage: ${row.RepairStageUsed}`);
  console.log(`ExtractionJson:`);
  console.log(row.ExtractionJson);
} else {
  console.log("No record found");
}
