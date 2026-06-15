import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT FileName, ParcelName, LinearError, PrecisionRatio, Status, RepairStageUsed
  FROM DeedLogs
  ORDER BY Id DESC
  LIMIT 40
`).all();

console.log("=== RECENT DEED LOGS ===");
rows.forEach(r => {
  console.log(`File: ${r.FileName} | Status: ${r.Status} | Err: ${r.LinearError} | Prec: ${r.PrecisionRatio} | Stage: ${r.RepairStageUsed}`);
});

db.close();
