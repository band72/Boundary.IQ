import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { init as initDb, getDb, saveDeedLog, saveBatchRun } from '../services/diagnosticsDb.js';

const FAILED_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/_FAILED';
const EXTRACTED_DIR = path.join(FAILED_DIR, '_extracted');
const BATCH_ID = 'MANUAL_TRAINING_SEED';

function getFileHash(filePath) {
  try {
    const buffer = readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch (err) {
    console.error(`Error hashing file ${filePath}:`, err.message);
    return null;
  }
}

function parsePrecisionRatio(precisionStr) {
  if (!precisionStr) return 0;
  try {
    const parts = precisionStr.split(':');
    if (parts.length > 1) {
      const cleaned = parts[1].replace(/,/g, '').replace('∞', '999999999').trim();
      const val = parseFloat(cleaned);
      if (!isNaN(val)) return val;
    }
  } catch {}
  return 0;
}

async function getSummaryFiles(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '_extracted') {
        const subResults = await getSummaryFiles(fullPath);
        results.push(...subResults);
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('summary.json')) {
      results.push(fullPath);
    }
  }
  return results;
}

async function main() {
  console.log('Initializing Diagnostics Database...');
  initDb();
  const db = getDb();

  // Create seed batch run entry
  db.prepare('INSERT OR REPLACE INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate) VALUES (?, ?, ?, ?)')
    .run(BATCH_ID, new Date().toISOString().replace('T', ' ').slice(0, 19), 84, 1.0);

  console.log('Scanning manual correction directories recursively...');
  const summaryFiles = await getSummaryFiles(FAILED_DIR);
  console.log(`Found ${summaryFiles.length} summary files to process.`);

  let count = 0;
  let skippedCount = 0;
  let failCount = 0;

  for (const summaryPath of summaryFiles) {
    const summaryFile = path.basename(summaryPath);
    try {
      const content = await fs.readFile(summaryPath, 'utf-8');
      const summary = JSON.parse(content);

      const sourceFile = summary.sourceFile;
      if (!sourceFile) {
        console.warn(`⚠️ Skipping ${summaryFile}: no sourceFile specified in summary.`);
        continue;
      }

      // Determine status
      let status = 'PASS';
      if (summary.status === 'skipped') {
        status = 'SKIPPED';
      } else if (summary.status === 'error' || summary.status === 'fail') {
        status = 'FAIL';
      }

      const repairStage = status === 'PASS' ? 'Stage 5: Manual Correction' : (status === 'SKIPPED' ? 'Manual Skip' : 'Manual Failure');

      // Locate original files to hash
      const originalPath = path.join(FAILED_DIR, sourceFile);
      const txtFileName = sourceFile.replace(/\.[^/.]+$/, '') + '.txt';
      const extractedTxtPath = path.join(EXTRACTED_DIR, txtFileName);

      const origHash = existsSync(originalPath) ? getFileHash(originalPath) : null;
      const txtHash = existsSync(extractedTxtPath) ? getFileHash(extractedTxtPath) : null;

      const extractionJson = summary.extraction ? JSON.stringify(summary.extraction) : null;
      const traverseJson = summary.traverse ? JSON.stringify(summary.traverse) : null;

      const parcelName = summary.extraction?.classification 
        ? `[${summary.extraction.classification}] MANUALLY CORRECTED`
        : 'MANUALLY CORRECTED PARCEL';
      
      const geoCallCount = summary.extraction?.courses?.length || 0;
      const linearError = summary.traverse?.closure?.linearError || 0;
      const precisionRatio = parsePrecisionRatio(summary.traverse?.closure?.precisionRatio);

      // Helper to insert and handle duplicate overwriting
      const upsertDeedLog = (fileName, fileHash) => {
        if (!fileHash) return;

        // Delete duplicate record to prevent bloat
        db.prepare('DELETE FROM DeedLogs WHERE FileName = ? AND FileHash = ?').run(fileName, fileHash);

        saveDeedLog(
          BATCH_ID,
          fileName,
          parcelName,
          geoCallCount,
          linearError,
          precisionRatio,
          status,
          repairStage,
          extractionJson,
          traverseJson,
          null, // agentTurnsJson
          100.0, // trustScore
          null, // solutionStepsJson
          null, // refName
          null, // refN
          null, // refE
          5000.0, // pobN
          5000.0, // pobE
          fileHash
        );
      };

      // Insert both source file (doc/pdf/etc) and txt file variations to guarantee matches
      if (origHash) {
        upsertDeedLog(sourceFile, origHash);
      }
      if (txtHash) {
        upsertDeedLog(txtFileName, txtHash);
      }

      if (status === 'PASS') count++;
      else if (status === 'SKIPPED') skippedCount++;
      else failCount++;

    } catch (err) {
      console.error(`❌ Failed to import summary ${summaryFile}:`, err.message);
    }
  }

  console.log('===========================================================');
  console.log('                 SEEDING SUMMARY REPORT                    ');
  console.log('===========================================================');
  console.log(`Successfully imported:`);
  console.log(`  - Passed:  ${count}`);
  console.log(`  - Skipped: ${skippedCount}`);
  console.log(`  - Failed:  ${failCount}`);
  console.log(`All entries inserted with batch ID: ${BATCH_ID}`);
  console.log('===========================================================');
}

main();
