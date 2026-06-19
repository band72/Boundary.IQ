import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import os from 'os';

const docPath = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/12487-1.doc';
const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });

async function main() {
  const fileBytes = fs.readFileSync(docPath);
  const hash = crypto.createHash('sha256').update(fileBytes).digest('hex');
  
  // Since run_file.js converts it to PDF and stores it, the hash in pdfOcrCache might be of the converted PDF.
  // Let's search the DeedLogs table for 12487-1.doc to get its latest entry, including its rawText or extraction details.
  const latestLog = db.prepare(`
    SELECT * FROM DeedLogs
    WHERE FileName = '12487-1.doc'
    ORDER BY Id DESC LIMIT 1
  `).get();
  
  if (latestLog) {
    console.log('Latest Log ID:', latestLog.Id);
    console.log('Status:', latestLog.Status);
    console.log('FileHash:', latestLog.FileHash);
    if (latestLog.ExtractionJson) {
      const ex = JSON.parse(latestLog.ExtractionJson);
      console.log('Extraction POB:', ex.pob || ex.POB);
      console.log('ReferencePointName:', ex.referencePointName || ex.ReferencePointName);
      console.log('CommencementSegments count:', ex.commencementSegments?.length || ex.CommencementSegments?.length);
      console.log('Courses count:', ex.courses?.length || ex.Courses?.length);
      console.log('Courses:', JSON.stringify(ex.courses || ex.Courses, null, 2));
    }
  } else {
    console.log('No logs found for 12487-1.doc');
  }
}

main();
