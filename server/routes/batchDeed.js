// ─── Batch Deed Route ───────────────────────────────────────────────────────
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runRepairPipeline } from '../services/Scripting/repair.js';
import * as legalWriter from '../services/Scripting/legalWriter.js';
import * as db from '../services/diagnosticsDb.js';
import { isWordDocument, convertToPdf } from '../services/docConversion.js';
import { resolvePathCaseInsensitive } from '../services/pathUtils.js';
import * as geminiVision from '../services/geminiVision.js';
import crypto from 'crypto';
import * as lockService from '../services/lockService.js';
import { requireAuth, trackDeedUsage } from '../middleware/auth.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('batchDeed');
const router = Router();
router.use(requireAuth);

const uploadsDir = process.cwd().endsWith('server')
  ? path.join(process.cwd(), 'uploads')
  : path.join(process.cwd(), 'server', 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.user?.id || 0;
    const userDirName = String(userId).padStart(6, '0');
    const userUploadsDir = path.join(uploadsDir, userDirName);
    if (!fs.existsSync(userUploadsDir)) {
      fs.mkdirSync(userUploadsDir, { recursive: true });
    }
    cb(null, userUploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = uuidv4();
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 51 * 1024 * 1024 }
}); // 51MB per file

const MAX_FILE_SIZE = 51 * 1024 * 1024;
const PER_DEED_TIMEOUT_MS = 3 * 60 * 1000; // 3 min max per deed — prevents a single hung file from stalling the batch

