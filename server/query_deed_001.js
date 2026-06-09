import Database from 'better-sqlite3';
const DB_PATH = process.env.DATABASE_PATH || '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const row = db.prepare(`
  SELECT ExtractionJson
  FROM DeedLogs 
  WHERE FileName LIKE '%deed-001%'
  ORDER BY Timestamp DESC 
  LIMIT 1
`).get();

if (row && row.ExtractionJson) {
  const parsed = JSON.parse(row.ExtractionJson);
  console.log("Extraction parsed:", JSON.stringify(parsed, null, 2));
} else {
  console.log("No deed-001 record/ExtractionJson found.");
}
