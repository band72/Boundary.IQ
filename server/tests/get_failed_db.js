import * as db from '../services/diagnosticsDb.js';

try {
  db.init();
  const failed = db.getFailedFileNames();
  console.log(`Failed files count in DB: ${failed.length}`);
  console.log('Sample:', failed.slice(0, 10));
  process.exit(0);
} catch (err) {
  console.error('Error:', err);
  process.exit(1);
}
