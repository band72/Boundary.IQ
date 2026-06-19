import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const db = new Database(dbPath);

console.log('Querying all failed/error deeds from:', dbPath);
const rows = db.prepare("SELECT FileName, Status, RepairStageUsed, LinearError FROM DeedLogs WHERE Status != 'PASS' AND Status != 'SKIPPED'").all();
console.log(`Found ${rows.length} failed/error deeds:`);
console.table(rows);
db.close();
