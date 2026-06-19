import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as output from '../services/output.js';

const DB_PATH = process.env.DATABASE_PATH || '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const row = db.prepare(`
  SELECT FileName, Status, ExtractionJson
  FROM DeedLogs 
  WHERE FileName LIKE '%14395L-LOT2%'
  ORDER BY Timestamp DESC 
  LIMIT 1
`).get();

if (!row) {
  console.error("No deed-001.pdf log found in database.");
  process.exit(1);
}

const parsedEx = JSON.parse(row.ExtractionJson);
const resultObj = {
  fileName: row.FileName,
  status: 'skipped',
  extraction: parsedEx,
  traverse: null,
  legalDescription: null,
  originalExtraction: parsedEx,
  conceptualAnalysis: parsedEx.conceptualAnalysis
};

// Create a temp folder in scratch for the output
const testFolder = process.argv[2] || '/home/artwalk/.gemini/antigravity-ide/brain/03ace395-7d9d-43bc-a328-273543ada6f5/scratch/test_output';
if (!fs.existsSync(testFolder)) {
  fs.mkdirSync(testFolder, { recursive: true });
}

console.log("Writing conceptual output files to:", testFolder);
await output.writeResultFiles(testFolder, row.FileName, resultObj, null);

// Check if files exist
console.log("\n=== Generated Files ===");
fs.readdirSync(testFolder).forEach(f => {
  const stat = fs.statSync(path.join(testFolder, f));
  console.log(`- ${f} (${stat.size} bytes)`);
});
