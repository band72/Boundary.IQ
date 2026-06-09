import Database from 'better-sqlite3';
import fs from 'fs';

const DB_PATH = process.env.DATABASE_PATH || '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    return;
  }

  const db = new Database(DB_PATH);
  
  const query = `
    SELECT FileName, Status, RepairStageUsed, Timestamp
    FROM DeedLogs
    WHERE FileName LIKE 'llms-full%'
    LIMIT 20
  `;
  const rows = db.prepare(query).all();

  console.log('=== Database Entries matching llms-full ===');
  console.table(rows);
  
  const countQuery = `
    SELECT Status, COUNT(*) as count
    FROM DeedLogs
    WHERE FileName LIKE 'llms-full%'
    GROUP BY Status
  `;
  console.table(db.prepare(countQuery).all());
}

main();
