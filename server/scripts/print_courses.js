import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });

const row = db.prepare(`
  SELECT ExtractionJson
  FROM DeedLogs
  WHERE FileName = '180455 Title Commitment(1).pdf'
  ORDER BY Id DESC
  LIMIT 1
`).get();

if (row) {
  const ext = JSON.parse(row.ExtractionJson);
  console.log("Classification:", ext.Classification);
  console.log("PreambleFound:", ext.PreambleFound);
  console.log("IsOpenEnded:", ext.IsOpenEnded);
  console.log("CommencementSegments Count:", ext.CommencementSegments?.length || 0);
  console.log("Segments Count:", ext.Segments?.length || 0);
  console.log("Courses Count:", ext.courses?.length || 0);
  console.log("Segments:", JSON.stringify(ext.Segments, null, 2));
  console.log("Courses:", JSON.stringify(ext.courses, null, 2));
} else {
  console.log("Not found");
}
db.close();
