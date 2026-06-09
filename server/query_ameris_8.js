import Database from 'better-sqlite3';
const DB_PATH = process.env.DATABASE_PATH || '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const row = db.prepare(`
  SELECT FileName, Status, ExtractionJson
  FROM DeedLogs 
  WHERE FileName LIKE '%Ameris-Kan-Ki) 8%'
  ORDER BY Timestamp DESC 
  LIMIT 1
`).get();

console.log(JSON.stringify(row, null, 2));
