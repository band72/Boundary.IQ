import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });

try {
  // Get all failed deeds that still don't have a PASS/MEANDER
  const failedDeeds = db.prepare(`
    SELECT DISTINCT FileName FROM DeedLogs d
    WHERE Status IN ('ERROR', 'FAIL')
      AND NOT EXISTS (
        SELECT 1 FROM DeedLogs p
        WHERE p.FileName = d.FileName AND p.Status IN ('PASS', 'MEANDER') AND p.Timestamp >= d.Timestamp
      )
    ORDER BY FileName
  `).all().map(r => r.FileName);

  console.log(`=== STILL FAILING DEEDS DETAILS (${failedDeeds.length}) ===\\n`);

  for (const file of failedDeeds) {
    // Get the latest log entry for this file
    const latest = db.prepare(`
      SELECT Id, Status, LinearError, PrecisionRatio, RepairStageUsed, TraverseJson, Timestamp
      FROM DeedLogs
      WHERE FileName = ?
      ORDER BY Id DESC
      LIMIT 1
    `).get(file);

    if (latest) {
      console.log(`File: ${file}`);
      console.log(`  Timestamp: ${latest.Timestamp} (Log ID: ${latest.Id})`);
      console.log(`  Status: ${latest.Status} | Linear Error: ${latest.LinearError} | Precision: ${latest.PrecisionRatio}`);
      console.log(`  Repair Stage: ${latest.RepairStageUsed}`);
      
      let travError = '';
      if (latest.TraverseJson) {
        try {
          const travObj = JSON.parse(latest.TraverseJson);
          travError = travObj.closure?.status || travObj.error || '';
        } catch {}
      }
      console.log(`  Traverse Details: ${travError}`);
      console.log('-'.repeat(60));
    }
  }
} catch (err) {
  console.error('Error:', err.message);
} finally {
  db.close();
}
