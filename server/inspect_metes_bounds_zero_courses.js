import Database from 'better-sqlite3';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const row = db.prepare(`
  SELECT FileName, Status, RepairStageUsed, ExtractionJson
  FROM DeedLogs 
  WHERE FileName LIKE '%Ameris-Kan-Ki) 8%' OR FileName LIKE '%Ameris-Kan-Ki) 8(1)%'
  ORDER BY Timestamp DESC 
  LIMIT 1
`).get();

if (row) {
  console.log("=== Inspecting Ameris-Kan-Ki 8 ===");
  console.log("FileName:", row.FileName);
  console.log("Status:", row.Status);
  console.log("Stage:", row.RepairStageUsed);
  const ext = JSON.parse(row.ExtractionJson || '{}');
  console.log("Extraction classification:", ext.classification);
  console.log("Extraction courses count:", ext.courses?.length);
  console.log("Extraction message:", ext.message);
  console.log("Extraction rawText length:", ext.rawText ? ext.rawText.length : 0);
  console.log("Extraction rawText snippet:", ext.rawText ? ext.rawText.substring(0, 1500) : "N/A");
} else {
  console.log("No records found.");
}
