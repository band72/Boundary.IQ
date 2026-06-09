import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

function parsePrecisionRatio(precisionStr) {
  if (!precisionStr) return 100000;
  try {
    const parts = precisionStr.split(':');
    if (parts.length > 1) {
      const cleaned = parts[1].replace(/,/g, '').replace('∞', '999999999').trim();
      const val = parseFloat(cleaned);
      if (!isNaN(val)) return val;
    }
  } catch {}
  return 100000;
}

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    if (isDirectory) {
      walkDir(dirPath, callback);
    } else {
      callback(dirPath);
    }
  });
}

async function main() {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const folder = path.join(configDir, 'BoundaryQC');
  const dbPath = path.join(folder, 'BoundaryQCDiagnostics.db');
  console.log(`Connecting to SQLite database: ${dbPath}`);
  
  const db = new Database(dbPath);
  
  const trainingDir = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training';
  console.log(`Scanning training directory for successful reports: ${trainingDir}`);
  
  let totalFound = 0;
  let totalSeeded = 0;
  let errorCount = 0;
  
  const batchId = 'SEEDED_BATCH';
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  
  // Seed the parent BatchRuns table to satisfy the FOREIGN KEY constraint
  try {
    db.prepare(`
      INSERT OR IGNORE INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate)
      VALUES (?, ?, ?, ?)
    `).run(batchId, timestamp, 2924, 1.0);
    console.log(`✓ Parent BatchRuns entry seeded successfully or already existed.`);
  } catch (err) {
    console.error('Failed to insert into BatchRuns:', err.message);
  }
  
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO DeedLogs (
      BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp,
      ExtractionJson, TraverseJson, AgentTurnsJson, TrustScore, SolutionStepsJson
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  // Wrap all inserts in a single transaction for atomicity and a ~10-50× speed boost
  // (better-sqlite3 transactions do a single disk sync instead of one per row).
  const seedAll = db.transaction(() => {
    walkDir(trainingDir, (filePath) => {
      if (filePath.endsWith('_report.json')) {
        totalFound++;
        try {
          const rawContent = fs.readFileSync(filePath, 'utf-8');
          const json = JSON.parse(rawContent);

          if (json.status === 'success' && json.extraction && json.traverse) {
            const fileName = json.sourceFile;
            const parcelName = json.extraction.classification || 'QUALIFIED_PLSS';
            const courses = json.extraction.courses || [];
            const geoCallCount = courses.length;
            const linearError = json.traverse.closure?.linearError ?? 0;
            const precRatioStr = json.traverse.closure?.precisionRatio ?? '1:100000';
            const precisionRatio = parsePrecisionRatio(precRatioStr);

            const status = 'PASS';
            const repairStageUsed = json.traverse.compassRuleApplied ? 'Stage 3.5: Compass Rule Adjusted' : 'Stage 1: Direct Traverse';

            const extractionJson = JSON.stringify(json.extraction);
            const traverseJson = JSON.stringify(json.traverse);
            const agentTurnsJson = JSON.stringify(json.agentTurns || []);
            const trustScore = json.trustScore || 1.0;
            const solutionStepsJson = JSON.stringify(json.solutionSteps || null);

            insertStmt.run(
              batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, timestamp,
              extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson
            );

            totalSeeded++;
          }
        } catch (err) {
          errorCount++;
          if (errorCount <= 5) {
            console.error(`Error parsing ${filePath}:`, err.message);
          } else if (errorCount === 6) {
            console.error(`  ... (further parse errors suppressed)`);
          }
        }
      }
    });
  });

  seedAll();
  
  console.log(`\n=========================================`);
  console.log(`SEEDING COMPLETED SUMMARY`);
  console.log(`=========================================`);
  console.log(`Total _report.json files scanned: ${totalFound}`);
  console.log(`Successfully seeded into cache:   ${totalSeeded}`);
  console.log(`Parsing errors occurred:          ${errorCount}`);
  console.log(`=========================================\n`);
}

main().catch(err => console.error(err));
