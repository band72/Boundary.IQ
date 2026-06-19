import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import fs from 'fs/promises';
import pLimit from 'p-limit';
import { runRepairPipeline } from '../services/repair.js';
import * as geminiVision from '../services/geminiVision.js';
import * as db from '../services/diagnosticsDb.js';
import crypto from 'crypto';
import * as output from '../services/output.js';

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

const args = process.argv.slice(2);
let limit = null;
let concurrency = 1; // Cap at 1 for local models

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--limit=')) {
    limit = parseInt(args[i].split('=')[1], 10);
  } else if (args[i] === '--limit' && args[i + 1]) {
    limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i].startsWith('--concurrency=')) {
    concurrency = parseInt(args[i].split('=')[1], 10);
  } else if (args[i] === '--concurrency' && args[i + 1]) {
    concurrency = parseInt(args[i + 1], 10);
    i++;
  }
}

const FAILED_DEEDS_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/_FAILED/_extracted';
const RESULTS_OUTPUT_PATH = path.resolve(__dirname, 'test_failed_deeds_nocache_results.json');

async function main() {
  try {
    db.init();
  } catch (err) {
    console.warn('⚠️ Diagnostics DB initialization warning:', err.message);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ Error: GEMINI_API_KEY is not defined in .env');
    process.exit(1);
  }
  
  geminiVision.init(apiKey);
  const provider = process.env.ACTIVE_PROVIDER || 'ollama';
  const model = process.env.ACTIVE_MODEL || 'gemma3:4b';
  geminiVision.setProvider(provider, model);

  console.log('===========================================================');
  console.log('       ANTIGRAVITY BATCH DEED SCANNER (NO-CACHE RUN)       ');
  console.log('===========================================================');
  console.log(`LLM Provider:   ${geminiVision.getActiveProvider()}`);
  console.log(`LLM Model:      ${geminiVision.getActiveModel()}`);
  console.log(`Concurrency:    ${concurrency}`);
  console.log(`Source Folder:  ${FAILED_DEEDS_DIR}`);
  
  let files;
  try {
    const allFiles = await fs.readdir(FAILED_DEEDS_DIR);
    files = allFiles.filter(f => f.toLowerCase().endsWith('.txt')).sort();
  } catch (err) {
    console.error(`❌ Error scanning source directory:`, err.message);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log('⚠️ No text files found.');
    process.exit(0);
  }

  if (limit !== null) {
    console.log(`Limit:          Processing first ${limit} of ${files.length} files`);
    files = files.slice(0, limit);
  } else {
    console.log(`Total Files:    Processing all ${files.length} files`);
  }
  console.log('===========================================================\n');

  const outputFolder = output.createOutputFolder(FAILED_DEEDS_DIR);
  const startBatchTime = Date.now();
  const limitFn = pLimit(concurrency);
  const results = [];
  const batchId = 'BATCH_NOCACHE_' + Date.now();

  const tasks = files.map((file, idx) => {
    return limitFn(async () => {
      const filePath = path.join(FAILED_DEEDS_DIR, file);
      const startTime = Date.now();
      
      try {
        const text = await fs.readFile(filePath, 'utf-8');
        const buffer = Buffer.from(text, 'utf-8');
        
        const pob = { northing: 5000, easting: 5000 };
        const units = 'Feet';
        const isOpenEnded = false;
        const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

        // ALWAYS run the real pipeline (no cache)
        const res = await runRepairPipeline(buffer, 'text/plain', pob, units, isOpenEnded, file);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        const linearError = res.finalTraverse?.closure?.linearError || 0;
        const precisionRatio = parsePrecisionRatio(res.finalTraverse?.closure?.precisionRatio);
        
        // Save log to db
        db.saveDeedLog(
          batchId,
          file,
          'SUBJECT PARCEL',
          res.finalExtraction?.courses?.length || 0,
          linearError,
          precisionRatio,
          res.status,
          res.repairStageUsed,
          JSON.stringify(res.finalExtraction || {}),
          res.finalTraverse ? JSON.stringify(res.finalTraverse) : null,
          res.agentTurns ? JSON.stringify(res.agentTurns) : null,
          res.trustScore ?? null,
          res.solutionSteps ? JSON.stringify(res.solutionSteps) : null,
          null, null, null, pob.northing, pob.easting,
          fileHash
        );

        const mappedResult = {
          status: res.status,
          error: res.traverseError || null,
          extraction: res.finalExtraction,
          traverse: res.finalTraverse,
          originalExtraction: res.originalExtraction,
        };

        let writeResult = null;
        if (mappedResult.extraction?.courses?.length > 0) {
          try {
            const legalWriter = await import('../services/legalWriter.js');
            writeResult = {
              legalDescription: legalWriter.write({
                courses: mappedResult.extraction.courses,
                pobNorthing: pob.northing,
                pobEasting: pob.easting,
                county: mappedResult.extraction.county || 'Unknown County',
                state: mappedResult.extraction.state || 'Unknown State',
                units: units.toLowerCase(),
                areaAcres: mappedResult.traverse?.areaAcres,
                perimeter: mappedResult.traverse?.perimeter
              }),
              courseCount: mappedResult.extraction.courses.length
            };
          } catch {}
        }
        await output.writeResultFiles(outputFolder, file, mappedResult, writeResult, false, false, 'arc', 'auto');

        const status = res.status;
        const stage = res.repairStageUsed;
        const origCount = res.originalExtraction?.courses?.length || 0;
        const finalCount = res.finalExtraction?.courses?.length || 0;
        const precision = res.finalTraverse?.closure?.precisionRatio || 'N/A';
        const area = res.finalTraverse?.areaAcres;

        console.log(`[${status}] (${idx + 1}/${files.length}) ${file} in ${elapsed}s | Stage: ${stage} | Error: ${linearError != null ? linearError.toFixed(4) + ' ft' : 'N/A'} | Precision: ${precision}`);

        results.push({
          file,
          status,
          stage,
          originalCourses: origCount,
          finalCourses: finalCount,
          linearError: linearError != null ? parseFloat(linearError.toFixed(4)) : null,
          precision,
          area: area != null ? parseFloat(area.toFixed(4)) : null,
          duration: parseFloat(elapsed),
          errorMsg: res.traverseError || null,
          extraction: res.finalExtraction,
          traverse: res.finalTraverse,
        });

      } catch (err) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`[ERROR] (${idx + 1}/${files.length}) ${file} failed in ${elapsed}s:`, err.message);
        results.push({
          file,
          status: 'ERROR',
          stage: 'None',
          originalCourses: 0,
          finalCourses: 0,
          linearError: null,
          precision: 'N/A',
          area: null,
          duration: parseFloat(elapsed),
          errorMsg: err.message,
        });
      }
    });
  });

  await Promise.all(tasks);

  const totalDuration = ((Date.now() - startBatchTime) / 1000).toFixed(1);
  console.log('\n===========================================================');
  console.log('                       SUMMARY TABLE                       ');
  console.log('===========================================================');
  console.table(results.map(r => ({
    'File': r.file,
    'Status': r.status,
    'Stage': r.stage,
    'Orig C': r.originalCourses,
    'Final C': r.finalCourses,
    'Err (ft)': r.linearError ?? 'N/A',
    'Precision': r.precision,
    'Area (Ac)': r.area ?? 'N/A',
    'Time (s)': r.duration,
  })));

  const total = results.length;
  const passed = results.filter(r => r.status === 'PASS').length;
  const meanders = results.filter(r => r.status === 'MEANDER').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const errors = results.filter(r => r.status === 'ERROR').length;
  
  const validErrors = results.filter(r => r.linearError != null).map(r => r.linearError);
  const avgError = validErrors.length > 0 
    ? (validErrors.reduce((sum, val) => sum + val, 0) / validErrors.length).toFixed(4)
    : 'N/A';

  console.log('\n===========================================================');
  console.log('                        STATISTICS                         ');
  console.log('===========================================================');
  console.log(`Total Processed:    ${total}`);
  console.log(`Passed (Closed):    ${passed} (${((passed/total)*100).toFixed(1)}%)`);
  console.log(`Meanders (Water):   ${meanders} (${((meanders/total)*100).toFixed(1)}%)`);
  console.log(`Failed (Open):      ${failed} (${((failed/total)*100).toFixed(1)}%)`);
  console.log(`Errors (Crashed):   ${errors} (${((errors/total)*100).toFixed(1)}%)`);
  console.log(`Avg Linear Error:   ${avgError} ft (across non-null runs)`);
  console.log(`Total Duration:     ${totalDuration} seconds`);
  console.log('===========================================================');

  try {
    const outputData = {
      timestamp: new Date().toISOString(),
      llmProvider: provider,
      llmModel: model,
      stats: {
        total,
        passed,
        meanders,
        failed,
        errors,
        avgError: avgError !== 'N/A' ? parseFloat(avgError) : null,
        totalDurationSec: parseFloat(totalDuration),
      },
      results,
    };
    await fs.writeFile(RESULTS_OUTPUT_PATH, JSON.stringify(outputData, null, 2), 'utf-8');
    console.log(`✓ Full results report saved to: ${RESULTS_OUTPUT_PATH}\n`);
  } catch (err) {
    console.error(`⚠️ Failed to save results:`, err.message);
  }
  process.exit(0);
}

main();
