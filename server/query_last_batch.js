import Database from 'better-sqlite3';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

// Query all failures in the recent 100 logs
const failures = db.prepare(`
  SELECT FileName, ParcelName, Status, RepairStageUsed, ExtractionJson, TraverseJson, LinearError, PrecisionRatio, Timestamp
  FROM DeedLogs 
  WHERE Status = 'FAIL' OR Status = 'error'
  ORDER BY Timestamp DESC 
  LIMIT 20
`).all();

console.log(`=== Detailed Failure Analysis (Last ${failures.length} Failures) ===\n`);

failures.forEach((f, idx) => {
  let extraction = {};
  let traverse = {};
  try { extraction = JSON.parse(f.ExtractionJson || '{}'); } catch(e){}
  try { traverse = JSON.parse(f.TraverseJson || '{}'); } catch(e){}

  const errorMsg = traverse.error || traverse.traverseError || "Traverse misclosure / math error";
  
  console.log(`${idx + 1}. File: ${f.FileName}`);
  console.log(`   Time: ${f.Timestamp}`);
  console.log(`   Classification: ${extraction.classification || 'N/A'}`);
  console.log(`   Course Count: ${extraction.courses?.length || 0}`);
  console.log(`   Linear Error: ${f.LinearError} ft`);
  console.log(`   Precision: 1:${Math.round(f.PrecisionRatio).toLocaleString()}`);
  console.log(`   Stage: ${f.RepairStageUsed}`);
  console.log(`   Error Details: ${errorMsg}`);
  
  if (extraction.courses && extraction.courses.length > 0) {
    console.log("   Courses:");
    extraction.courses.slice(0, 5).forEach((c, cIdx) => {
      if (c.type === 'Curve') {
        console.log(`     - Curve: dir=${c.curveDirection}, radius=${c.radius}, length=${c.arcLength}`);
      } else {
        console.log(`     - Line: brg=${c.bearing}, dist=${c.distance}`);
      }
    });
    if (extraction.courses.length > 5) {
      console.log(`     ... and ${extraction.courses.length - 5} more courses.`);
    }
  } else {
    console.log("   No courses extracted.");
  }
  console.log("-----------------------------------------");
});
