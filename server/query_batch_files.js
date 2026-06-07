import Database from 'better-sqlite3';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const batchId = '9ea3aaf9-5614-4797-b78e-30f04c771d61';
console.log(`=== Batch ${batchId} file breakdown ===`);

const rows = db.prepare(`
  SELECT FileName, Status, RepairStageUsed, ExtractionJson
  FROM DeedLogs 
  WHERE BatchId = ?
`).all(batchId);

rows.forEach((r, idx) => {
  let ext = {};
  try { ext = JSON.parse(r.ExtractionJson || '{}'); } catch(e){}
  console.log(`${idx+1}. File: ${r.FileName} | Status: ${r.Status} | Class: ${ext.classification} | Stage: ${r.RepairStageUsed}`);
});
