import Database from 'better-sqlite3';
import fs from 'fs';

const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    return;
  }

  const db = new Database(DB_PATH);
  
  const rows = db.prepare(`
    SELECT Status, COUNT(*) as count 
    FROM DeedLogs 
    GROUP BY Status
  `).all();

  console.log('=== Status Distribution ===');
  console.table(rows);

  const errors = db.prepare(`
    SELECT DISTINCT RepairStageUsed, count(*) as count
    FROM DeedLogs
    WHERE Status = 'ERROR'
    GROUP BY RepairStageUsed
  `).all();

  console.log('\n=== Error Sources ===');
  console.table(errors);

  const sampleRow = db.prepare(`SELECT * FROM DeedLogs LIMIT 1`).get();
  if (sampleRow) {
    console.log('\n=== DeedLogs Column Names ===');
    console.log(Object.keys(sampleRow));
  }

  const recentLogs = db.prepare(`
    SELECT FileName, Status, RepairStageUsed, Timestamp, FileHash
    FROM DeedLogs
    ORDER BY Timestamp DESC
    LIMIT 15
  `).all();

  console.log('\n=== Most Recent Deed Logs (Last 15) ===');
  console.table(recentLogs);

  const fileDetail = db.prepare(`
    SELECT FileName, Status, RepairStageUsed, ExtractionJson, TraverseJson, AgentTurnsJson, Timestamp
    FROM DeedLogs
    WHERE FileName = 'Comittment ffor title Solomon(1).pdf' OR FileName LIKE 'Comittment ffor title Solomon(1)__%.pdf'
    ORDER BY Timestamp DESC
    LIMIT 1
  `).get();

  if (fileDetail) {
    console.log('\n=== File Detail for Comittment ffor title Solomon(1).pdf ===');
    console.log(`FileName: ${fileDetail.FileName}`);
    console.log(`Status: ${fileDetail.Status}`);
    console.log(`Stage: ${fileDetail.RepairStageUsed}`);
    console.log(`Timestamp: ${fileDetail.Timestamp}`);
    
    console.log('\n--- ExtractionJson ---');
    try {
      const parsed = JSON.parse(fileDetail.ExtractionJson);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(fileDetail.ExtractionJson);
    }

    console.log('\n--- TraverseJson ---');
    try {
      const parsed = JSON.parse(fileDetail.TraverseJson);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(fileDetail.TraverseJson);
    }
  } else {
    console.log('\nNo log found for Comittment ffor title Solomon(1).pdf');
  }
}

main();
