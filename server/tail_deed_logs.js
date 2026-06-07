import Database from 'better-sqlite3';
import { setTimeout } from 'timers/promises';

const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

console.log('Watching for new DeedLogs entries...');
let lastId = db.prepare('SELECT MAX(Id) as maxId FROM DeedLogs').get().maxId || 0;
console.log(`Starting from Id > ${lastId}`);

while (true) {
  const rows = db.prepare('SELECT Id, FileName, Status, PrecisionRatio, LinearError, Timestamp FROM DeedLogs WHERE Id > ? ORDER BY Id ASC').all(lastId);
  for (const row of rows) {
    console.log(`[NEW] ${row.Timestamp} | ID: ${row.Id} | File: ${row.FileName} | Status: ${row.Status} | Error: ${row.LinearError} | Prec: ${row.PrecisionRatio}`);
    lastId = row.Id;
  }
  await setTimeout(2000);
}
