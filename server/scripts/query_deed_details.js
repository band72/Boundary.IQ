import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });

const row = db.prepare(`
  SELECT ExtractionJson, TraverseJson, RepairStageUsed, Status
  FROM DeedLogs
  WHERE FileName = '180455 Title Commitment(1).pdf'
  ORDER BY Id DESC
  LIMIT 1
`).get();

if (row) {
  console.log("=== EXTRACTION JSON ===");
  console.log(JSON.stringify(JSON.parse(row.ExtractionJson), null, 2));
  console.log("\n=== TRAVERSE JSON ===");
  console.log(JSON.stringify(JSON.parse(row.TraverseJson), null, 2));
  console.log(`\nStatus: ${row.Status} | Stage: ${row.RepairStageUsed}`);
} else {
  console.log("Deed not found.");
}

db.close();
