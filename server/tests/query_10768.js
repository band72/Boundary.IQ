import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath);

const row = db.prepare("SELECT * FROM DeedLogs WHERE FileName = '10768L.txt' ORDER BY Timestamp DESC LIMIT 1").get();
if (row) {
  console.log('--- Status ---');
  console.log(row.Status);
  console.log('--- RepairStageUsed ---');
  console.log(row.RepairStageUsed);
  console.log('--- ExtractionJson ---');
  console.log(JSON.stringify(JSON.parse(row.ExtractionJson), null, 2));
  console.log('--- TraverseJson ---');
  console.log(JSON.stringify(JSON.parse(row.TraverseJson), null, 2));
} else {
  console.log('No log found for 10768L.txt');
}
db.close();
