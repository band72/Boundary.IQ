import Database from 'better-sqlite3';

const db = new Database('/home/artwalk/.config/BoundaryQC/BoundaryQCDiagnostics.db');
try {
  const sessions = db.prepare('SELECT * FROM Sessions').all();
  console.log('Sessions:', JSON.stringify(sessions, null, 2));
} catch (err) {
  console.error('Error fetching sessions:', err.message);
}
db.close();
