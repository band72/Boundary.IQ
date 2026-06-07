import Database from 'better-sqlite3';

const DB_PATH = '/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db';
const db = new Database(DB_PATH);

const sql = process.argv[2];
if (!sql) {
  console.error('Usage: node run_query.js "<SQL QUERY>"');
  process.exit(1);
}

try {
  const stmt = db.prepare(sql);
  const rows = stmt.all();
  console.log(JSON.stringify(rows, null, 2));
} catch (err) {
  try {
    const stmt = db.prepare(sql);
    const info = stmt.run();
    console.log(JSON.stringify(info, null, 2));
  } catch (err2) {
    console.error('Error (all):', err.message);
    console.error('Error (run):', err2.message);
  }
}
