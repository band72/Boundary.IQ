import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import os from 'os';

const FAILED_DEEDS_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/_FAILED/_extracted';
const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });

async function main() {
  const allFiles = fs.readdirSync(FAILED_DEEDS_DIR).filter(f => f.endsWith('.txt')).sort();
  console.log(`Total files in directory: ${allFiles.length}`);
  
  const unresolved = [];
  const cacheHits = [];
  
  for (const file of allFiles) {
    const filePath = path.join(FAILED_DEEDS_DIR, file);
    const content = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');
    
    // Check if there is a PASS or MEANDER in database for this file and hash
    const row = db.prepare(`
      SELECT Status, RepairStageUsed FROM DeedLogs 
      WHERE FileHash = ? AND Status IN ('PASS', 'MEANDER')
        AND TraverseJson IS NOT NULL AND ExtractionJson IS NOT NULL
      ORDER BY Timestamp DESC LIMIT 1
    `).get(fileHash) || db.prepare(`
      SELECT Status, RepairStageUsed FROM DeedLogs 
      WHERE FileName = ? AND (FileHash IS NULL OR FileHash = '') AND Status IN ('PASS', 'MEANDER')
        AND TraverseJson IS NOT NULL AND ExtractionJson IS NOT NULL
      ORDER BY Timestamp DESC LIMIT 1
    `).get(file);
    
    if (row) {
      cacheHits.push({ file, status: row.Status, stage: row.RepairStageUsed });
    } else {
      // Check if there's any record in DeedLogs
      const lastLog = db.prepare(`
        SELECT Status, RepairStageUsed, Timestamp FROM DeedLogs
        WHERE FileHash = ?
        ORDER BY Id DESC LIMIT 1
      `).get(fileHash) || db.prepare(`
        SELECT Status, RepairStageUsed, Timestamp FROM DeedLogs
        WHERE FileName = ? AND (FileHash IS NULL OR FileHash = '')
        ORDER BY Id DESC LIMIT 1
      `).get(file);
      
      unresolved.push({
        file,
        status: lastLog ? lastLog.Status : 'UNPROCESSED',
        stage: lastLog ? lastLog.RepairStageUsed : 'N/A',
        timestamp: lastLog ? lastLog.Timestamp : 'N/A'
      });
    }
  }
  
  console.log(`Cache Hits (Solved): ${cacheHits.length}`);
  console.log(`Unresolved / Failing: ${unresolved.length}\n`);
  
  console.log('=== UNRESOLVED / FAILING FILES ===');
  unresolved.forEach((u, i) => {
    console.log(`${i + 1}. ${u.file} | Status: ${u.status} | Stage: ${u.stage} | Timestamp: ${u.timestamp}`);
  });
}

main();