function normalizeMime(file) {
  let mime = (file.mimetype || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'image/jpeg';
  if (mime.includes('png')) return 'image/png';
  if (mime.includes('webp')) return 'image/webp';
  if (mime.includes('pdf')) return 'application/pdf';
  if (mime.includes('text') || mime.includes('plain')) return 'text/plain';
  if (mime.includes('msword') || mime.includes('wordprocessing')) return 'application/msword';
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };
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

// NOTE: This endpoint uses a process-global mutex (lockService) intentionally.
// Batch processing is CPU/memory intensive and running two batches concurrently
// on the same server risks OOM and LLM timeout collisions. Multi-user queuing
// would require a proper job queue (e.g. BullMQ) — tracked as a future enhancement.
router.post('/process', trackDeedUsage, upload.array('images', 20), async (req, res) => {
  let keepAlive = null;
  let hasLock = false;
  let files = [];
  try {
    if (!lockService.acquire('batchdeed-process', 'upload')) {
      const info = lockService.status();
      return res.status(503).json({
        error: `Server is already processing (${info.type || 'unknown'} — ${info.elapsedSec || 0}s elapsed). Please wait for it to finish.`
      });
    }
    hasLock = true;

    files = req.files || [];
    if (!files || files.length === 0) return res.status(400).json({ error: 'No images provided.' });
    if (files.length > 20) return res.status(400).json({ error: 'Maximum 20 images per batch.' });

    const pobN = parseFloat(req.query.pobN) || 5000;
    const pobE = parseFloat(req.query.pobE) || 5000;
    const refName = req.query.refName || null;
    const refN = req.query.refN != null ? parseFloat(req.query.refN) : null;
    const refE = req.query.refE != null ? parseFloat(req.query.refE) : null;
    const units = req.query.units || 'Feet';
    const county = req.query.county || null;
    const state = req.query.state || null;
    const maxTurns = Math.max(1, Math.min(5, parseInt(req.query.maxTurns) || 3)); // Fix #5

    const activeProvider = geminiVision.getActiveProvider();
    const isLocalLLM = activeProvider === 'ollama' || activeProvider === 'openai';
    const concurrency = isLocalLLM ? 1 : (parseInt(req.query.concurrency) || 5);

    if (isLocalLLM && parseInt(req.query.concurrency) > 1) {
      log.warn({ provider: activeProvider, requested: req.query.concurrency }, 'Local provider active — capping BatchDeed concurrency to 1 to prevent OOM/timeouts');
    }

    const batchId = uuidv4();
    const results = new Array(files.length);

    db.saveBatchRun(batchId, files.length, 0.0);

    // Start keepalive heartbeat immediately to prevent idle connection timeout
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    keepAlive = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(keepAlive);
        return;
      }
      try {
        res.write(' '); // write standard whitespace spacer to keep connection active
        if (res.flush) res.flush();
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);

    // Process with concurrency limiter
    let active = 0;
    const queue = files.map((file, index) => async () => {
      const fileName = file.originalname;
      log.info({ fileName, index }, 'Batch item started');
      let fileHash = null;

      try {
        if (file.size > MAX_FILE_SIZE)
          throw new Error(`File exceeds 51 MB (${(file.size / 1024 / 1024).toFixed(1)} MB).`);

        if (!file.path || !fs.existsSync(file.path)) {
          throw new Error('File not found on server disk.');
        }

        const fileBytes = fs.readFileSync(file.path);
        fileHash = crypto.createHash('sha256').update(fileBytes).digest('hex');

        // Check cache
        const solvedCase = db.findSolvedCase(fileName, fileHash);
        if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
          log.info({ fileName, hash: fileHash.slice(0, 8) }, 'SQLite Case Finder: cache hit — reusing solved case');
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

           results[index] = {
            fileName, status: 'success',
            extraction: cachedExtraction, traverse: cachedTraverse,
            legalDescription: cachedWriteResult, error: null,
            fileHash, 
            agentTurns: solvedCase.agentTurnsJson ? JSON.parse(solvedCase.agentTurnsJson) : null,
            solutionSteps: solvedCase.solutionStepsJson ? JSON.parse(solvedCase.solutionStepsJson) : null
          };
          const linErr = cachedTraverse.closure?.linearError ?? cachedTraverse.Closure?.LinearError ?? 0;
          const precRatio = cachedTraverse.closure?.precisionRatio ?? cachedTraverse.Closure?.PrecisionRatio ?? '';
          db.saveDeedLog(batchId, fileName, solvedCase.parcelName || 'CACHED',
            courses.length, linErr,
            parsePrecisionRatio(precRatio), 'PASS', 'Stage 5: SQLite Case Finder Solved',
            solvedCase.extractionJson, solvedCase.traverseJson,
            solvedCase.agentTurnsJson ?? null, solvedCase.trustScore ?? null, solvedCase.solutionStepsJson ?? null,
            refName, refN, refE, pobN, pobE, fileHash);
          db.incrementHeuristic('SQLite Case Finder Solved', 'Auto-retrieve Solved Boundary');
          return;
        }

        let imageBytes = fileBytes;
        let mime = normalizeMime(file);

        // Word doc conversion
        if (isWordDocument(fileName)) {
          log.info({ fileName }, 'Converting Word doc to PDF via LibreOffice');
          try {
            imageBytes = await convertToPdf(imageBytes, fileName);
            mime = 'application/pdf';
          } catch (err) {
            log.warn({ fileName, err: err.message }, 'LibreOffice conversion failed — checking for pre-extracted text fallback');
            const base = path.parse(fileName).name;
            const wordDocTrainingDir = process.env.WORD_DOC_TRAINING_DIR || '';
            const trainingBase = wordDocTrainingDir
              ? resolvePathCaseInsensitive(path.join(wordDocTrainingDir, '_extracted', base + '.txt'))
              : '';
            if (trainingBase && fs.existsSync(trainingBase)) {
              log.info({ fileName, fallback: trainingBase }, 'Using pre-extracted text fallback');
              imageBytes = fs.readFileSync(trainingBase);
              mime = 'text/plain';
            } else {
              throw err;
            }
          }
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

        const isNonTraversable = (!extraction.courses || extraction.courses.length === 0) &&
          (['PLAT', 'LOT_BLOCK', 'SECTION_BREAKDOWN'].includes(extraction.classification) ||
           (repairResult.traverseError || '').toLowerCase().includes('no traversable') ||
           (repairResult.traverseError || '').toLowerCase().includes('zero segment') ||
           !geminiVision.hasBoundaryKeywords(extraction.rawText || extraction.rawJson || ''));

        if (isNonTraversable) {
          results[index] = {
            fileName, status: 'skipped',
            extraction, traverse: null, legalDescription: null,
            error: null, skipReason: `Non-traversable: ${extraction.classification}`,
            conceptualAnalysis: extraction.conceptualAnalysis || null,
            fileHash, agentTurns: null
          };
          db.saveDeedLog(batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
            'SKIPPED', 'Non-traversable document', JSON.stringify(extraction), null, null, null, null,
            refName, refN, refE, pobN, pobE, fileHash);
          return;
        }

        results[index] = {
          fileName, status: status === 'PASS' || status === 'MEANDER' ? 'success' : 'error',
          extraction, traverse, legalDescription: writeResult,
          error: repairResult.traverseError, originalExtraction: repairResult.originalExtraction,
          // Fix #11 / Fix #12: Surface trust score and bust index
          trustScore: repairResult.trustScore ?? null,
          trustLevel: repairResult.trustLevel ?? null,
          trustFlags: repairResult.trustFlags || [],
          bustCourseIndex: repairResult.bustCourseIndex ?? null,
          mentalMapSummary: extraction.mentalMapSummary || null,
          agentTurns: repairResult.agentTurns || null,
          fileHash
        };

        const linearError = traverse?.closure?.linearError || 0;
        const precisionRatio = parsePrecisionRatio(traverse?.closure?.precisionRatio);
        const parcelLabel = county && state ? `${county}, ${state}` : `[${extraction.classification}] SUBJECT PARCEL`;
        // Fix #12: persist agent turn telemetry and trust score
        const agentTurnsJson = repairResult.agentTurns?.length ? JSON.stringify(repairResult.agentTurns) : null;

        db.saveDeedLog(batchId, fileName, parcelLabel, extraction.courses?.length || 0,
          linearError, precisionRatio, status, stageUsed,
          JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null,
          agentTurnsJson, repairResult.trustScore ?? null,
          repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null,
          refName, refN, refE, pobN, pobE, fileHash);

        if (extraction.courses?.length > 0) db.incrementHeuristic(stageUsed, 'Auto-repair pipeline');
      } catch (ex) {
        log.error({ fileName, err: ex.message }, 'Batch item failed');
        results[index] = { fileName, status: 'error', extraction: null, traverse: null, legalDescription: null, error: ex.message, fileHash, agentTurns: null };
        db.saveDeedLog(batchId, fileName, 'ERROR PARCEL', 0, 999, 0, 'ERROR', 'AI Extraction Error', null, null, null, null, null, refName, refN, refE, pobN, pobE, fileHash);
      } finally {
        try {
          if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
            log.info({ fileName }, 'Cleaned up uploaded file from server disk');
          }
        } catch (cleanupErr) {
          log.warn({ fileName, err: cleanupErr.message }, 'Failed to clean up uploaded file');
        }
      }
    });

    // Run with concurrency — each deed gets a hard 3-minute wall-clock limit
    const sem = new lockService.FifoSemaphore(concurrency);
    await Promise.all(queue.map(async (fn, idx) => {
      await sem.acquire();
      try {
        await Promise.race([
          fn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Per-deed timeout (${PER_DEED_TIMEOUT_MS / 1000}s) exceeded`)), PER_DEED_TIMEOUT_MS)
          ),
        ]);
      } catch (timeoutErr) {
        // Timeout or unhandled throw — log and mark failed so batch continues
        const fileName = files[idx]?.originalname || `file[${idx}]`;
        log.error({ fileName, err: timeoutErr.message }, 'Deed timed out or failed');
        if (!results[idx]) {
          let timeoutHash = null;
          try {
            if (files[idx]?.path && fs.existsSync(files[idx].path)) {
              timeoutHash = crypto.createHash('sha256').update(fs.readFileSync(files[idx].path)).digest('hex');
            }
          } catch {}
          results[idx] = { fileName, status: 'error', extraction: null, traverse: null, legalDescription: null, error: timeoutErr.message, fileHash: timeoutHash, agentTurns: null };
        }
      } finally {
        sem.release();
      }
    }));

    const succeeded = results.filter(r => r?.status === 'success').length;
    const passRate = results.length > 0 ? succeeded / results.length : 0;
    db.saveBatchRun(batchId, results.length, passRate);

    if (keepAlive) clearInterval(keepAlive);
    res.write(JSON.stringify({ results, totalProcessed: results.length, succeeded, failed: results.length - succeeded }));
    res.end();
  } catch (ex) {
    if (keepAlive) clearInterval(keepAlive);
    log.error({ err: ex.message }, 'Batch process top-level error');
    if (res.headersSent) {
      res.write(JSON.stringify({ error: ex.message }));
      res.end();
    } else {
      res.status(500).json({ error: ex.message });
    }
  } finally {
    if (hasLock) {
      lockService.release();
    }
    // Clean up any remaining files that were uploaded but not deleted yet
    if (files && files.length > 0) {
      for (const file of files) {
        try {
          if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch {}
      }
    }
  }
});

export default router;
