import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT d.FileName, d.Status, d.RepairStageUsed, d.LinearError, d.Timestamp
  FROM DeedLogs d
  WHERE d.FileName LIKE '%.doc' AND d.Status IN ('FAIL', 'ERROR')
    AND NOT EXISTS (
      SELECT 1 FROM DeedLogs p
      WHERE p.FileName = d.FileName AND p.Status IN ('PASS', 'MEANDER') AND p.Timestamp >= d.Timestamp
    )
  ORDER BY d.Timestamp DESC
  LIMIT 30
`).all();

console.log("=== Failed/Error .doc files in database ===");
console.log(rows);

db.close();
