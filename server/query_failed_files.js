import Database from 'better-sqlite3';
const DB_PATH = process.env.DATABASE_PATH || '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const failedRows = db.prepare(`
  SELECT FileName, Status, RepairStageUsed, ExtractionJson, TraverseJson
  FROM DeedLogs 
  WHERE Status = 'FAIL' OR Status = 'error'
  ORDER BY Timestamp DESC
`).all();

console.log(`=== All Failed Records (${failedRows.length}) ===`);
failedRows.forEach((r, idx) => {
  let ext = {};
  try { ext = JSON.parse(r.ExtractionJson || '{}'); } catch(e){}
  console.log(`${idx+1}. File: ${r.FileName} | Classification: ${ext.classification} | Stage: ${r.RepairStageUsed}`);
});
