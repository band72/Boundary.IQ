import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');

const db = new Database(dbPath);
const rows = db.prepare("SELECT FileName, Status, RepairStageUsed, Timestamp FROM DeedLogs WHERE FileName LIKE '%10370%' OR FileName LIKE '%10660%' ORDER BY Timestamp DESC").all();
console.log('Inspection results:', rows);
