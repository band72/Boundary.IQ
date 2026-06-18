import fs from 'fs/promises';
import path from 'path';

const FAILED_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/_FAILED';

async function main() {
  const entries = await fs.readdir(FAILED_DIR, { withFileTypes: true });
  const subdirs = entries.filter(e => e.isDirectory() && e.name !== '_extracted');

  console.log(`Found ${subdirs.length} subdirectories containing manual corrections.`);

  let totalSummaries = 0;
  const statusCounts = {};

  for (const subdir of subdirs) {
    const dirPath = path.join(FAILED_DIR, subdir.name);
    const files = await fs.readdir(dirPath);
    const summaryFiles = files.filter(f => f.endsWith('_summary.json'));

    for (const file of summaryFiles) {
      totalSummaries++;
      const filePath = path.join(dirPath, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const json = JSON.parse(content);
        const status = json.status || 'unknown';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      } catch (err) {
        statusCounts['error_reading'] = (statusCounts['error_reading'] || 0) + 1;
      }
    }
  }

  console.log(`Total summary files: ${totalSummaries}`);
  console.log('Status breakdown:', statusCounts);
}

main();
