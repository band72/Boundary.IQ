import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import fs from 'fs/promises';
import { runRepairPipeline } from '../services/repair.js';
import * as geminiVision from '../services/geminiVision.js';
import * as db from '../services/diagnosticsDb.js';
import crypto from 'crypto';
import * as output from '../services/output.js';
import * as legalWriter from '../services/legalWriter.js';

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

const SCREENSHOTS_DIR = '/home/artwalk/Pictures/Screenshots';

async function main() {
  // 1. Initialize Database
  try {
    db.init();
  } catch (err) {
    console.warn('⚠️ Diagnostics DB warning:', err.message);
  }

  // 2. Initialize and configure LLM provider (use gemini for speed if key is available)
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ Error: GEMINI_API_KEY is not defined in .env');
    process.exit(1);
  }
  
  geminiVision.init(apiKey);
  // Default to gemini-2.5-flash or gemini-3.5-flash
  const provider = 'gemini';
  const model = 'gemini-2.5-flash';
  geminiVision.setProvider(provider, model);

  console.log('===========================================================');
  console.log('        TESTING DEEDS IN SCREENSHOTS DIRECTORY             ');
  console.log('===========================================================');
  console.log(`LLM Provider:   ${provider}`);
  console.log(`LLM Model:      ${model}`);
  console.log(`Source Folder:  ${SCREENSHOTS_DIR}`);
  console.log('===========================================================\n');

  // 3. Scan directory for files
  let files;
  try {
    const allFiles = await fs.readdir(SCREENSHOTS_DIR);
    files = allFiles.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return ['.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(ext);
    }).sort();
  } catch (err) {
    console.error(`❌ Error scanning source directory:`, err.message);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log('⚠️ No image or PDF files found in Screenshots.');
    process.exit(0);
  }

  const outputFolder = output.createOutputFolder(SCREENSHOTS_DIR);
  const startBatchTime = Date.now();
  const results = [];
  const batchId = 'SCREENSHOT_TEST_' + Date.now();

  try {
    db.saveBatchRun(batchId, files.length, 0.0);
  } catch {}

  // Process sequentially to avoid rate limits and keep output clear
  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    const filePath = path.join(SCREENSHOTS_DIR, file);
    const startTime = Date.now();
    console.log(`\n⏳ Processing (${idx + 1}/${files.length}): ${file}...`);

    try {
      const buffer = await fs.readFile(filePath);
      const ext = path.extname(file).toLowerCase();
      const mimeType = ext === '.pdf' ? 'application/pdf' : `image/${ext.slice(1)}`;
      const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

      const pob = { northing: 5000, easting: 5000 };
      const units = 'Feet';
      const isOpenEnded = false;

      // Check cache first
      const solvedCase = db.findSolvedCase(file, fileHash);
      let res;
      let isCacheHit = false;

      if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
        isCacheHit = true;
        const cachedEx = JSON.parse(solvedCase.extractionJson);
        const cachedTr = JSON.parse(solvedCase.traverseJson);
        
        res = {
          status: solvedCase.status || 'PASS',
          repairStageUsed: solvedCase.repairStageUsed || 'SQLite Case Finder Solved',
          originalExtraction: cachedEx,
          finalExtraction: cachedEx,
          finalTraverse: cachedTr,
          traverseError: null,
          trustScore: solvedCase.trustScore ?? 100,
        };
      } else {
        res = await runRepairPipeline(buffer, mimeType, pob, units, isOpenEnded, file);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const status = res.status;
      const stage = res.repairStageUsed;
      const origCount = res.originalExtraction?.courses?.length || 0;
      const finalCount = res.finalExtraction?.courses?.length || 0;
      const linearError = res.finalTraverse?.closure?.linearError;
      const precision = res.finalTraverse?.closure?.precisionRatio || 'N/A';
      const area = res.finalTraverse?.areaAcres;

      console.log(`${isCacheHit ? '[CACHE HIT] ' : ''}[${status}] ${file} completed in ${elapsed}s | Stage: ${stage} | Error: ${linearError != null ? linearError.toFixed(4) + ' ft' : 'N/A'} | Precision: ${precision}`);

      // Save log to DB
      if (!isCacheHit) {
        db.saveDeedLog(
          batchId, file, 'SUBJECT PARCEL', finalCount,
          linearError || 0, parsePrecisionRatio(precision), status, stage,
          JSON.stringify(res.finalExtraction || {}),
          res.finalTraverse ? JSON.stringify(res.finalTraverse) : null,
          res.agentTurns ? JSON.stringify(res.agentTurns) : null,
          res.trustScore ?? null,
          res.solutionSteps ? JSON.stringify(res.solutionSteps) : null,
          null, null, null, pob.northing, pob.easting, fileHash
        );
      }

      // Write result deliverables
      const mappedResult = {
        status: res.status,
        error: res.traverseError || null,
        extraction: res.finalExtraction,
        traverse: res.finalTraverse,
        originalExtraction: res.originalExtraction,
        conceptualAnalysis: res.conceptualAnalysis || res.finalExtraction?.conceptualAnalysis || null
      };

      let writeResult = null;
      if (mappedResult.extraction?.courses?.length > 0) {
        try {
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
        } catch (wErr) {
          console.warn(`[WARN] Failed to write legal description:`, wErr.message);
        }
      }

      await output.writeResultFiles(outputFolder, file, mappedResult, writeResult, false, false, 'arc', 'auto');

      results.push({
        file, status, stage,
        originalCourses: origCount,
        finalCourses: finalCount,
        linearError: linearError != null ? parseFloat(linearError.toFixed(4)) : null,
        precision,
        area: area != null ? parseFloat(area.toFixed(4)) : null,
        duration: parseFloat(elapsed),
        errorMsg: res.traverseError || null,
      });

    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`❌ [ERROR] ${file} failed in ${elapsed}s:`, err.message);
      results.push({
        file, status: 'ERROR', stage: 'None',
        originalCourses: 0, finalCourses: 0,
        linearError: null, precision: 'N/A', area: null,
        duration: parseFloat(elapsed), errorMsg: err.message,
      });
    }
  }

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

  // Write final summaries
  try {
    const mappedResultsForSummary = results.map(r => ({
      ...r,
      fileName: r.file,
      error: r.errorMsg,
      status: r.status === 'PASS' ? 'success' : (r.status === 'MEANDER' ? 'success' : 'error')
    }));
    output.writeBatchSummary(outputFolder, SCREENSHOTS_DIR, mappedResultsForSummary, Date.now() - startBatchTime);
    await output.writeCombinedBatchPdf(outputFolder);
    console.log(`\n🎉 Deliverables generated at: ${outputFolder}`);
  } catch (err) {
    console.error(`⚠️ Failed to generate batch summaries:`, err.message);
  }

  process.exit(0);
}

main();
