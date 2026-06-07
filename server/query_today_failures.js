import Database from 'better-sqlite3';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const failedRows = db.prepare(`
  SELECT FileName, BatchId, Status, RepairStageUsed, ExtractionJson, TraverseJson, Timestamp
  FROM DeedLogs 
  WHERE (Status = 'FAIL' OR Status = 'error') AND Timestamp LIKE '2026-06-03%'
  ORDER BY Timestamp DESC
`).all();

console.log(`=== Today's Failed Records (${failedRows.length}) ===`);
failedRows.forEach((r, idx) => {
  let ext = {};
  try { ext = JSON.parse(r.ExtractionJson || '{}'); } catch(e){}
  console.log(`${idx+1}. File: ${r.FileName} | BatchId: ${r.BatchId} | Class: ${ext.classification} | Stage: ${r.RepairStageUsed} | Time: ${r.Timestamp}`);
});
