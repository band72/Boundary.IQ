import Database from 'better-sqlite3';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const rows = db.prepare(`
  SELECT FileName, Status, PrecisionRatio, LinearError, RepairStageUsed, ExtractionJson, Timestamp
  FROM DeedLogs
  WHERE FileName LIKE 'Comittment ffor title Solomon%'
  ORDER BY FileName, Timestamp DESC
`).all();

rows.forEach(r => {
  console.log(`=========================================`);
  console.log(`File:      ${r.FileName}`);
  console.log(`Status:    ${r.Status}`);
  console.log(`Stage:     ${r.RepairStageUsed}`);
  console.log(`Error:     ${r.LinearError} ft`);
  console.log(`Timestamp: ${r.Timestamp}`);
  
  let ext = {};
  try { ext = JSON.parse(r.ExtractionJson || '{}'); } catch(e){}
  
  console.log(`Courses extracted in latest DB entry:`);
  if (ext.courses) {
    ext.courses.forEach((c, i) => {
      console.log(`  Course ${i+1}: ${c.bearing} @ ${c.distance} ft`);
    });
  } else {
    console.log(`  No courses found.`);
  }
});
