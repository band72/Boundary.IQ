import Database from 'better-sqlite3';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const row = db.prepare(`
  SELECT FileName, Status, RepairStageUsed, ExtractionJson, TraverseJson
  FROM DeedLogs 
  WHERE FileName LIKE '%Dihn-Cuffy%'
  ORDER BY Timestamp DESC 
  LIMIT 1
`).get();

if (row) {
  console.log("=== Inspecting Dihn-Cuffy ===");
  console.log("FileName:", row.FileName);
  console.log("Status:", row.Status);
  console.log("Stage:", row.RepairStageUsed);
  const ext = JSON.parse(row.ExtractionJson || '{}');
  console.log("Extraction classification:", ext.classification);
  console.log("Extraction courses count:", ext.courses?.length);
  console.log("Extraction conceptualAnalysis:", ext.conceptualAnalysis);
  console.log("Extraction rawText snippet:", ext.rawText ? ext.rawText.substring(0, 1000) : "N/A");
} else {
  console.log("No Dihn-Cuffy records found.");
}
