import { init } from '../services/diagnosticsDb.js';
import { writeResultFiles } from '../services/output.js';
import * as legalWriter from '../services/legalWriter.js';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

init();

// Recursively convert PascalCase keys to camelCase (database may store C# PascalCase)
const toCamel = (obj) => {
  if (Array.isArray(obj)) return obj.map(toCamel);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => {
        // Handle fully uppercase abbreviations like "POB" or keep standard camelCase
        const newKey = k === 'POB' ? 'pob' : k.charAt(0).toLowerCase() + k.slice(1);
        return [newKey, toCamel(v)];
      })
    );
  }
  return obj;
};

// Open SQLite database directly to fetch the latest successful deeds
const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath);

console.log("Loading recent successful (PASS) deed logs from database...");
const logs = db.prepare(`
  SELECT * FROM DeedLogs 
  WHERE Status = 'PASS' 
  ORDER BY Timestamp DESC 
  LIMIT 100
`).all();

if (logs.length === 0) {
  console.log("No successful deed logs found in database.");
  process.exit(0);
}

// Create dedicated, clean export folder inside Regency-Title directory
const exportFolder = '/home/friend/Downloads/TrainPDF/Regency-Title/Exported_Deeds_and_DXFs';
fs.mkdirSync(exportFolder, { recursive: true });
console.log(`\nCreated export folder: ${exportFolder}`);

let exportCount = 0;
const exportedFiles = new Set();
const successLog = [];

for (const log of logs) {
  try {
    const filename = log.FileName;
    
    // Prevent duplicate exports of the same file across multiple runs
    if (exportedFiles.has(filename)) continue;

    const rawExtraction = JSON.parse(log.ExtractionJson || 'null');
    const rawTraverse = JSON.parse(log.TraverseJson || 'null');
    
    if (!rawExtraction || !rawTraverse) continue;

    // Standardize C# PascalCase to React-compatible camelCase
    const extraction = toCamel(rawExtraction);
    const traverse = toCamel(rawTraverse);

    const courses = extraction.courses || [];
    
    // Generate legal description
    let legalDescription = null;
    if (courses.length > 0) {
      legalDescription = legalWriter.write({
        courses,
        pobNorthing: 5000,
        pobEasting: 5000,
        county: extraction.county || 'Regency',
        state: extraction.state || 'Florida',
        units: 'feet',
        areaAcres: traverse.areaAcres || 0,
        perimeter: traverse.perimeter || 0,
      });
    }

    const resultObj = {
      fileName: filename,
      status: 'success',
      extraction,
      traverse,
      originalExtraction: extraction,
      error: null
    };

    const writeResultObj = {
      legalDescription,
      courseCount: courses.length
    };

    // Write DXF, original summary, corrected summary, full JSON report, and PNG sketch!
    writeResultFiles(exportFolder, filename, resultObj, writeResultObj);
    exportedFiles.add(filename);
    successLog.push({
      fileName: filename,
      courses: courses.length,
      area: (traverse.areaAcres || 0).toFixed(4),
      linearError: (traverse.closure?.linearError || 0).toFixed(4)
    });
    exportCount++;
  } catch (e) {
    console.error(`Failed to export log item for ${log.FileName}:`, e.message);
  }
}

console.log(`\n======================================================`);
console.log(`🏁 EXPORT COMPLETE: ${exportCount} unique deeds successfully exported!`);
console.log(`Destination: ${exportFolder}`);
console.log(`======================================================\n`);
