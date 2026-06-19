import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import os from 'os';

const MAIN_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions';
const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath, { readonly: true });

async function main() {
  const allFiles = fs.readdirSync(MAIN_DIR)
    .filter(f => f.toLowerCase().endsWith('.doc') || f.toLowerCase().endsWith('.docx') || f.toLowerCase().endsWith('.pdf'))
    .sort();
  console.log(`Total documents in directory: ${allFiles.length}`);
  
  const unsolved = [];
  const solved = [];
  const failing = [];
  
  for (const file of allFiles) {
    // Check if there is a PASS or MEANDER in database for this file name
    // Let's check both .doc and corresponding .txt (since some are processed as .txt or .doc)
    const base = path.parse(file).name;
    const txtName = base + '.txt';
    const docName = file;
    
    const row = db.prepare(`
      SELECT Status, RepairStageUsed, Timestamp FROM DeedLogs 
      WHERE (FileName = ? OR FileName = ? OR FileName LIKE ?) AND Status IN ('PASS', 'MEANDER')
      ORDER BY Timestamp DESC LIMIT 1
    `).get(docName, txtName, `%${base}%`);
    
    if (row) {
      solved.push({ file, status: row.Status, stage: row.RepairStageUsed, timestamp: row.Timestamp });
    } else {
      // Check if there is a FAIL or ERROR log
      const failRow = db.prepare(`
        SELECT Status, RepairStageUsed, Timestamp FROM DeedLogs
        WHERE (FileName = ? OR FileName = ? OR FileName LIKE ?) AND Status IN ('FAIL', 'ERROR')
        ORDER BY Timestamp DESC LIMIT 1
      `).get(docName, txtName, `%${base}%`);
      
      if (failRow) {
        failing.push({ file, status: failRow.Status, stage: failRow.RepairStageUsed, timestamp: failRow.Timestamp });
      } else {
        unsolved.push(file);
      }
    }
  }
  
  console.log(`Solved in DB: ${solved.length}`);
  console.log(`Failing in DB: ${failing.length}`);
  console.log(`Unprocessed/Not in DB: ${unsolved.length}`);
  
  if (failing.length > 0) {
    console.log('\n=== FAILING IN DB ===');
    failing.slice(0, 20).forEach((f, i) => {
      console.log(`${i + 1}. ${f.file} | Status: ${f.status} | Stage: ${f.stage} | Timestamp: ${f.timestamp}`);
    });
  }
  
  if (unsolved.length > 0) {
    console.log('\n=== UNPROCESSED (NOT IN DB) ===');
    unsolved.slice(0, 20).forEach((u, i) => {
      console.log(`${i + 1}. ${u}`);
    });
  }
}

main();
