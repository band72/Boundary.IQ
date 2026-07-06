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
import { userSettingsStore } from '../services/db/context.js';

const log = createChildLogger('batchDeed');
const router = Router();
router.use(requireAuth);

const PLAN_MAX_FILE_SIZE = {
  free: 0.5 * 1024 * 1024,
  basic: 1.0 * 1024 * 1024,
  pro: 10.0 * 1024 * 1024,
  enterprise: 20.0 * 1024 * 1024
};

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
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${uniqueSuffix}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 51 * 1024 * 1024 }
}); // 51MB per file

const MAX_FILE_SIZE = 51 * 1024 * 1024;
const PER_DEED_TIMEOUT_MS = 3 * 60 * 1000; // 3 min max per deed — prevents a single hung file from stalling the batch

function normalizeMime(file) {
  const mime = (file.mimetype || '').toLowerCase();
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
router.post('/process', upload.array('images', 20), async (req, res) => {
  let keepAlive = null;
  let hasLock = false;
  let files = [];
  try {
    const store = userSettingsStore.getStore();
    if (store) store.aiRequestType = 'batch-deed';

    if (!lockService.acquire('batchdeed-process', 'upload')) {
      const info = lockService.status();
      return res.status(503).json({
        error: `Server is already processing (${info.type || 'unknown'} — ${info.elapsedSec || 0}s elapsed). Please wait for it to finish.`
      });
    }
    hasLock = true;

    files = req.files || [];
    if (!files || files.length === 0) {
      if (hasLock) lockService.release('batchdeed-process');
      return res.status(400).json({ error: 'No images provided.' });
    }
    if (files.length > 20) {
      if (hasLock) lockService.release('batchdeed-process');
      return res.status(400).json({ error: 'Maximum 20 images per batch.' });
    }

    // Check file extension limits
    const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'doc', 'docx', 'txt'];
    for (const f of files) {
      const ext = (f.originalname || '').split('.').pop()?.toLowerCase();
      if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
        if (hasLock) lockService.release('batchdeed-process');
        // Clean up uploaded files
        for (const fileToClean of files) {
          if (fileToClean.path && fs.existsSync(fileToClean.path)) {
            fs.unlinkSync(fileToClean.path);
          }
        }
        return res.status(400).json({
          error: `Unsupported file format. Supported formats: ${ALLOWED_EXTENSIONS.join(', ')}.`,
          code: 'UNSUPPORTED_FILE_FORMAT'
        });
      }
    }

    // Check file size limits based on billing plan
    const userPlan = req.user.plan || 'free';
    const maxSizeBytes = PLAN_MAX_FILE_SIZE[userPlan] || PLAN_MAX_FILE_SIZE.free;
    for (const f of files) {
      if (f.size > maxSizeBytes) {
        if (hasLock) lockService.release('batchdeed-process');
        // Clean up uploaded files
        for (const fileToClean of files) {
          if (fileToClean.path && fs.existsSync(fileToClean.path)) {
            fs.unlinkSync(fileToClean.path);
          }
        }
        const planLimitStr = userPlan === 'free' ? '0.5 MB' : userPlan === 'basic' ? '1.0 MB' : userPlan === 'pro' ? '10 MB' : '20 MB';
        return res.status(400).json({
          error: `File size limit exceeded. Your plan (${userPlan}) allows files up to ${planLimitStr}.`,
          code: 'FILE_SIZE_LIMIT_EXCEEDED'
        });
      }
    }

    // Check daily credit limits based on number of uploaded files
    const creditCheck = await db.checkDailyLimit(req.user.id, req.user.plan, req.user.role, files.length);
    if (!creditCheck.allowed) {
      if (hasLock) lockService.release('batchdeed-process');
      // Clean up uploaded files
      for (const f of files) {
        if (f.path && fs.existsSync(f.path)) {
          fs.unlinkSync(f.path);
        }
      }
      return res.status(429).json({
        error: 'Daily credit limit reached.',
        code: 'DAILY_LIMIT_REACHED',
        used: creditCheck.used,
        limit: creditCheck.limit,
        requested: files.length,
        upgradeUrl: '/billing',
        message: req.user.plan === 'free'
          ? `This batch requires ${files.length} credits, but you only have ${creditCheck.limit - creditCheck.used} free credits remaining today. Upgrade to Pro for more solves.`
          : `This batch requires ${files.length} credits, but you only have ${creditCheck.limit - creditCheck.used} credits remaining today under your ${req.user.plan} plan.`,
      });
    }

    // Increment usage counter for all files in the batch
    await db.incrementDailyUsage(req.user.id, files.length);

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

    await db.saveBatchRun(batchId, files.length, 0.0);

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
    const active = 0;
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
        const solvedCase = await db.findSolvedCase(fileName, fileHash);
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
          await db.saveDeedLog(batchId, fileName, solvedCase.parcelName || 'CACHED',
            courses.length, linErr,
            parsePrecisionRatio(precRatio), 'PASS', 'Stage 5: SQLite Case Finder Solved',
            solvedCase.extractionJson, solvedCase.traverseJson,
            solvedCase.agentTurnsJson ?? null, solvedCase.trustScore ?? null, solvedCase.solutionStepsJson ?? null,
            refName, refN, refE, pobN, pobE, fileHash);
          await db.incrementHeuristic('SQLite Case Finder Solved', 'Auto-retrieve Solved Boundary');
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
          await db.saveDeedLog(batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
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

        await db.saveDeedLog(batchId, fileName, parcelLabel, extraction.courses?.length || 0,
          linearError, precisionRatio, status, stageUsed,
          JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null,
          agentTurnsJson, repairResult.trustScore ?? null,
          repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null,
          refName, refN, refE, pobN, pobE, fileHash);

        if (extraction.courses?.length > 0) await db.incrementHeuristic(stageUsed, 'Auto-repair pipeline');
      } catch (ex) {
        log.error({ fileName, err: ex.message }, 'Batch item failed');
        results[index] = { fileName, status: 'error', extraction: null, traverse: null, legalDescription: null, error: ex.message, fileHash, agentTurns: null };
        await db.saveDeedLog(batchId, fileName, 'ERROR PARCEL', 0, 999, 0, 'ERROR', 'AI Extraction Error', null, null, null, null, null, refName, refN, refE, pobN, pobE, fileHash);
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
    await db.saveBatchRun(batchId, results.length, passRate);

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

// ── Multer / form-data error handler ────────────────────────────────────────
// Catches 'Unexpected end of form', MulterError (LIMIT_FILE_SIZE, LIMIT_FILE_COUNT),
// and other multipart parsing errors so they return structured JSON instead of
// Express's default HTML error page.
router.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File exceeds the server-side 51 MB hard limit.', code: 'FILE_TOO_LARGE' });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Maximum 20 files per batch.', code: 'TOO_MANY_FILES' });
  }
  if (err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field.', code: 'UNEXPECTED_FIELD' });
  }
  if (err?.message?.includes('Unexpected end of form') || err?.message?.includes('multipart')) {
    return res.status(400).json({ error: 'No images provided or malformed multipart request.', code: 'INVALID_FORM' });
  }
  // Pass other errors to Express default handler
  next(err);
});

export default router;
