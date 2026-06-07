import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import crypto from 'crypto';

function getFileHash(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (err) {
    console.error(`Error reading ${filePath} for hash:`, err.message);
    return null;
  }
}

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
  try {
    fs.readdirSync(dir).forEach(f => {
      const dirPath = path.join(dir, f);
      const isDirectory = fs.statSync(dirPath).isDirectory();
      if (isDirectory) {
        walkDir(dirPath, callback);
      } else {
        callback(dirPath);
      }
    });
  } catch (err) {
    console.error(`Error walking dir ${dir}:`, err.message);
  }
}

async function main() {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const folder = path.join(configDir, 'BoundaryQC');
  const dbPath = path.join(folder, 'BoundaryQCDiagnostics.db');
  console.log(`Connecting to SQLite database: ${dbPath}`);
  
  const db = new Database(dbPath);
  
  const downloadDir = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001';
  const parentDownloads = '/home/artwalk/Downloads';
  
  if (!fs.existsSync(downloadDir)) {
    console.error(`Download directory does not exist: ${downloadDir}`);
    return;
  }
  
  console.log(`Scanning all reports in ${parentDownloads} to build a mapping...`);
  const reportMap = new Map(); // Map: sourceFile (lowercase) -> Array of report paths
  
  walkDir(parentDownloads, (filePath) => {
    if (filePath.endsWith('_report.json')) {
      try {
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        const json = JSON.parse(rawContent);
        if (json.sourceFile) {
          const key = json.sourceFile.toLowerCase();
          if (!reportMap.has(key)) {
            reportMap.set(key, []);
          }
          reportMap.get(key).push({
            path: filePath,
            status: json.status,
            processedAt: json.processedAt || ''
          });
        }
      } catch (err) {
        // Ignore unparseable files
      }
    }
  });
  
  console.log(`Built report mapping with ${reportMap.size} unique source files.`);
  
  // Seed the parent BatchRuns table
  const batchId = 'SEEDED_DOWNLOADS_BATCH';
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate)
      VALUES (?, ?, ?, ?)
    `).run(batchId, timestamp, 180, 1.0);
    console.log(`✓ Parent BatchRuns entry seeded successfully or already existed.`);
  } catch (err) {
    console.error('Failed to insert into BatchRuns:', err.message);
  }
  
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO DeedLogs (
      BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp,
      ExtractionJson, TraverseJson, AgentTurnsJson, TrustScore, SolutionStepsJson, FileHash, POBNorthing, POBEasting
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  // List files in the target directory
  const files = fs.readdirSync(downloadDir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.pdf', '.doc', '.docx', '.txt'].includes(ext);
  }).sort();
  
  console.log(`\nProcessing ${files.length} supported files in the target directory...`);
  
  let seededCount = 0;
  let skippedNoReport = 0;
  let skippedErrorStatus = 0;
  
  for (const fileName of files) {
    const filePath = path.join(downloadDir, fileName);
    const key = fileName.toLowerCase();
    
    // Find matching reports
    const reports = reportMap.get(key);
    if (!reports || reports.length === 0) {
      skippedNoReport++;
      continue;
    }
    
    // Sort reports by processedAt descending or prefer success/skipped status
    reports.sort((a, b) => {
      // Prefer success/skipped over error
      const aScore = (a.status === 'success' || a.status === 'skipped') ? 1 : 0;
      const bScore = (b.status === 'success' || b.status === 'skipped') ? 1 : 0;
      if (aScore !== bScore) return bScore - aScore;
      return b.processedAt.localeCompare(a.processedAt);
    });
    
    const bestReport = reports[0];
    
    try {
      const rawContent = fs.readFileSync(bestReport.path, 'utf-8');
      const json = JSON.parse(rawContent);
      
      const fileHash = getFileHash(filePath);
      
      let status = 'FAIL';
      let repairStageUsed = json.repairStageUsed || json.traverse?.compassRuleApplied ? 'Stage 3.5: Compass Rule Adjusted' : 'Stage 1: Direct Traverse';
      
      if (json.status === 'success') {
        status = 'PASS';
      } else if (json.status === 'skipped') {
        status = 'SKIPPED';
        repairStageUsed = 'Non-traversable document';
      } else if (json.status === 'meander') {
        status = 'MEANDER';
      } else {
        // If the report status is error, but we want to seed it anyway as FAIL, we can
        // But let's only seed if it's PASS, MEANDER or SKIPPED to build a clean cache.
        skippedErrorStatus++;
        continue;
      }
      
      const parcelName = json.extraction?.classification 
        ? `[${json.extraction.classification}] ${path.parse(fileName).name}`
        : (status === 'SKIPPED' ? `[SKIPPED] ${path.parse(fileName).name}` : path.parse(fileName).name);
        
      const courses = json.extraction?.courses || [];
      const geoCallCount = courses.length;
      const linearError = json.traverse?.closure?.linearError ?? 0;
      const precRatioStr = json.traverse?.closure?.precisionRatio ?? '1:100000';
      const precisionRatio = parsePrecisionRatio(precRatioStr);
      
      const extractionJson = json.extraction ? JSON.stringify(json.extraction) : null;
      const traverseJson = json.traverse ? JSON.stringify(json.traverse) : null;
      const agentTurnsJson = JSON.stringify(json.agentTurns || []);
      const trustScore = json.trustScore || null;
      const solutionStepsJson = JSON.stringify(json.solutionSteps || null);
      
      insertStmt.run(
        batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, timestamp,
        extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson, fileHash, 5000, 5000
      );
      
      seededCount++;
    } catch (err) {
      console.error(`Error processing report for ${fileName}:`, err.message);
    }
  }
  
  console.log(`\n=========================================`);
  console.log(`SEEDING DRIVE-DOWNLOAD CACHE SUMMARY`);
  console.log(`=========================================`);
  console.log(`Total target files check:        ${files.length}`);
  console.log(`Successfully seeded into cache:   ${seededCount}`);
  console.log(`Skipped (no report found):        ${skippedNoReport}`);
  console.log(`Skipped (report was error status):${skippedErrorStatus}`);
  console.log(`=========================================\n`);
}

main().catch(err => console.error(err));
