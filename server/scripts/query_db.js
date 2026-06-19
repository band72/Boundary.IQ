import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });


const row = db.prepare(`
  SELECT ExtractionJson FROM DeedLogs WHERE Id = 16083
`).get();

if (row) {
  const ext = JSON.parse(row.ExtractionJson || '{}');
  console.log("=== EXTRACTED COURSES ===");
  console.log(JSON.stringify(ext.courses || ext.Courses || [], null, 2));
  console.log("=== COMMENCEMENT SEGMENTS ===");
  console.log(JSON.stringify(ext.commencementSegments || ext.commencement_segments || [], null, 2));
} else {

  console.log("Deed Log ID 16083 not found.");
}

db.close();




