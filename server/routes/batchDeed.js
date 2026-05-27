// ─── Batch Deed Route ───────────────────────────────────────────────────────
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { runRepairPipeline } from '../services/repair.js';
import * as legalWriter from '../services/legalWriter.js';
import * as db from '../services/diagnosticsDb.js';
import { isWordDocument, convertToPdf } from '../services/docConversion.js';
const router = Router();

const upload = multer({ limits: { fileSize: 51 * 1024 * 1024 } }); // 51MB per file

const MAX_FILE_SIZE = 51 * 1024 * 1024;

function normalizeMime(file) {
  let mime = (file.mimetype || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'image/jpeg';
  if (mime.includes('png')) return 'image/png';
  if (mime.includes('webp')) return 'image/webp';
  if (mime.includes('pdf')) return 'application/pdf';
  if (mime.includes('msword') || mime.includes('wordprocessing')) return 'application/msword';
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  return map[ext] || 'image/jpeg';
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

// POST /api/batchdeed/process
router.post('/process', upload.array('images', 20), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ error: 'No images provided.' });
    if (files.length > 20) return res.status(400).json({ error: 'Maximum 20 images per batch.' });

    const pobN = parseFloat(req.query.pobN) || 5000;
    const pobE = parseFloat(req.query.pobE) || 5000;
    const units = req.query.units || 'Feet';
    const county = req.query.county || null;
    const state = req.query.state || null;
    const concurrency = parseInt(req.query.concurrency) || 5;
    const maxTurns = Math.max(1, Math.min(5, parseInt(req.query.maxTurns) || 3)); // Fix #5

    const batchId = uuidv4();
    const results = new Array(files.length);

    db.saveBatchRun(batchId, files.length, 0.0);

    // Process with concurrency limiter
    let active = 0;
    const queue = files.map((file, index) => async () => {
      const fileName = file.originalname;
      console.log(`Batch processing: ${fileName}`);

      try {
        if (file.size > MAX_FILE_SIZE)
          throw new Error(`File exceeds 51 MB (${(file.size / 1024 / 1024).toFixed(1)} MB).`);

        // Check cache
        const solvedCase = db.findSolvedCase(fileName);
        if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
          console.log(`SQLite Case Finder: Found PASS for ${fileName}`);
          const cachedExtraction = JSON.parse(solvedCase.extractionJson);
          const cachedTraverse = JSON.parse(solvedCase.traverseJson);

          let cachedWriteResult = null;
          const courses = cachedExtraction.courses || cachedExtraction.Courses || [];
          if (courses.length > 0) {
            try {
              const text = legalWriter.write({
                courses, pobNorthing: pobN, pobEasting: pobE,
                county, state, units: units.toLowerCase(),
                areaAcres: cachedTraverse.areaAcres ?? cachedTraverse.AreaAcres ?? 0,
                perimeter: cachedTraverse.perimeter ?? cachedTraverse.Perimeter ?? 0,
              });
              cachedWriteResult = { legalDescription: text, courseCount: courses.length };
            } catch {}
          }

          results[index] = { fileName, status: 'success', extraction: cachedExtraction, traverse: cachedTraverse, legalDescription: cachedWriteResult, error: null };
          const linErr = cachedTraverse.closure?.linearError ?? cachedTraverse.Closure?.LinearError ?? 0;
          const precRatio = cachedTraverse.closure?.precisionRatio ?? cachedTraverse.Closure?.PrecisionRatio ?? '';
          db.saveDeedLog(batchId, fileName, solvedCase.parcelName || 'CACHED',
            courses.length, linErr,
            parsePrecisionRatio(precRatio), 'PASS', 'Stage 5: SQLite Case Finder Solved',
            solvedCase.extractionJson, solvedCase.traverseJson);
          db.incrementHeuristic('SQLite Case Finder Solved', 'Auto-retrieve Solved Boundary');
          return;
        }

        let imageBytes = file.buffer;
        let mime = normalizeMime(file);

        // Word doc conversion
        if (isWordDocument(fileName)) {
          console.log(`Converting Word doc ${fileName} to PDF...`);
          imageBytes = await convertToPdf(imageBytes, fileName);
          mime = 'application/pdf';
        }

        const upperName = fileName.toUpperCase();
        const isOpenEnded = ['EASEMENT', 'EAESMENT', 'EASMENT', 'ROAD', 'BLVD', 'R/W', 'RIGHT OF WAY', 'CENTERLINE'].some(k => upperName.includes(k));

        const pob = { northing: pobN, easting: pobE };
        const repairResult = await runRepairPipeline(imageBytes, mime, pob, units, isOpenEnded, fileName, maxTurns); // Fix #5

        const extraction = repairResult.finalExtraction;
        const traverse = repairResult.finalTraverse;
        const status = repairResult.status;
        const stageUsed = repairResult.repairStageUsed;

        let writeResult = null;
        if (extraction.courses?.length > 0) {
          try {
            const text = legalWriter.write({
              courses: extraction.courses, pobNorthing: pobN, pobEasting: pobE,
              county, state, units: units.toLowerCase(),
              areaAcres: traverse?.areaAcres, perimeter: traverse?.perimeter,
            });
            writeResult = { legalDescription: text, courseCount: extraction.courses.length };
          } catch {}
        }

        results[index] = {
          fileName, status: status === 'PASS' ? 'success' : 'error',
          extraction, traverse, legalDescription: writeResult,
          error: repairResult.traverseError, originalExtraction: repairResult.originalExtraction,
          // Fix #11 / Fix #12: Surface trust score and bust index
          trustScore: repairResult.trustScore ?? null,
          trustLevel: repairResult.trustLevel ?? null,
          trustFlags: repairResult.trustFlags || [],
          bustCourseIndex: repairResult.bustCourseIndex ?? null,
          mentalMapSummary: extraction.mentalMapSummary || null,
        };

        const linearError = traverse?.closure?.linearError || 0;
        const precisionRatio = parsePrecisionRatio(traverse?.closure?.precisionRatio);
        const parcelLabel = county && state ? `${county}, ${state}` : `[${extraction.classification}] SUBJECT PARCEL`;
        // Fix #12: persist agent turn telemetry and trust score
        const agentTurnsJson = repairResult.agentTurns?.length ? JSON.stringify(repairResult.agentTurns) : null;

        db.saveDeedLog(batchId, fileName, parcelLabel, extraction.courses?.length || 0,
          linearError, precisionRatio, status, stageUsed,
          JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null,
          agentTurnsJson, repairResult.trustScore ?? null);

        if (extraction.courses?.length > 0) db.incrementHeuristic(stageUsed, 'Auto-repair pipeline');
      } catch (ex) {
        console.error(`Batch item failed: ${fileName}`, ex.message);
        results[index] = { fileName, status: 'error', extraction: null, traverse: null, legalDescription: null, error: ex.message };
        db.saveDeedLog(batchId, fileName, 'ERROR PARCEL', 0, 999, 0, 'ERROR', 'AI Extraction Error', null, null);
      }
    });

    // Run with concurrency
    const semaphore = { current: 0, max: concurrency };
    await Promise.all(queue.map(async (fn) => {
      while (semaphore.current >= semaphore.max) await new Promise(r => setTimeout(r, 50));
      semaphore.current++;
      try { await fn(); } finally { semaphore.current--; }
    }));

    const succeeded = results.filter(r => r?.status === 'success').length;
    const passRate = results.length > 0 ? succeeded / results.length : 0;
    db.saveBatchRun(batchId, results.length, passRate);

    res.json({ results, totalProcessed: results.length, succeeded, failed: results.length - succeeded });
  } catch (ex) {
    console.error('Batch process error:', ex);
    res.status(500).json({ error: ex.message });
  }
});

export default router;
