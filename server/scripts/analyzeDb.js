import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dbPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');

const db = new Database(dbPath, { readonly: true });

console.log('==================================================');
console.log('       Boundary.IQ Database Analysis Script       ');
console.log('==================================================');
console.log(`Database: ${dbPath}\n`);

// 1. Overall Stats
const overall = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN Status = 'PASS' THEN 1 ELSE 0 END) as passed,
    SUM(CASE WHEN Status = 'FAIL' THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN Status = 'MEANDER' THEN 1 ELSE 0 END) as meanders,
    SUM(CASE WHEN Status = 'ERROR' THEN 1 ELSE 0 END) as errors
  FROM DeedLogs
`).get();

const passRate = overall.total > 0 ? (overall.passed / overall.total * 100).toFixed(1) : '0.0';

console.log('📈 OVERALL METRICS:');
console.log(`  Total Deeds Processed: ${overall.total}`);
console.log(`  Passed / Closed:       ${overall.passed} (${passRate}%)`);
console.log(`  Failed / Needs Review: ${overall.failed}`);
console.log(`  Meanders (Waterways):  ${overall.meanders}`);
console.log(`  Processing Errors:     ${overall.errors}\n`);

// 2. Classification Breakdown
console.log('🗂️ CLASSIFICATION BREAKDOWN:');
const classifications = db.prepare(`
  SELECT 
    CASE 
      WHEN ExtractionJson IS NOT NULL AND json_valid(ExtractionJson) THEN json_extract(ExtractionJson, '$.Classification')
      WHEN ParcelName LIKE '[%]%' THEN substr(ParcelName, 2, instr(ParcelName, ']') - 2)
      ELSE 'UNKNOWN'
    END as class,
    COUNT(*) as count,
    SUM(CASE WHEN Status = 'PASS' THEN 1 ELSE 0 END) as passed,
    SUM(CASE WHEN Status = 'FAIL' THEN 1 ELSE 0 END) as failed
  FROM DeedLogs
  GROUP BY class
  ORDER BY count DESC
`).all();

classifications.forEach(c => {
  const cRate = c.count > 0 ? (c.passed / c.count * 100).toFixed(1) : '0.0';
  const name = String(c.class || 'UNKNOWN');
  console.log(`  • ${name.padEnd(20)}: ${String(c.count).padStart(4)} total | PASS: ${String(c.passed).padStart(4)} | FAIL: ${String(c.failed).padStart(4)} | Pass Rate: ${cRate}%`);
});
console.log('');

// 3. Repair Stage Breakdown
console.log('🔧 REPAIR STAGE BREAKDOWN:');
const stages = db.prepare(`
  SELECT 
    RepairStageUsed as stage,
    COUNT(*) as count,
    SUM(CASE WHEN Status = 'PASS' THEN 1 ELSE 0 END) as passed
  FROM DeedLogs
  WHERE stage IS NOT NULL AND stage != ''
  GROUP BY stage
  ORDER BY count DESC
`).all();

stages.forEach(s => {
  console.log(`  • ${(s.stage || 'Unknown').padEnd(45)}: ${String(s.count).padStart(4)} applications | Passed: ${s.passed}`);
});
console.log('');

// 4. Failing Deed Closure Errors
console.log('📐 CLOSURE ERROR DISTRIBUTION (FAILING DEEDS):');
const errors = db.prepare(`
  SELECT 
    SUM(CASE WHEN LinearError <= 1.0 THEN 1 ELSE 0 END) as near_closed,
    SUM(CASE WHEN LinearError > 1.0 AND LinearError <= 10.0 THEN 1 ELSE 0 END) as minor_error,
    SUM(CASE WHEN LinearError > 10.0 AND LinearError <= 100.0 THEN 1 ELSE 0 END) as moderate_error,
    SUM(CASE WHEN LinearError > 100.0 THEN 1 ELSE 0 END) as major_error
  FROM DeedLogs
  WHERE Status = 'FAIL'
`).get();

if (errors) {
  const totalFail = overall.failed || 1;
  console.log(`  • ≤ 1.0 ft (Near Closed)      : ${String(errors.near_closed).padStart(4)} deeds (${(errors.near_closed / totalFail * 100).toFixed(1)}% of failures)`);
  console.log(`  • 1.0 to 10.0 ft (Minor)       : ${String(errors.minor_error).padStart(4)} deeds (${(errors.minor_error / totalFail * 100).toFixed(1)}% of failures)`);
  console.log(`  • 10.0 to 100.0 ft (Moderate)  : ${String(errors.moderate_error).padStart(4)} deeds (${(errors.moderate_error / totalFail * 100).toFixed(1)}% of failures)`);
  console.log(`  • > 100.0 ft (Major Misread)   : ${String(errors.major_error).padStart(4)} deeds (${(errors.major_error / totalFail * 100).toFixed(1)}% of failures)`);
}
console.log('==================================================\n');
db.close();
