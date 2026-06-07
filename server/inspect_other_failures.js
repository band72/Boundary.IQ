import Database from 'better-sqlite3';
const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const targetFiles = [
  '20211105102029(1).pdf',
  '1-2-19 Revised Commitment - SIGNED(2).pdf',
  '1-2-19 Revised Commitment - SIGNED.pdf',
  '20211105102029.pdf'
];

targetFiles.forEach(fileName => {
  const row = db.prepare(`
    SELECT FileName, Status, PrecisionRatio, LinearError, RepairStageUsed, ExtractionJson, Timestamp
    FROM DeedLogs
    WHERE FileName = ?
    ORDER BY Timestamp DESC
    LIMIT 1
  `).get(fileName);

  if (row) {
    console.log(`=========================================`);
    console.log(`File:      ${row.FileName}`);
    console.log(`Status:    ${row.Status}`);
    console.log(`Stage:     ${row.RepairStageUsed}`);
    console.log(`Error:     ${row.LinearError} ft`);
    console.log(`Timestamp: ${row.Timestamp}`);
    
    let ext = {};
    try { ext = JSON.parse(row.ExtractionJson || '{}'); } catch(e){}
    
    console.log(`Classification: ${ext.classification}`);
    console.log(`Courses:`);
    if (ext.courses) {
      ext.courses.forEach((c, i) => {
        console.log(`  Course ${i+1}: ${c.type || 'Line'} - ${c.bearing || 'N/A'} @ ${c.distance || c.arcLength || 'N/A'} ft`);
      });
    } else {
      console.log(`  No courses found.`);
    }
  } else {
    console.log(`No record for ${fileName}`);
  }
});
