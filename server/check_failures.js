import { init, getDatabaseStats, getFailedDeedList } from './services/diagnosticsDb.js';

init();

const stats = getDatabaseStats();
console.log('=== Database Stats ===');
console.log('Total Deed Logs:', stats.deedLogCount);
console.log('Passed:', stats.passCount);
console.log('Failed:', stats.failCount);
console.log('Error Count:', stats.errorCount);
console.log('Error Distribution:', stats.errorDistribution);

const failedList = getFailedDeedList(10);
console.log('\n=== Latest 10 Failed/Error Deeds ===');
for (const deed of failedList) {
  console.log(`- File: ${deed.fileName}`);
  console.log(`  Status: ${deed.status} | Stage: ${deed.repairStageUsed} | Error: ${deed.linearError} ft`);
  console.log(`  Summary: ${deed.extractionSummary}`);
}
