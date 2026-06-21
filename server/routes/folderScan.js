// ─── Folder Scan Route ──────────────────────────────────────────────────────
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as lockService from '../services/lockService.js';
import crypto from 'crypto';
import { createChildLogger } from '../logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { runRepairPipeline, extractNamedParcels, detectOpenEnded } from '../services/repair.js';
import { resolvePathCaseInsensitive } from '../services/pathUtils.js';
import * as legalWriter from '../services/legalWriter.js';
import * as db from '../services/diagnosticsDb.js';
import { isWordDocument } from '../services/docConversion.js';
import * as output from '../services/output.js';
import * as geminiVision from '../services/geminiVision.js';
// Module-level map: base deed name → last station {northing, easting} of Part A/B etc.
// Enables multi-part deed chaining (Rec 4) without cross-request state or DB changes.
const familyEndpoints = new Map();

import * as platLookup from '../services/platLookupService.js';
import * as resolver from '../services/chainedTraverseResolver.js';
import * as plssParser from '../services/plssParser.js';
import * as traverseSvc from '../services/traverse.js';
import * as ollamaSvc from '../services/ollamaVision.js';
import { requireAuth } from '../middleware/auth.js';
import { SCAN_RATE_LIMIT, GEMINI_API_KEY } from '../config.js';

// ── Decoupled service modules ─────────────────────────────────────────────────
import {
  SUPPORTED_EXTS, SKIP_KEYWORDS,
  containsWord, classifyByFilename, getDocType,
  getSupportedFiles, inferMimeType, parsePrecisionRatio, shouldInterceptPLSS,
} from '../services/docClassifier.js';
import { ensureExtractedText, readWordDocWithFallback } from '../services/textExtractor.js';

const router = Router();
router.use(requireAuth);

// ── Per-user rate limiter for scan endpoints ───────────────────────────────
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: SCAN_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ? String(req.user.id) : ipKeyGenerator(req),
  skip: (req) => req.user?.role === 'admin',
  message: { error: `Too many scan requests. Maximum ${SCAN_RATE_LIMIT} per minute per user.` },
});

const log = createChildLogger('folderScan');

// Helper to resolve county and state for metadata/legalWriter with caching fallback
function getCountyVal(ex, fallback) {
  if (ex?.county && ex.county !== 'Unknown') return ex.county;
  if (fallback) return fallback;
  const raw = ex?.rawText || ex?.originalLegalDesc || ex?.originalLegalDescription || '';
  if (raw) return geminiVision.inferCountyStateFromText(raw).county || 'Unknown';
  return 'Unknown';
}

function getStateVal(ex, fallback) {
  if (ex?.state && ex.state !== 'Unknown') return ex.state;
  if (fallback) return fallback;
  const raw = ex?.rawText || ex?.originalLegalDesc || ex?.originalLegalDescription || '';
  if (raw) return geminiVision.inferCountyStateFromText(raw).state || 'Unknown';
  return 'Unknown';
}


const MAX_FILE_SIZE = 51 * 1024 * 1024;
const BATCH_SIZE = 5;


// ── Allowed roots (path traversal protection) ────────────────────────────────
function getAllowedRoots() {
  const envRoots = process.env.BOUNDARY_SCAN_ROOTS;
  if (envRoots) return envRoots.split(';').filter(Boolean).map(r => path.resolve(r.trim()));
  return [os.homedir()];
}

/**
 * Normalize a client-supplied path for server-side validation.
 *
 * Two remapping strategies (applied in order):
 *   1. BOUNDARY_PATH_USER_MAP env var: "bando=/mnt/data;artwalk=/srv/data" style key-value pairs
 *      for explicit per-username redirects without touching source code.
 *   2. Generic /home/<any-username> → current user's home (covers dev→prod drift automatically).
 *
 * Then the resolved path is validated against the allowed roots.
 */
function validatePath(p) {
  if (!p) return null;
  if (p.includes('..')) return null;

  let normalized = p;

  // Strategy 1: explicit env-driven user map (format: "username1=/new/path;username2=/other")
  const userMapEnv = process.env.BOUNDARY_PATH_USER_MAP;
  if (userMapEnv) {
    for (const entry of userMapEnv.split(';').filter(Boolean)) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx < 1) continue;
      const fromUser = entry.slice(0, eqIdx).trim();
      const toPath   = entry.slice(eqIdx + 1).trim();
      const fromPrefix = `/home/${fromUser}`;
      if (normalized.startsWith(fromPrefix)) {
        normalized = toPath + normalized.slice(fromPrefix.length);
        break;
      }
    }
  }

  // Strategy 2: remap any /home/<username> prefix to the current user's home directory.
  // This lets paths stored/shared from a different developer machine resolve correctly
  // without hardcoding specific usernames.
  normalized = normalized.replace(/^\/home\/[^/]+/, os.homedir());

  // Normalize backslashes (Windows paths from the client)
  normalized = normalized.replace(/\\/g, '/');

  // Translate to actual location under the extracted training folder if the directly requested ones don't exist
  let resolvedCasePath = resolvePathCaseInsensitive(normalized);
  if (fs.existsSync(resolvedCasePath)) {
    normalized = resolvedCasePath;
  } else {
    const trainingPattern = /\/Downloads\/training-[^/]+\/training/i;
    if (trainingPattern.test(normalized)) {
      const candidate = resolvePathCaseInsensitive(normalized.replace(trainingPattern, '/Downloads/FILES/training'));
      if (fs.existsSync(candidate)) normalized = candidate;
    } else if (normalized.includes('/Downloads/TrainPDF')) {
      const candidate = resolvePathCaseInsensitive(normalized.replace('/Downloads/TrainPDF', '/Downloads/FILES/training/TrainPDF'));
      if (fs.existsSync(candidate)) normalized = candidate;
    } else if (normalized.includes('/Downloads/Legal Descriptions')) {
      const candidate = resolvePathCaseInsensitive(normalized.replace('/Downloads/Legal Descriptions', '/Downloads/FILES/training/Legal Descriptions'));
      if (fs.existsSync(candidate)) normalized = candidate;
    }

    // Fallback standard structure
    if (!fs.existsSync(normalized)) {
      if (normalized.includes('/Downloads/TrainPDF')) {
        const candidate = resolvePathCaseInsensitive(normalized.replace('/Downloads/TrainPDF', '/Downloads/training-20260530T124201Z-3-001/training/TrainPDF'));
        if (fs.existsSync(candidate)) normalized = candidate;
      } else if (normalized.includes('/Downloads/Legal Descriptions')) {
        const candidate = resolvePathCaseInsensitive(normalized.replace('/Downloads/Legal Descriptions', '/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions'));
        if (fs.existsSync(candidate)) normalized = candidate;
      }
    }
  }

  const resolved = path.resolve(normalized);
  const roots = getAllowedRoots();
  for (const root of roots) {
    if (resolved.startsWith(root)) return resolved;
  }
  return null;
}



/**
 * Rec 4 helper — Detect multi-part deed file families.
 * Matches: 12345L2.doc, 12345L-2.doc, 12345L-B.doc, 12345LB.doc, 12345L_2.pdf
 * Returns { base, part, partOrder } or null for single-part deeds.
 * partOrder: A/1 = 1, B/2 = 2, C/3 = 3
 */
function _getPartFamily(fileName) {
  const stem = path.parse(fileName).name;
  // Pattern: base + optional separator + part indicator (A-D or 2-4)
  const m = stem.match(/^(.+?)[-_ ]?([A-D]|[2-4])$/i);
  if (!m) return null;
  const base = m[1];
  const part = m[2].toUpperCase();
  const partOrder = /[A2]/.test(part) ? (['A','2'].includes(part) ? (/A/.test(part) ? 1 : 2) : 2) : 
    ['B','3'].includes(part) ? (/B/.test(part) ? 2 : 3) :
    ['C','4'].includes(part) ? (/C/.test(part) ? 3 : 4) : 1;
  // partOrder mapping
  const orderMap = { A: 1, '2': 2, B: 2, '3': 3, C: 3, '4': 4, D: 4 };
  return { base, part, partOrder: orderMap[part] ?? 1 };
}

// GET /api/folderscan/scan
router.get('/scan', scanLimiter, (req, res) => {
  const validPath = validatePath(req.query.path);
  if (!validPath) return res.status(403).json({ error: 'Path is not allowed. Set BOUNDARY_SCAN_ROOTS env var to configure.' });
  if (!fs.existsSync(validPath)) return res.status(404).json({ error: `Directory not found: ${validPath}` });

  const files = getSupportedFiles(validPath).map(f => {
    const stats = fs.statSync(f);
    const fileName = path.basename(f);
    const docType = getDocType(f, fileName);
    return {
      fileName, fullPath: f, sizeBytes: stats.size, sizeMb: Math.round(stats.size / 1048576 * 100) / 100,
      docType, willProcess: docType !== 'SKIP' && stats.size <= MAX_FILE_SIZE,
      skipReason: docType === 'SKIP' ? 'Non-boundary document' : stats.size > MAX_FILE_SIZE ? 'Exceeds 51 MB' : null,
    };
  });

  const total = files.length;
  const toProcess = files.filter(f => f.willProcess).length;
  res.json({ path: req.query.path, total, toProcess, toSkip: total - toProcess, batchesNeeded: Math.ceil(toProcess / BATCH_SIZE), batchSize: BATCH_SIZE, files });
});

// GET /api/folderscan/debug-skipped
router.get('/debug-skipped', (req, res) => {
  const validPath = validatePath(req.query.path);
  if (!validPath) return res.status(403).json({ error: 'Path is not allowed.' });
  if (!fs.existsSync(validPath)) return res.status(404).json({ error: `Directory not found: ${validPath}` });

  const files = getSupportedFiles(validPath).map(f => {
    const stats = fs.statSync(f);
    const fileName = path.basename(f);
    const docType = getDocType(f, fileName);
    const upper = fileName.toUpperCase();
    let matchedSkipKeyword = null;
    for (const skip of SKIP_KEYWORDS) { if (upper.includes(skip.toUpperCase())) { matchedSkipKeyword = skip; break; } }
    return {
      fileName, sizeMb: Math.round(stats.size / 1048576 * 100) / 100, docType,
      willProcess: docType !== 'SKIP' && stats.size <= MAX_FILE_SIZE, matchedSkipKeyword,
    };
  });

  const skipped = files.filter(f => !f.willProcess);
  res.json({ path: req.query.path, totalFiles: files.length, totalProcessable: files.length - skipped.length, totalSkipped: skipped.length, skippedFiles: skipped });
});

// ── Global processing lock ─────────────────────────────────────────────────
// Ollama is single-threaded. Concurrent batch requests each queue 20+ LLM calls
// that all block for up to 30 min. This lock ensures only ONE batch or retry run
// is active at a time, returning 503 immediately if already busy.
function acquireLock(type, path) {
  return lockService.acquire(type, path);
}
function releaseLock() {
  lockService.release();
}

// GET /api/folderscan/status  — is the server currently processing?
router.get('/status', (req, res) => {
  const stat = lockService.status();
  res.json(stat);
});

// POST /api/folderscan/reset-lock — force-release the processing lock
router.post('/reset-lock', (req, res) => {
  const { wasLocked, previousInfo } = lockService.reset();
  console.log('🔓 Processing lock was force-released by manual client request.');
  res.json({
    success: true,
    message: wasLocked
      ? `Processing lock for '${previousInfo?.type || 'unknown'}' was successfully released.`
      : 'Server was not locked, but processing state has been reset.',
  });
});

// Wrapper helper to inject Point of Reference parameters automatically into saveDeedLog
function saveDeedLogWrapper(req, batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, extractionJson = null, traverseJson = null, agentTurnsJson = null, trustScore = null, solutionStepsJson = null, fileHash = null) {
  const refName = req.query.refName || null;
  const refN = req.query.refN != null ? parseFloat(req.query.refN) : null;
  const refE = req.query.refE != null ? parseFloat(req.query.refE) : null;
  const pobN = parseFloat(req.query.pobN) || 5000;
  const pobE = parseFloat(req.query.pobE) || 5000;

  db.saveDeedLog(
    batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed,
    extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson,
    refName, refN, refE, pobN, pobE, fileHash
  );
}

// Helper to determine whether to create a new output folder or reuse an existing one passed in query params
function getOrCreateOutputFolder(req, validPath) {
  if (req.query.outputPath) {
    const p = path.resolve(req.query.outputPath);
    // SEC-7: validate against allowed roots to prevent path traversal
    const safeOutput = validatePath(p);
    if (!safeOutput) {
      return null; // caller must check and return 403
    }
    if (!fs.existsSync(safeOutput)) {
      fs.mkdirSync(safeOutput, { recursive: true });
    }
    return safeOutput;
  }
  return output.createOutputFolder(validPath);
}

// Consolidate reference point and commencement segments for all deeds in the project directory
async function updateProjectReferences(folderPath, newResults) {
  const filePath = path.join(folderPath, 'project_references.json');
  let data = {
    projectPath: folderPath,
    lastUpdated: new Date().toISOString(),
    references: []
  };

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim()) {
        data = JSON.parse(content);
        data.lastUpdated = new Date().toISOString();
        if (!Array.isArray(data.references)) {
          data.references = [];
        }
      }
    } catch (err) {
      console.warn(`Failed to read/parse project_references.json at ${filePath}:`, err.message);
    }
  }

  for (const r of newResults) {
    if (!r) continue;

    const extractRefInfo = (fileName, extObj) => {
      const refName = extObj?.ReferencePointName || extObj?.referencePointName || null;
      const commSegs = extObj?.CommencementSegments || extObj?.commencementSegments || [];
      if (refName || (commSegs && commSegs.length > 0)) {
        // Remove existing entry for same fileName to avoid duplicates
        data.references = data.references.filter(entry => entry.fileName !== fileName);
        data.references.push({
          fileName,
          referencePointName: refName,
          commencementSegments: commSegs
        });
      }
    };

    if (r.isMultiParcel && r.parcels) {
      for (const pr of r.parcels) {
        const ext = pr.extraction;
        const refName = ext?.ReferencePointName || ext?.referencePointName || null;
        const commSegs = ext?.CommencementSegments || ext?.commencementSegments || [];
        if (refName || (commSegs && commSegs.length > 0)) {
          data.references = data.references.filter(entry => entry.fileName !== pr.fileName);
          data.references.push({
            fileName: pr.fileName,
            referencePointName: refName,
            commencementSegments: commSegs
          });
        }
      }
    } else {
      extractRefInfo(r.fileName, r.extraction);
    }
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Saved consolidated project references to ${filePath}`);
  } catch (err) {
    console.warn(`Failed to write project_references.json at ${filePath}:`, err.message);
  }
}

// GET /api/folderscan/download-batch-zip
router.get('/download-batch-zip', async (req, res) => {
  try {
    const folderPath = req.query.path;
    const validPath = validatePath(folderPath);
    if (!validPath) {
      return res.status(403).json({ error: 'Path is not allowed.' });
    }
    if (!fs.existsSync(validPath)) {
      return res.status(404).json({ error: `Directory not found: ${validPath}` });
    }

    const files = fs.readdirSync(validPath);
    if (files.length === 0) {
      return res.status(400).json({ error: 'Directory is empty' });
    }

    const archiver = (await import('archiver')).default;
    const zipName = `${path.basename(validPath)}_deliverables.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('error', (err) => {
      console.error('archiver error during ZIP streaming:', err);
      // Headers may already be sent; nothing left to do other than log.
    });

    archive.pipe(res);
    archive.directory(validPath, false);
    await archive.finalize();
  } catch (ex) {
    console.error('ZIP download route error:', ex);
    if (!res.headersSent) {
      res.status(500).json({ error: ex.message });
    }
  }
});


// POST /api/folderscan/process-batch
router.post('/process-batch', async (req, res) => {
  let keepAlive = null;
  let hasLock = false;
  const forceOcr = req.query.forceOcr !== undefined ? req.query.forceOcr === 'true' : (process.env.OCR_ENABLED === 'true');
  try {
    const validPath = validatePath(req.query.path);
    if (!validPath) return res.status(403).json({ error: 'Path is not allowed.' });
    if (!fs.existsSync(validPath)) return res.status(404).json({ error: `Directory not found: ${validPath}` });

    if (!acquireLock('folderscan-batch', validPath)) {
      const info = lockService.status();
      return res.status(503).json({
        error: `Server is already processing (${info.type || 'unknown'} — ${info.elapsedSec || 0}s elapsed). Please wait for it to finish.`
      });
    }
    hasLock = true;

    const batchIndex = parseInt(req.query.batchIndex) || 0;
    const pobN = parseFloat(req.query.pobN) || 5000;
    const pobE = parseFloat(req.query.pobE) || 5000;
    const refName = req.query.refName || null;
    const refN = req.query.refN != null ? parseFloat(req.query.refN) : null;
    const refE = req.query.refE != null ? parseFloat(req.query.refE) : null;
    const units = req.query.units || 'Feet';
    const county = req.query.county || null;
    const state = req.query.state || null;
    
    const activeProvider = geminiVision.getActiveProvider();
    const isLocalLLM = activeProvider === 'ollama' || activeProvider === 'openai';
    const concurrency = isLocalLLM ? 1 : (parseInt(req.query.concurrency) || 5);

    if (isLocalLLM && parseInt(req.query.concurrency) > 1) {
      console.log(`⚠️ Local provider "${activeProvider}" is active. Capping FolderScan concurrency limit from ${req.query.concurrency} to 1 to prevent OOM/timeouts.`);
    }

    const autoOutput = req.query.autoOutput === 'true';
    const shortFileNames = req.query.shortFileNames === 'true';
    const showConceptualDetail = req.query.showConceptualDetail === 'true';
    const leaderStyle = req.query.leaderStyle || 'arc';
    const labelContentMode = req.query.labelContentMode || 'auto';

    const allProcessable = getSupportedFiles(validPath).filter(f => {
      const stats = fs.statSync(f);
      return stats.size <= MAX_FILE_SIZE;
    });

    if (allProcessable.length === 0) return res.json({ message: 'No processable deed PDFs found.', results: [] });

    const totalBatches = Math.ceil(allProcessable.length / BATCH_SIZE);
    if (batchIndex >= totalBatches) return res.status(400).json({ error: `batchIndex ${batchIndex} out of range (0–${totalBatches - 1}).` });

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

    const batch = allProcessable.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);
    const batchId = uuidv4();
    const results = new Array(batch.length);

    db.saveBatchRun(batchId, batch.length, 0.0);
    console.log(`FolderScan batch ${batchIndex}/${totalBatches - 1}: ${batch.length} files from ${req.query.path} using ${geminiVision.getActiveProvider()}/${geminiVision.getActiveModel()}`);

    const sem = new lockService.FifoSemaphore(concurrency);
    const tasks = batch.map((filePath, index) => async () => {
      const fileName = path.basename(filePath);
      console.log(`FolderScan processing: ${fileName}`);
      let fileHash = null;
      let rawDocText = '';

      try {
        let imageBytes = await fs.promises.readFile(filePath);
        let mime = inferMimeType(fileName);
        fileHash = crypto.createHash('sha256').update(imageBytes).digest('hex');

        rawDocText = '';
        let resolvedCounty = county;
        let resolvedState = state;

        // Resolve county/state early for caching/output accuracy
        if (!resolvedCounty || !resolvedState) {
          try {
            rawDocText = await ensureExtractedText(filePath, fileName, imageBytes, validPath);
            const docInferred = geminiVision.inferCountyStateFromText(rawDocText || '');
            resolvedCounty = resolvedCounty || docInferred.county || null;
            resolvedState = resolvedState || docInferred.state || null;
          } catch (err) {
            console.warn('Failed early county/state inference:', err.message);
          }
        }

        // Check if getDocType returns 'SKIP'
        const docType = getDocType(filePath, fileName);
        if (docType === 'SKIP') {
          console.log(`FolderScan batch: ${fileName} — SKIPPED (getDocType returned SKIP)`);
          results[index] = {
            fileName, status: 'skipped', extraction: { courses: [], classification: 'LOT_BLOCK' }, traverse: null, legalDescription: null,
            error: null, skipReason: `Excluded by document classifier (SKIP)`,
            conceptualAnalysis: null, fileHash
          };
          saveDeedLogWrapper(req, batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
            'SKIPPED', 'Excluded by document classifier (SKIP)', JSON.stringify({ courses: [], classification: 'LOT_BLOCK' }), null, null, null, null, fileHash);
          return;
        }

        // Check cache
        if (!forceOcr) {
          const solvedCase = db.findSolvedCase(fileName, fileHash);
          if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
            console.log(`Cache hit for ${fileName} (hash=${fileHash})`);
            const cachedEx = JSON.parse(solvedCase.extractionJson);
            const cachedTr = JSON.parse(solvedCase.traverseJson);

            // Extract from solvedCase.parcelName if possible
            const labelInferred = geminiVision.inferCountyStateFromText(solvedCase.parcelName || '');
            const cacheCounty = resolvedCounty || labelInferred.county || null;
            const cacheState = resolvedState || labelInferred.state || null;

            cachedEx.county = getCountyVal(cachedEx, cacheCounty);
            cachedEx.state = getStateVal(cachedEx, cacheState);

            let cachedWrite = null;
            if (cachedEx.courses?.length > 0) {
              try {
                cachedWrite = { legalDescription: legalWriter.write({ courses: cachedEx.courses, pobNorthing: pobN, pobEasting: pobE, county: cachedEx.county, state: cachedEx.state, units: units.toLowerCase(), areaAcres: cachedTr.areaAcres, perimeter: cachedTr.perimeter }), courseCount: cachedEx.courses.length };
              } catch {}
            }
            results[index] = { 
              fileName, status: 'success', extraction: cachedEx, traverse: cachedTr, legalDescription: cachedWrite, error: null, fileHash, 
              agentTurns: solvedCase.agentTurnsJson ? JSON.parse(solvedCase.agentTurnsJson) : null,
              solutionSteps: solvedCase.solutionStepsJson ? JSON.parse(solvedCase.solutionStepsJson) : null
            };
            const cachedLabel = cacheCounty && cacheState ? `${cacheCounty}, ${cacheState}` : (solvedCase.parcelName || 'CACHED');
            saveDeedLogWrapper(req, batchId, fileName, cachedLabel, cachedEx.courses?.length || 0, cachedTr.closure?.linearError || 0, parsePrecisionRatio(cachedTr.closure?.precisionRatio), 'PASS', 'Stage 5: SQLite Case Finder Solved', solvedCase.extractionJson, solvedCase.traverseJson, null, null, null, fileHash);
            return;
          }

          // Check skipped cache
          const skippedCase = db.findSkippedCase(fileName, fileHash);
          if (skippedCase?.extractionJson) {
            console.log(`Cache hit (SKIPPED) for ${fileName} (hash=${fileHash})`);
            const cachedEx = JSON.parse(skippedCase.extractionJson);
            results[index] = {
              fileName,
              status: 'skipped',
              extraction: cachedEx,
              traverse: null,
              legalDescription: null,
              error: null,
              skipReason: skippedCase.repairStageUsed || `Non-traversable: ${cachedEx.classification}`,
              conceptualAnalysis: cachedEx.conceptualAnalysis || null,
              fileHash,
              agentTurns: null
            };
            saveDeedLogWrapper(req, batchId, fileName, skippedCase.parcelName || `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0, 'SKIPPED', skippedCase.repairStageUsed || 'Non-traversable document', skippedCase.extractionJson, null, null, null, null, fileHash);
            return;
          }
        }

        const upperName = fileName.toUpperCase();
        const isOpenEnded = ['EASEMENT', 'EAESMENT', 'EASMENT', 'ROAD', 'BLVD', 'R/W', 'RIGHT OF WAY', 'CENTERLINE'].some(k => upperName.includes(k));

        if (isWordDocument(fileName)) {
          console.log(`Converting Word doc ${fileName} to PDF with fallback...`);
          const resFallback = await readWordDocWithFallback(filePath, fileName, imageBytes);
          imageBytes = resFallback.bytes;
          mime = resFallback.mime;
        }

        const pob = { northing: pobN, easting: pobE };

        // ── Multi-Parcel Fan-Out ───────────────────────────────────────────────
        if (!rawDocText) {
          try {
            rawDocText = await ensureExtractedText(filePath, fileName, imageBytes, validPath, forceOcr);
          } catch (err) {
            console.warn('Failed to ensure extracted text:', err.message);
          }
        }
        const namedParcels = extractNamedParcels(rawDocText);
        if (namedParcels && namedParcels.length >= 2) {
          console.log(`FolderScan: Multi-parcel deed detected in ${fileName} — ${namedParcels.length} parcels: ${namedParcels.map(p => p.label).join(', ')}`);
          
          let parcelResults = [];
          for (const { label, text: parcelText } of namedParcels) {
            const ext = path.extname(fileName);
            const base = path.parse(fileName).name;
            const parcelFileName = `${base}__${label}${ext}`;
            const parcelHash = crypto.createHash('sha256').update(parcelText).digest('hex');

            // Check solved cache for this parcel
            if (!forceOcr) {
              const solvedCase = db.findSolvedCase(parcelFileName, parcelHash);
              if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
                console.log(`Cache hit for parcel ${label} (${parcelFileName}) (hash=${parcelHash})`);
                const cachedEx = JSON.parse(solvedCase.extractionJson);
                const cachedTr = JSON.parse(solvedCase.traverseJson);

                // Extract from solvedCase.parcelName if possible
                const labelInferred = geminiVision.inferCountyStateFromText(solvedCase.parcelName || '');
                const cacheCounty = resolvedCounty || labelInferred.county || null;
                const cacheState = resolvedState || labelInferred.state || null;

                cachedEx.county = getCountyVal(cachedEx, cacheCounty);
                cachedEx.state = getStateVal(cachedEx, cacheState);

                let cachedWrite = null;
                if (cachedEx.courses?.length > 0) {
                  try {
                    cachedWrite = {
                      legalDescription: legalWriter.write({
                        courses: cachedEx.courses, pobNorthing: pobN, pobEasting: pobE, county: cachedEx.county, state: cachedEx.state, units: units.toLowerCase(), areaAcres: cachedTr.areaAcres, perimeter: cachedTr.perimeter
                      }),
                      courseCount: cachedEx.courses.length
                    };
                  } catch {}
                }
                 const pRes = { 
                   fileName: parcelFileName, status: 'success', extraction: cachedEx, traverse: cachedTr, legalDescription: cachedWrite, error: null, fileHash: parcelHash, 
                   agentTurns: solvedCase.agentTurnsJson ? JSON.parse(solvedCase.agentTurnsJson) : null,
                   solutionSteps: solvedCase.solutionStepsJson ? JSON.parse(solvedCase.solutionStepsJson) : null
                 };
                parcelResults.push(pRes);
                const pLabel = cacheCounty && cacheState ? `${cacheCounty}, ${cacheState}` : `[${label}] ${base}`;
                saveDeedLogWrapper(req, batchId, parcelFileName, pLabel, cachedEx.courses?.length || 0, cachedTr.closure?.linearError || 0, parsePrecisionRatio(cachedTr.closure?.precisionRatio), 'PASS', 'Stage 5: SQLite Case Finder Solved', solvedCase.extractionJson, solvedCase.traverseJson, null, null, null, parcelHash);
                continue;
              }

              // Check skipped cache for this parcel
              const skippedCase = db.findSkippedCase(parcelFileName, parcelHash);
              if (skippedCase?.extractionJson) {
                console.log(`Cache hit (SKIPPED) for parcel ${label} (${parcelFileName}) (hash=${parcelHash})`);
                const cachedEx = JSON.parse(skippedCase.extractionJson);
                const pRes = {
                  fileName: parcelFileName,
                  status: 'skipped',
                  extraction: cachedEx,
                  traverse: null,
                  legalDescription: null,
                  error: null,
                  skipReason: skippedCase.repairStageUsed || `Non-traversable: ${cachedEx.classification}`,
                  conceptualAnalysis: cachedEx.conceptualAnalysis || null,
                  fileHash: parcelHash,
                  agentTurns: null
                };
                parcelResults.push(pRes);
                const pLabel = `[${label}] ${resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : base}`;
                saveDeedLogWrapper(req, batchId, parcelFileName, pLabel, 0, 0, 0, 'SKIPPED', skippedCase.repairStageUsed || 'Non-traversable document', skippedCase.extractionJson, null, null, null, null, parcelHash);
                continue;
              }
            }

            if (!geminiVision.hasBoundaryKeywords(parcelText)) {
              console.log(`FolderScan: skipping parcel ${label} (${parcelFileName}) - no boundary keywords`);
              const pRes = {
                fileName: parcelFileName,
                status: 'skipped',
                extraction: { courses: [], classification: 'LOT_BLOCK', rawText: parcelText },
                traverse: null,
                legalDescription: null,
                error: null,
                skipReason: 'Non-traversable (no boundary keywords)',
                fileHash: parcelHash,
                agentTurns: null
              };
              parcelResults.push(pRes);
              const pLabel = `[${label}] ${resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : base}`;
              saveDeedLogWrapper(req, batchId, parcelFileName, pLabel, 0, 0, 0, 'SKIPPED', 'Non-traversable document (pre-check)', JSON.stringify(pRes.extraction), null, null, null, null, parcelHash);
              continue;
            }

            const isOE = detectOpenEnded(parcelText, parcelFileName, false);
            console.log(`FolderScan: Processing parcel ${label} → ${parcelFileName} (isOpenEnded=${isOE})`);
            
            // Try offline PLSS intercept first for the parcel
            const plssParsedObj = shouldInterceptPLSS(parcelText) ? plssParser.parsePlss(parcelText) : null;
            if (plssParsedObj) {
              console.log(`[FolderScan Intercept] Found PLSS in parcel ${label} (${parcelFileName}) - bypassing LLM.`, plssParsedObj);
              const platResult = await platLookup.resolvePlss(plssParsedObj, pob);
              if (platResult && !platResult.needsManual && platResult.courses?.length > 0) {
                const inferred = geminiVision.inferCountyStateFromText(parcelText);
                const extraction = {
                  courses: platResult.courses,
                  classification: 'SECTION_BREAKDOWN',
                  rawText: parcelText,
                  county: inferred.county || 'Unknown',
                  state: inferred.state || 'Unknown',
                };
                const traverse = traverseSvc.compute({ pointOfBeginning: pob, courses: platResult.courses, units, isOpenEnded: false });
                let writeResult = null;
                try {
                  writeResult = {
                    legalDescription: legalWriter.write({
                      courses: platResult.courses,
                      pobNorthing: pobN,
                      pobEasting: pobE,
                      county: getCountyVal(extraction, resolvedCounty),
                      state: getStateVal(extraction, resolvedState),
                      units: units.toLowerCase(),
                      areaAcres: platResult.areaAcres,
                      perimeter: traverse?.perimeter
                    }),
                    courseCount: platResult.courses.length
                  };
                } catch {}

                const pRes = { fileName: parcelFileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, platLookup: platResult, fileHash: parcelHash, agentTurns: null };
                parcelResults.push(pRes);

                const stageLabel = `Stage 1.5: Offline PLSS Intercept (${platResult.isFallback ? 'fallback grid' : 'BLM API'})`;
                const pLabel = `[${label}] ${resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : base}`;
                saveDeedLogWrapper(req, batchId, parcelFileName, pLabel, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse), null, null, null, parcelHash);
                
                continue; // successfully processed this parcel offline!
              }
            }

            try {
              const pResult = await runRepairPipeline(Buffer.from(parcelText, 'utf-8'), 'text/plain', pob, units, isOE, parcelFileName);
              let pEx = pResult.finalExtraction;
              let pTr = pResult.finalTraverse;
              let pStatus = pResult.status;
              let pStage  = pResult.repairStageUsed;
              const pLabel  = `[${label}] ${resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : base}`;

              const isNonTraversable = (!pEx.courses || pEx.courses.length === 0) &&
                (['PLAT', 'LOT_BLOCK', 'SECTION_BREAKDOWN'].includes(pEx.classification) ||
                 (pResult.traverseError || '').toLowerCase().includes('no traversable') ||
                 (pResult.traverseError || '').toLowerCase().includes('zero segment') ||
                 !geminiVision.hasBoundaryKeywords(pEx.rawText || parcelText || ''));

              if (isNonTraversable) {
                pStatus = 'SKIPPED';
                pStage = 'Non-traversable document';
              }
              
              let pWrite = null;
              if (pEx.courses?.length > 0) {
                try {
                  pWrite = {
                    legalDescription: legalWriter.write({
                      courses: pEx.courses, pobNorthing: pobN, pobEasting: pobE, county: getCountyVal(pEx, resolvedCounty), state: getStateVal(pEx, resolvedState), units: units.toLowerCase(), areaAcres: pTr?.areaAcres, perimeter: pTr?.perimeter
                    }),
                    courseCount: pEx.courses.length
                  };
                } catch {}
              }

              let finalStatus = 'error';
              if (pStatus === 'PASS' || pStatus === 'MEANDER') {
                finalStatus = 'success';
              } else if (pStatus === 'SKIPPED') {
                finalStatus = 'skipped';
              }

              const pRes = { fileName: parcelFileName, status: finalStatus, extraction: pEx, traverse: pTr, legalDescription: pWrite, error: pResult.traverseError, platLookup: null, fileHash: parcelHash, agentTurns: pResult.agentTurns || null };
              parcelResults.push(pRes);

              saveDeedLogWrapper(req, 
                batchId, parcelFileName, pLabel,
                pEx?.courses?.length || 0,
                pTr?.closure?.linearError || 0,
                parsePrecisionRatio(pTr?.closure?.precisionRatio),
                pStatus, pStage,
                JSON.stringify(pEx),
                pTr ? JSON.stringify(pTr) : null,
                pResult.agentTurns ? JSON.stringify(pResult.agentTurns) : null,
                pResult.trustScore ?? null,
                pResult.solutionSteps ? JSON.stringify(pResult.solutionSteps) : null,
                parcelHash
              );
              console.log(`FolderScan: Parcel ${label} saved as ${parcelFileName} — ${pStatus}`);
            } catch (parcelEx) {
              console.warn(`FolderScan: Parcel ${label} (${parcelFileName}) failed:`, parcelEx.message);
            }
          }

          if (parcelResults.length > 0) {
            const base = path.parse(fileName).name;
            const ext = path.extname(fileName);
            const combinedExtraction = {
              ...parcelResults[0].extraction,
              parcels: parcelResults.map((pr, pi) => ({
                parcelId: pr.fileName.replace(`${base}__`, '').replace(ext, ''),
                extraction: pr.extraction,
                traverse: pr.traverse,
                legalDescription: pr.legalDescription,
                status: pr.status
              }))
            };
            results[index] = {
              fileName,
              status: 'success',
              isMultiParcel: true,
              parcels: parcelResults,
              extraction: combinedExtraction,
              traverse: parcelResults[0].traverse,
              legalDescription: parcelResults[0].legalDescription,
              error: null,
              fileHash,
              agentTurns: null
            };
            return;
          }
        }

        // Check for PLSS description first to avoid Gemini API calls for .txt deeds
        const plssParsedObj = shouldInterceptPLSS(rawDocText) ? plssParser.parsePlss(rawDocText) : null;
        if (plssParsedObj) {
          console.log(`[FolderScan Intercept] Found PLSS in ${fileName} - bypassing LLM.`, plssParsedObj);
          const platResult = await platLookup.resolvePlss(plssParsedObj, pob);
          if (platResult && !platResult.needsManual && platResult.courses?.length > 0) {
            const inferred = geminiVision.inferCountyStateFromText(rawDocText);
            const extraction = {
              courses: platResult.courses,
              classification: 'SECTION_BREAKDOWN',
              rawText: rawDocText,
              county: inferred.county || 'Unknown',
              state: inferred.state || 'Unknown',
            };
            const traverse = traverseSvc.compute({ pointOfBeginning: pob, courses: platResult.courses, units, isOpenEnded: false });
            let writeResult = null;
            try {
              writeResult = {
                legalDescription: legalWriter.write({
                  courses: platResult.courses,
                  pobNorthing: pobN,
                  pobEasting: pobE,
                  county: getCountyVal(extraction, resolvedCounty),
                  state: getStateVal(extraction, resolvedState),
                  units: units.toLowerCase(),
                  areaAcres: platResult.areaAcres,
                  perimeter: traverse?.perimeter
                }),
                courseCount: platResult.courses.length
              };
            } catch {}

            results[index] = { fileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, platLookup: platResult, fileHash, agentTurns: null };
            const stageLabel = `Stage 1.5: Offline PLSS Intercept (${platResult.isFallback ? 'fallback grid' : 'BLM API'})`;
            saveDeedLogWrapper(req, batchId, fileName, resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : `[PLAT-INTERCEPT] ${path.parse(fileName).name}`, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse), null, null, null, fileHash);
            return;
          }
        }

        if (rawDocText && rawDocText.trim().length >= 80 && !geminiVision.hasBoundaryKeywords(rawDocText)) {
          console.log(`FolderScan batch: ${fileName} — SKIPPED (non-traversable: no boundary keywords in document text)`);
          const extraction = { courses: [], classification: 'LOT_BLOCK', rawText: rawDocText || '' };
          results[index] = {
            fileName, status: 'skipped', extraction, traverse: null, legalDescription: null,
            error: null, skipReason: `Document contains no boundary keywords (LOT_BLOCK).`,
            conceptualAnalysis: null,
            fileHash,
            agentTurns: null
          };
          saveDeedLogWrapper(req, batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
            'SKIPPED', 'Non-traversable document (pre-check)', JSON.stringify(extraction), null, null, null, null, fileHash);
          return;
        }

        const repairResult = await runRepairPipeline(imageBytes, mime, pob, units, isOpenEnded, fileName);

        const extraction = repairResult.finalExtraction;
        if (extraction && !extraction.rawText) {
          extraction.rawText = rawDocText || '';
        }
        const originalLegalDesc = extraction.originalLegalDesc || repairResult.originalExtraction?.originalLegalDesc || null;
        if (originalLegalDesc) {
          try {
            const base = path.parse(fileName).name;
            const extractedTxtPath = path.join(validPath, '_extracted', base + '.txt');
            fs.writeFileSync(extractedTxtPath, originalLegalDesc, 'utf-8');
            console.log(`Updated cache file ${extractedTxtPath} with isolated original deed text.`);
          } catch (err) {
            console.warn(`Failed to update extracted cache file:`, err.message);
          }
        }
        const traverse = repairResult.finalTraverse;
        const status = repairResult.status;
        const stageUsed = repairResult.repairStageUsed;

        let writeResult = null;
        if (extraction.courses?.length > 0) {
          try {
            writeResult = { legalDescription: legalWriter.write({ courses: extraction.courses, pobNorthing: pobN, pobEasting: pobE, county: getCountyVal(extraction, resolvedCounty), state: getStateVal(extraction, resolvedState), units: units.toLowerCase(), areaAcres: traverse?.areaAcres, perimeter: traverse?.perimeter }), courseCount: extraction.courses.length };
          } catch {}
        }

        // ── LOT_BLOCK / SECTION_BREAKDOWN: try PlatLookupService before skipping ──
        const isLotBlock   = extraction.classification === 'LOT_BLOCK';
        const isPlssType   = ['SECTION_BREAKDOWN','QUALIFIED_PLSS'].includes(extraction.classification);
        const hasNoCourses = !extraction.courses || extraction.courses.length === 0;

        if (hasNoCourses && (isLotBlock || isPlssType)) {
          try {
            let platResult = null;
            if (isLotBlock) {
              platResult = await platLookup.resolveLotBlock(extraction, resolvedCounty);
            } else {
              const rawText = extraction.rawText || extraction.rawJson || '';
              const parsed  = plssParser.parsePlss(rawText) || plssParser.parsePlss(extraction.mentalMapSummary || '');
              if (parsed) platResult = await platLookup.resolvePlss(parsed, pob);
            }

            if (platResult && !platResult.needsManual && platResult.courses?.length > 0) {
              console.log(`PlatLookup batch: ${fileName} → ${platResult.source} (${platResult.courses.length} courses, ${platResult.areaAcres?.toFixed(4)} ac)`);
              extraction.courses = platResult.courses;
              const traverse = traverseSvc.compute({ pointOfBeginning: pob, courses: platResult.courses, units, isOpenEnded: false });
              let writeResult = null;
              try { writeResult = { legalDescription: legalWriter.write({ courses: platResult.courses, pobNorthing: pobN, pobEasting: pobE, county: getCountyVal(extraction, resolvedCounty), state: getStateVal(extraction, resolvedState), units: units.toLowerCase(), areaAcres: platResult.areaAcres, perimeter: traverse?.perimeter }), courseCount: platResult.courses.length }; } catch {}
              const stageLabel = `Stage 3.5: PlatLookup Tier ${platResult.tier} (${isLotBlock ? 'LOT_BLOCK' : 'PLSS'})${platResult.isFallback ? ' [fallback grid]' : ''}`;
              results[index] = { fileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, platLookup: platResult, fileHash, agentTurns: null };
              saveDeedLogWrapper(req, batchId, fileName, resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : `[PLAT] ${path.parse(fileName).name}`, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse), null, null, null, fileHash);
              return;
            } else if (platResult?.needsManual) {
              results[index] = {
                fileName,
                status: 'skipped',
                extraction,
                traverse: null,
                legalDescription: null,
                error: null,
                skipReason: `Lot/Block lookup requires manual coordinate entry (Tier 3)`,
                needsManualPlat: true,
                platInfo: { lot: platResult.lot, block: platResult.block, subdivision: platResult.subdivision },
                conceptualAnalysis: extraction.conceptualAnalysis || null,
                fileHash,
                agentTurns: null
              };
              saveDeedLogWrapper(req, batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
                'SKIPPED', 'Stage 4: LOT_BLOCK needs manual plat coordinates', JSON.stringify(extraction), null, null, null, null, fileHash);
              return;
            }
          } catch (platEx) {
            console.warn(`PlatLookup batch failed for ${fileName}: ${platEx.message}`);
          }

          console.log(`FolderScan batch: ${fileName} — SKIPPED (${extraction.classification})`);
          results[index] = {
            fileName, status: 'skipped', extraction, traverse: null, legalDescription: null,
            error: null, skipReason: `Non-traversable: ${extraction.classification}`,
            conceptualAnalysis: extraction.conceptualAnalysis || null,
            fileHash,
            agentTurns: null
          };
          saveDeedLogWrapper(req, batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
            'SKIPPED', 'Non-traversable document', JSON.stringify(extraction), null, null, null, null, fileHash);
          return;
        }

        const isNonTraversable = (!extraction.courses || extraction.courses.length === 0) &&
          (['PLAT', 'LOT_BLOCK', 'SECTION_BREAKDOWN'].includes(extraction.classification) ||
           (repairResult.traverseError || '').toLowerCase().includes('no traversable') ||
           (repairResult.traverseError || '').toLowerCase().includes('zero segment') ||
           !geminiVision.hasBoundaryKeywords(extraction.rawText || rawDocText || ''));

        if (isNonTraversable) {
          console.log(`FolderScan batch: ${fileName} — SKIPPED (${extraction.classification})`);
          results[index] = {
            fileName, status: 'skipped', extraction, traverse: null, legalDescription: null,
            error: null, skipReason: `Non-traversable: ${extraction.classification}`,
            conceptualAnalysis: extraction.conceptualAnalysis || null,
            fileHash,
            agentTurns: null
          };
          saveDeedLogWrapper(req, batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
            'SKIPPED', 'Non-traversable document', JSON.stringify(extraction), null, null, null, null, fileHash);
          return;
        }

        results[index] = { fileName, status: (status === 'PASS' || status === 'MEANDER') ? 'success' : 'error', extraction, traverse, legalDescription: writeResult, error: repairResult.traverseError, originalExtraction: repairResult.originalExtraction, solutionSteps: repairResult.solutionSteps || null, fileHash, agentTurns: repairResult.agentTurns || null };

        const parcelLabel = resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : `[${extraction.classification}] ${path.parse(fileName).name}`;
        const stepsJson = repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null;
        saveDeedLogWrapper(req, batchId, fileName, parcelLabel, extraction.courses?.length || 0, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), status, stageUsed, JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null, repairResult.agentTurns ? JSON.stringify(repairResult.agentTurns) : null, repairResult.trustScore ?? null, stepsJson, fileHash);
        if (extraction.courses?.length > 0) db.incrementHeuristic(stageUsed, 'FolderScan auto-repair');
      } catch (ex) {
        console.error(`FolderScan item failed: ${fileName}`, ex.message);
        results[index] = { fileName, status: 'error', extraction: { rawText: rawDocText || '' }, traverse: null, legalDescription: null, error: ex.message, fileHash, agentTurns: null };
        saveDeedLogWrapper(req, batchId, fileName, 'ERROR', 0, 999, 0, 'ERROR', 'AI Extraction Error', null, null, null, null, null, fileHash);
      }
    });

    await Promise.all(tasks.map(async (fn) => {
      await sem.acquire();
      try { await fn(); } finally { sem.release(); }
    }));

    const succeeded = results.filter(r => r?.status === 'success').length;
    const passRate = results.length > 0 ? succeeded / results.length : 0;
    db.saveBatchRun(batchId, results.length, passRate);

    // Auto-output
    let outputFolder = null;
    if (autoOutput) {
      try {
        const start = Date.now();
        outputFolder = getOrCreateOutputFolder(req, req.query.path);
        for (const r of results) {
          if (!r) continue;
          if (r.isMultiParcel && r.parcels) {
            for (const pr of r.parcels) {
              await output.writeResultFiles(outputFolder, pr.fileName, pr, pr.legalDescription, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
            }
          } else {
            await output.writeResultFiles(outputFolder, r.fileName, r, r.legalDescription, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
          }
        }
        output.writeBatchSummary(outputFolder, req.query.path, results, Date.now() - start);
        // Compile all per-deed Map PDFs into one _BATCH_REPORT.pdf
        await output.writeCombinedBatchPdf(outputFolder);
      } catch (ex) { console.warn('Auto-output failed:', ex.message); }
    }

    try {
      await updateProjectReferences(validPath, results);
    } catch (refErr) {
      console.warn('Failed to update project references:', refErr.message);
    }

    if (keepAlive) clearInterval(keepAlive);
    const payload = { batchId, batchIndex, totalBatches, filesInBatch: batch.length, outputFolder, results: { results, totalProcessed: results.length, succeeded, failed: results.length - succeeded } };
    res.write(JSON.stringify(payload));
    res.end();
  } catch (ex) {
    if (keepAlive) clearInterval(keepAlive);
    console.error('FolderScan process-batch error:', ex);
    if (res.headersSent) {
      res.write(JSON.stringify({ error: ex.message }));
      res.end();
    } else {
      res.status(500).json({ error: ex.message });
    }
  } finally {
    if (hasLock) {
      releaseLock();
    }
  }
});

// POST /api/folderscan/process-file
router.post('/process-file', async (req, res) => {
  let keepAlive = null;
  const forceOcr = req.query.forceOcr === 'true';
  try {
    const validPath = validatePath(req.query.path);
    if (!validPath) return res.status(403).json({ error: 'Path is not allowed.' });
    if (!fs.existsSync(validPath)) return res.status(404).json({ error: `Directory not found: ${validPath}` });

    const sendResponse = async (status, result) => {
      try {
        if (result && validPath) {
          await updateProjectReferences(validPath, [result]);
        }
      } catch (refErr) {
        console.warn('Failed to update project references in process-file:', refErr.message);
      }
      if (keepAlive) clearInterval(keepAlive);
      res.write(JSON.stringify({ status, result }));
      res.end();
    };

    const fileName = req.query.file;
    if (!fileName) return res.status(400).json({ error: 'file query parameter is required.' });

    let filePath = resolvePathCaseInsensitive(path.join(validPath, fileName));
    if (!fs.existsSync(filePath)) {
      // Fallback: search in common training and dataset directories
      const downloadsDir = process.env.BOUNDARY_DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads');

      const trainingBase = path.join(downloadsDir, 'training-20260530T124201Z-3-001', 'training');
      const candidates = [
        path.join(trainingBase, 'Legal Descriptions', fileName),
        path.join(trainingBase, 'TrainPDF', fileName),
        path.join(trainingBase, 'TrainPDF', 'Regency-Title', fileName),
        path.join(trainingBase, 'TrainPDF', 'LIDO', fileName),
        path.join(trainingBase, 'Bowtie-Failures', fileName),
        path.join(trainingBase, 'Bowtie-Test', fileName),
        path.join(downloadsDir, 'drive-download-20260602T132437Z-3-001', fileName),
      ];
      for (const cand of candidates) {
        const resolvedCand = resolvePathCaseInsensitive(cand);
        if (fs.existsSync(resolvedCand)) {
          filePath = resolvedCand;
          break;
        }
      }

      // If still not found, dynamically search any subfolders in Downloads (1 level deep)
      if (!fs.existsSync(filePath) && fs.existsSync(downloadsDir)) {
        try {
          const items = fs.readdirSync(downloadsDir);
          for (const item of items) {
            const itemPath = path.join(downloadsDir, item);
            if (fs.statSync(itemPath).isDirectory()) {
              const possibleFile = resolvePathCaseInsensitive(path.join(itemPath, fileName));
              if (fs.existsSync(possibleFile)) {
                filePath = possibleFile;
                break;
              }
              const possibleNested = resolvePathCaseInsensitive(path.join(itemPath, 'training', 'TrainPDF', 'Regency-Title', fileName));
              if (fs.existsSync(possibleNested)) {
                filePath = possibleNested;
                break;
              }
            }
          }
        } catch (err) {
          console.warn('Dynamic Downloads folder search fallback failed:', err.message);
        }
      }
    }

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: `File not found: ${filePath}` });

    const pobN = parseFloat(req.query.pobN) || 5000;
    const pobE = parseFloat(req.query.pobE) || 5000;
    const refName = req.query.refName || null;
    const refN = req.query.refN != null ? parseFloat(req.query.refN) : null;
    const refE = req.query.refE != null ? parseFloat(req.query.refE) : null;
    const units = req.query.units || 'Feet';
    const county = req.query.county || null;
    const state = req.query.state || null;
    const batchId = req.query.batchId || uuidv4();
    const autoOutput = req.query.autoOutput === 'true';
    const shortFileNames = req.query.shortFileNames === 'true';
    const showConceptualDetail = req.query.showConceptualDetail === 'true';
    const leaderStyle = req.query.leaderStyle || 'arc';
    const labelContentMode = req.query.labelContentMode || 'auto';

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
        res.write(' ');
        if (res.flush) res.flush();
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);

    const upperName = fileName.toUpperCase();
    const isOpenEnded = ['EASEMENT', 'EAESMENT', 'EASMENT', 'ROAD', 'BLVD', 'R/W', 'RIGHT OF WAY', 'CENTERLINE'].some(k => upperName.includes(k));

    let imageBytes = await fs.promises.readFile(filePath);
    let mime = inferMimeType(fileName);
    const fileHash = crypto.createHash('sha256').update(imageBytes).digest('hex');

    db.saveBatchRun(batchId, 1, 0.0);
    console.log(`FolderScan processing single file: ${fileName} (hash=${fileHash})`);

    // Check if getDocType returns 'SKIP'
    const docType = getDocType(filePath, fileName);
    if (docType === 'SKIP') {
      console.log(`FolderScan: ${fileName} — SKIPPED (getDocType returned SKIP)`);
      const result = {
        fileName, status: 'skipped',
        extraction: { courses: [], classification: 'LOT_BLOCK' }, traverse: null, legalDescription: null,
        error: null,
        skipReason: `Excluded by document classifier (SKIP)`,
        cached: false,
        conceptualAnalysis: null,
        fileHash,
        agentTurns: null
      };
      saveDeedLogWrapper(req, batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
        'SKIPPED', 'Excluded by document classifier (SKIP)', JSON.stringify({ courses: [], classification: 'LOT_BLOCK' }), null, null, null, null, fileHash);

      if (autoOutput) {
        try {
          const outputFolder = getOrCreateOutputFolder(req, validPath);
          await output.writeResultFiles(outputFolder, fileName, result, null, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
        } catch (ex) { console.warn('Auto-output failed:', ex.message); }
      }

      await sendResponse('success', result);
      return;
    }

    // Check cache (unless forced)
    const force = req.query.force === 'true';
    let rawDocText = '';
    let resolvedCounty = county;
    let resolvedState = state;

    // Resolve county/state early for caching/output accuracy
    if (!resolvedCounty || !resolvedState) {
      try {
        rawDocText = await ensureExtractedText(filePath, fileName, imageBytes, validPath);
        const docInferred = geminiVision.inferCountyStateFromText(rawDocText || '');
        resolvedCounty = resolvedCounty || docInferred.county || null;
        resolvedState = resolvedState || docInferred.state || null;
      } catch (err) {
        console.warn('Failed early county/state inference:', err.message);
      }
    }

    if (!force) {
      const solvedCase = db.findSolvedCase(fileName, fileHash);
      if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
        const cachedEx = JSON.parse(solvedCase.extractionJson);
        const cachedTr = JSON.parse(solvedCase.traverseJson);
        const courses = cachedEx.courses || cachedEx.Courses || [];

        // Sanity-check: a valid deed must have at least 3 boundary courses.
        // If the cached extraction has fewer, it's a stale/incomplete entry
        // (e.g. from a previously crashed extraction run). Invalidate and reprocess.
        if (courses.length < 3) {
          console.warn(`Cache hit for ${fileName} has only ${courses.length} course(s) — invalidating stale cache entry and reprocessing.`);
          // Fall through to full processing below
        } else {
          console.log(`Cache hit for ${fileName} (hash=${fileHash})`);

          // Extract from solvedCase.parcelName if possible
          const labelInferred = geminiVision.inferCountyStateFromText(solvedCase.parcelName || '');
          const cacheCounty = resolvedCounty || labelInferred.county || null;
          const cacheState = resolvedState || labelInferred.state || null;

          cachedEx.county = getCountyVal(cachedEx, cacheCounty);
          cachedEx.state = getStateVal(cachedEx, cacheState);

          let cachedWrite = null;
          if (courses.length > 0) {
            try {
              cachedWrite = {
                legalDescription: legalWriter.write({
                  courses,
                  pobNorthing: pobN,
                  pobEasting: pobE,
                  county: cachedEx.county,
                  state: cachedEx.state,
                  units: units.toLowerCase(),
                  areaAcres: cachedTr.areaAcres ?? cachedTr.AreaAcres ?? 0,
                  perimeter: cachedTr.perimeter ?? cachedTr.Perimeter ?? 0
                }),
                courseCount: courses.length
              };
            } catch {}
          }
          const result = { 
            fileName, status: 'success', extraction: cachedEx, traverse: cachedTr, legalDescription: cachedWrite, error: null, cached: true, fileHash, 
            agentTurns: solvedCase.agentTurnsJson ? JSON.parse(solvedCase.agentTurnsJson) : null,
            solutionSteps: solvedCase.solutionStepsJson ? JSON.parse(solvedCase.solutionStepsJson) : null
          };
          const linErr = cachedTr.closure?.linearError ?? cachedTr.Closure?.LinearError ?? 0;
          const precRatio = cachedTr.closure?.precisionRatio ?? cachedTr.Closure?.PrecisionRatio ?? '';
          const cachedLabel = cacheCounty && cacheState ? `${cacheCounty}, ${cacheState}` : (solvedCase.parcelName || 'CACHED');
          saveDeedLogWrapper(req, batchId, fileName, cachedLabel,
            courses.length, linErr,
            parsePrecisionRatio(precRatio), solvedCase.status || 'PASS', 'Stage 5: SQLite Case Finder Solved',
            solvedCase.extractionJson, solvedCase.traverseJson, null, null, null, fileHash);

          if (autoOutput) {
            try {
              const outputFolder = getOrCreateOutputFolder(req, validPath);
              await output.writeResultFiles(outputFolder, fileName, result, cachedWrite, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
            } catch (ex) { console.warn('Auto-output failed:', ex.message); }
          }

          await sendResponse('success', result);
          return;
        }
      }

      const skippedCase = db.findSkippedCase(fileName, fileHash);
      if (skippedCase?.extractionJson) {
        console.log(`Cache hit (SKIPPED) for ${fileName} (hash=${fileHash})`);
        const cachedEx = JSON.parse(skippedCase.extractionJson);
        const result = {
          fileName,
          status: 'skipped',
          extraction: cachedEx,
          traverse: null,
          legalDescription: null,
          error: null,
          skipReason: skippedCase.repairStageUsed || `Non-traversable: ${cachedEx.classification}`,
          conceptualAnalysis: cachedEx.conceptualAnalysis || null,
          cached: true,
          fileHash,
          agentTurns: null
        };
        saveDeedLogWrapper(req, batchId, fileName, skippedCase.parcelName || `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0, 'SKIPPED', skippedCase.repairStageUsed || 'Non-traversable document', skippedCase.extractionJson, null, null, null, null, fileHash);

        await sendResponse('success', result);
        return;
      }
    }

    if (isWordDocument(fileName)) {
      console.log(`Converting Word doc ${fileName} to PDF with fallback...`);
      const resFallback = await readWordDocWithFallback(filePath, fileName, imageBytes);
      imageBytes = resFallback.bytes;
      mime = resFallback.mime;
    }

    // Rec 4 — Multi-part deed chaining:
    // If this file looks like "12345L2.doc" or "12345L-B.doc" and Part A already
    // passed in this server session, use Part A's last station as POB instead of
    // the default (5000, 5000), so Part B closes relative to where Part A ended.
    const _partFamily = _getPartFamily(fileName);
    let chainedPob = { northing: pobN, easting: pobE };
    if (_partFamily && _partFamily.partOrder > 1) {
      const parentEndpoint = familyEndpoints.get(_partFamily.base);
      if (parentEndpoint) {
        chainedPob = parentEndpoint;
        console.log(`[Rec4 Chain] ${fileName} is Part ${_partFamily.part} of family "${_partFamily.base}" — using chained POB N${chainedPob.northing.toFixed(2)} E${chainedPob.easting.toFixed(2)}`);
      }
    }
    const pob = chainedPob;

    if (!rawDocText) {
      try {
        rawDocText = await ensureExtractedText(filePath, fileName, imageBytes, validPath);
      } catch (err) {
        console.warn('Failed to ensure extracted text:', err.message);
      }
    }

    // ── Multi-Parcel Fan-Out (process-file) ──────────────────────────────────
    const namedParcels = extractNamedParcels(rawDocText);
    if (namedParcels && namedParcels.length >= 2) {
      console.log(`FolderScan process-file: Multi-parcel deed detected in ${fileName} — ${namedParcels.length} parcels`);
      
      let parcelResults = [];
      const baseName = path.parse(fileName).name;
      const ext = path.extname(fileName);
      for (const { label, text: parcelText } of namedParcels) {
        const parcelFileName = `${baseName}__${label}${ext}`;
        const parcelHash = crypto.createHash('sha256').update(parcelText).digest('hex');

        // Check cache (unless forced)
        if (!force) {
          const solvedCase = db.findSolvedCase(parcelFileName, parcelHash);
          if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
            console.log(`Cache hit for parcel ${label} (${parcelFileName}) (hash=${parcelHash})`);
            const cachedEx = JSON.parse(solvedCase.extractionJson);
            const cachedTr = JSON.parse(solvedCase.traverseJson);

            // Extract from solvedCase.parcelName if possible
            const labelInferred = geminiVision.inferCountyStateFromText(solvedCase.parcelName || '');
            const cacheCounty = resolvedCounty || labelInferred.county || null;
            const cacheState = resolvedState || labelInferred.state || null;

            cachedEx.county = getCountyVal(cachedEx, cacheCounty);
            cachedEx.state = getStateVal(cachedEx, cacheState);

            let cachedWrite = null;
            if (cachedEx.courses?.length > 0) {
              try {
                cachedWrite = {
                  legalDescription: legalWriter.write({
                    courses: cachedEx.courses, pobNorthing: pobN, pobEasting: pobE, county: cachedEx.county, state: cachedEx.state, units: units.toLowerCase(), areaAcres: cachedTr.areaAcres, perimeter: cachedTr.perimeter
                  }),
                  courseCount: cachedEx.courses.length
                };
              } catch {}
            }
            const pRes = { 
              fileName: parcelFileName, status: 'success', extraction: cachedEx, traverse: cachedTr, legalDescription: cachedWrite, error: null, fileHash: parcelHash, 
              agentTurns: solvedCase.agentTurnsJson ? JSON.parse(solvedCase.agentTurnsJson) : null,
              solutionSteps: solvedCase.solutionStepsJson ? JSON.parse(solvedCase.solutionStepsJson) : null
            };
            parcelResults.push(pRes);
            const pLabel = cacheCounty && cacheState ? `${cacheCounty}, ${cacheState}` : `[${label}] ${baseName}`;
            saveDeedLogWrapper(req, batchId, parcelFileName, pLabel, cachedEx.courses?.length || 0, cachedTr.closure?.linearError || 0, parsePrecisionRatio(cachedTr.closure?.precisionRatio), 'PASS', 'Stage 5: SQLite Case Finder Solved', solvedCase.extractionJson, solvedCase.traverseJson, null, null, null, parcelHash);
            continue;
          }

          const skippedCase = db.findSkippedCase(parcelFileName, parcelHash);
          if (skippedCase?.extractionJson) {
            console.log(`Cache hit (SKIPPED) for parcel ${label} (${parcelFileName}) (hash=${parcelHash})`);
            const cachedEx = JSON.parse(skippedCase.extractionJson);
            const pRes = {
              fileName: parcelFileName,
              status: 'skipped',
              extraction: cachedEx,
              traverse: null,
              legalDescription: null,
              error: null,
              skipReason: skippedCase.repairStageUsed || `Non-traversable: ${cachedEx.classification}`,
              conceptualAnalysis: cachedEx.conceptualAnalysis || null,
              fileHash: parcelHash,
              agentTurns: null
            };
            parcelResults.push(pRes);
            const pLabel = `[${label}] ${resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : baseName}`;
            saveDeedLogWrapper(req, batchId, parcelFileName, pLabel, 0, 0, 0, 'SKIPPED', skippedCase.repairStageUsed || 'Non-traversable document', skippedCase.extractionJson, null, null, null, null, parcelHash);
            continue;
          }
        }

        if (!geminiVision.hasBoundaryKeywords(parcelText)) {
          console.log(`FolderScan process-file: skipping parcel ${label} (${parcelFileName}) - no boundary keywords`);
          const pRes = {
            fileName: parcelFileName,
            status: 'skipped',
            extraction: { courses: [], classification: 'LOT_BLOCK', rawText: parcelText },
            traverse: null,
            legalDescription: null,
            error: null,
            skipReason: 'Non-traversable (no boundary keywords)',
            fileHash: parcelHash,
            agentTurns: null
          };
          parcelResults.push(pRes);
          const pLabel = `[${label}] ${resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : baseName}`;
          saveDeedLogWrapper(req, batchId, parcelFileName, pLabel, 0, 0, 0, 'SKIPPED', 'Non-traversable document (pre-check)', JSON.stringify(pRes.extraction), null, null, null, null, parcelHash);
          continue;
        }

        const isOE = detectOpenEnded(parcelText, parcelFileName, false);
        
        // Try offline PLSS intercept first for the parcel
        const plssParsedObj = shouldInterceptPLSS(parcelText) ? plssParser.parsePlss(parcelText) : null;
        if (plssParsedObj) {
          console.log(`[FolderScan Intercept] Found PLSS in parcel ${label} (${parcelFileName}) - bypassing LLM.`, plssParsedObj);
          const platResult = await platLookup.resolvePlss(plssParsedObj, pob);
          if (platResult && !platResult.needsManual && platResult.courses?.length > 0) {
            const extraction = {
              courses: platResult.courses,
              classification: 'SECTION_BREAKDOWN',
              rawText: parcelText,
            };
            const traverse = traverseSvc.compute({ pointOfBeginning: pob, courses: platResult.courses, units, isOpenEnded: false });
            let writeResult = null;
            try {
              writeResult = {
                legalDescription: legalWriter.write({
                  courses: platResult.courses,
                  pobNorthing: pobN,
                  pobEasting: pobE,
                  county: getCountyVal(extraction, resolvedCounty),
                  state: getStateVal(extraction, resolvedState),
                  units: units.toLowerCase(),
                  areaAcres: platResult.areaAcres,
                  perimeter: traverse?.perimeter
                }),
                courseCount: platResult.courses.length
              };
            } catch {}

            const pRes = { fileName: parcelFileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, platLookup: platResult, fileHash: parcelHash, agentTurns: null };
            parcelResults.push(pRes);

            const stageLabel = `Stage 1.5: Offline PLSS Intercept (${platResult.isFallback ? 'fallback grid' : 'BLM API'})`;
            const pLabel = `[${label}] ${resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : baseName}`;
            saveDeedLogWrapper(req, batchId, parcelFileName, pLabel, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse), null, null, null, parcelHash);
            
            continue;
          }
        }

        try {
          const pResult = await runRepairPipeline(Buffer.from(parcelText, 'utf-8'), 'text/plain', pob, units, isOE, parcelFileName);
          let pEx = pResult.finalExtraction;
          let pTr = pResult.finalTraverse;
          let pStatus = pResult.status;
          let pStage  = pResult.repairStageUsed;
          const pLabel  = `[${label}] ${resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : baseName}`;

          const isNonTraversable = (!pEx.courses || pEx.courses.length === 0) &&
            (['PLAT', 'LOT_BLOCK', 'SECTION_BREAKDOWN'].includes(pEx.classification) ||
             (pResult.traverseError || '').toLowerCase().includes('no traversable') ||
             (pResult.traverseError || '').toLowerCase().includes('zero segment') ||
             !geminiVision.hasBoundaryKeywords(pEx.rawText || parcelText || ''));

          if (isNonTraversable) {
            pStatus = 'SKIPPED';
            pStage = 'Non-traversable document';
          }
          
          let pWrite = null;
          if (pEx.courses?.length > 0) {
            try {
              pWrite = {
                legalDescription: legalWriter.write({
                  courses: pEx.courses, pobNorthing: pobN, pobEasting: pobE, county: getCountyVal(pEx, resolvedCounty), state: getStateVal(pEx, resolvedState), units: units.toLowerCase(), areaAcres: pTr?.areaAcres, perimeter: pTr?.perimeter
                }),
                courseCount: pEx.courses.length
              };
            } catch {}
          }

          let finalStatus = 'error';
          if (pStatus === 'PASS' || pStatus === 'MEANDER') {
            finalStatus = 'success';
          } else if (pStatus === 'SKIPPED') {
            finalStatus = 'skipped';
          }

          const pRes = { fileName: parcelFileName, status: finalStatus, extraction: pEx, traverse: pTr, legalDescription: pWrite, error: pResult.traverseError, platLookup: null, fileHash: parcelHash, agentTurns: pResult.agentTurns || null };
          parcelResults.push(pRes);

          saveDeedLogWrapper(req, 
            batchId, parcelFileName, pLabel,
            pEx?.courses?.length || 0,
            pTr?.closure?.linearError || 0,
            parsePrecisionRatio(pTr?.closure?.precisionRatio),
            pStatus, pStage,
            JSON.stringify(pEx),
            pTr ? JSON.stringify(pTr) : null,
            pResult.agentTurns ? JSON.stringify(pResult.agentTurns) : null,
            pResult.trustScore ?? null,
            pResult.solutionSteps ? JSON.stringify(pResult.solutionSteps) : null,
            parcelHash
          );
        } catch (parcelEx) {
          console.warn(`FolderScan process-file: Parcel ${label} (${parcelFileName}) failed:`, parcelEx.message);
        }
      }

      if (parcelResults.length > 0) {
        const combinedExtraction = {
          ...parcelResults[0].extraction,
          parcels: parcelResults.map((pr, pi) => ({
            parcelId: pr.fileName.replace(`${baseName}__`, '').replace(ext, ''),
            extraction: pr.extraction,
            traverse: pr.traverse,
            legalDescription: pr.legalDescription,
            status: pr.status
          }))
        };
        const result = {
          fileName,
          status: 'success',
          isMultiParcel: true,
          parcels: parcelResults,
          extraction: combinedExtraction,
          traverse: parcelResults[0].traverse,
          legalDescription: parcelResults[0].legalDescription,
          error: null,
          cached: false,
          fileHash,
          agentTurns: null
        };
        if (autoOutput) {
          try {
            const outputFolder = getOrCreateOutputFolder(req, validPath);
            for (const pr of parcelResults) {
              await output.writeResultFiles(outputFolder, pr.fileName, pr, pr.legalDescription, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
            }
          } catch (ex) { console.warn('Auto-output failed:', ex.message); }
        }

        await sendResponse('success', result);
        return;
      }
    }

    if (rawDocText) {
      const plssParsedObj = shouldInterceptPLSS(rawDocText) ? plssParser.parsePlss(rawDocText) : null;
      if (plssParsedObj) {
        console.log(`[FolderScan Intercept] Found PLSS in ${fileName} - bypassing LLM.`, plssParsedObj);
        const platResult = await platLookup.resolvePlss(plssParsedObj, pob);
        if (platResult && !platResult.needsManual && platResult.courses?.length > 0) {
          const extraction = {
            courses: platResult.courses,
            classification: 'SECTION_BREAKDOWN',
            rawText: rawDocText,
          };
          const traverse = traverseSvc.compute({ pointOfBeginning: pob, courses: platResult.courses, units, isOpenEnded: false });
          let writeResult = null;
          try {
            writeResult = {
              legalDescription: legalWriter.write({
                courses: platResult.courses,
                pobNorthing: pobN,
                pobEasting: pobE,
                county: getCountyVal(extraction, resolvedCounty),
                state: getStateVal(extraction, resolvedState),
                units: units.toLowerCase(),
                areaAcres: platResult.areaAcres,
                perimeter: traverse?.perimeter
              }),
              courseCount: platResult.courses.length
            };
          } catch {}

          const result = { fileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, cached: false, platLookup: platResult, fileHash, agentTurns: null };
          const stageLabel = `Stage 1.5: Offline PLSS Intercept (${platResult.isFallback ? 'fallback grid' : 'BLM API'})`;
          saveDeedLogWrapper(req, batchId, fileName, resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : `[PLAT-INTERCEPT] ${path.parse(fileName).name}`, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse), null, null, null, fileHash);
          
          if (autoOutput) {
            try {
              const outputFolder = getOrCreateOutputFolder(req, validPath);
              await output.writeResultFiles(outputFolder, fileName, result, writeResult, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
            } catch (ex) { console.warn('Auto-output failed:', ex.message); }
          }

          await sendResponse('success', result);
          return;
        }
      }
    }

    if (rawDocText && rawDocText.trim().length >= 80 && !geminiVision.hasBoundaryKeywords(rawDocText)) {
      console.log(`FolderScan: ${fileName} — SKIPPED (non-traversable: no boundary keywords in document text)`);
      const extraction = { courses: [], classification: 'LOT_BLOCK', rawText: rawDocText || '' };
      const result = {
        fileName, status: 'skipped',
        extraction, traverse: null, legalDescription: null,
        error: null,
        skipReason: `Document contains no boundary keywords (LOT_BLOCK).`,
        cached: false,
        conceptualAnalysis: null,
        fileHash,
        agentTurns: null
      };
      saveDeedLogWrapper(req, batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
        'SKIPPED', 'Non-traversable document (pre-check)', JSON.stringify(extraction), null, null, null, null, fileHash);

      if (autoOutput) {
        try {
          const outputFolder = getOrCreateOutputFolder(req, validPath);
          await output.writeResultFiles(outputFolder, fileName, result, null, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
        } catch (ex) { console.warn('Auto-output failed:', ex.message); }
      }

      await sendResponse('success', result);
      return;
    }

    const repairResult = await runRepairPipeline(imageBytes, mime, pob, units, isOpenEnded, fileName);

    const extraction = repairResult.finalExtraction;
    if (extraction && !extraction.rawText) {
      extraction.rawText = rawDocText || '';
    }
    const originalLegalDesc = extraction.originalLegalDesc || repairResult.originalExtraction?.originalLegalDesc || null;
    if (originalLegalDesc) {
      try {
        const base = path.parse(fileName).name;
        const extractedTxtPath = path.join(validPath, '_extracted', base + '.txt');
        fs.writeFileSync(extractedTxtPath, originalLegalDesc, 'utf-8');
        console.log(`Updated cache file ${extractedTxtPath} with isolated original deed text.`);
      } catch (err) {
        console.warn(`Failed to update extracted cache file:`, err.message);
      }
    }
    const traverse = repairResult.finalTraverse;
    const status = repairResult.status;
    const stageUsed = repairResult.repairStageUsed;

    let writeResult = null;
    if (extraction.courses?.length > 0) {
      try {
        writeResult = { legalDescription: legalWriter.write({ courses: extraction.courses, pobNorthing: pobN, pobEasting: pobE, county: getCountyVal(extraction, resolvedCounty), state: getStateVal(extraction, resolvedState), units: units.toLowerCase(), areaAcres: traverse?.areaAcres, perimeter: traverse?.perimeter }), courseCount: extraction.courses.length };
      } catch {}
    }

    // Detect non-traversable documents (certification pages, title commitments, etc.)
    const isNonTraversable = (!extraction.courses || extraction.courses.length === 0) &&
      (['PLAT', 'LOT_BLOCK', 'SECTION_BREAKDOWN'].includes(extraction.classification) ||
       (repairResult.traverseError || '').toLowerCase().includes('no traversable') ||
       (repairResult.traverseError || '').toLowerCase().includes('zero segment') ||
       !geminiVision.hasBoundaryKeywords(extraction.rawText || rawDocText || ''));

    if (isNonTraversable) {
      console.log(`FolderScan: ${fileName} — SKIPPED (non-traversable: ${extraction.classification})`);
      const result = {
        fileName, status: 'skipped',
        extraction, traverse: null, legalDescription: null,
        error: null,
        skipReason: `Document contains no traversable boundary geometry (AI classification: ${extraction.classification}).`,
        cached: false,
        conceptualAnalysis: extraction.conceptualAnalysis || null,
        fileHash,
        agentTurns: null
      };
      saveDeedLogWrapper(req, batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
        'SKIPPED', 'Non-traversable document', JSON.stringify(extraction), null, null, null, null, fileHash);

      // Auto-output if enabled
      if (autoOutput) {
        try {
          const outputFolder = getOrCreateOutputFolder(req, validPath);
          await output.writeResultFiles(outputFolder, fileName, result, null, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
        } catch (ex) { console.warn('Auto-output failed:', ex.message); }
      }

      await sendResponse('skipped', result);
      return;
    }

    const result = {
      fileName,
      status: (status === 'PASS' || status === 'MEANDER') ? 'success' : 'error',
      extraction,
      traverse,
      legalDescription: writeResult,
      error: repairResult.traverseError,
      originalExtraction: repairResult.originalExtraction,
      cached: false,
      solutionSteps: repairResult.solutionSteps || null,
      conceptualAnalysis: extraction.conceptualAnalysis || null,
      fileHash,
      agentTurns: repairResult.agentTurns || null
    };

    const parcelLabel = resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : `[${extraction.classification}] ${path.parse(fileName).name}`;
    const stepsJson = repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null;
    saveDeedLogWrapper(req, batchId, fileName, parcelLabel, extraction.courses?.length || 0, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), status, stageUsed, JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null, repairResult.agentTurns ? JSON.stringify(repairResult.agentTurns) : null, repairResult.trustScore ?? null, stepsJson, fileHash);
    if (extraction.courses?.length > 0) db.incrementHeuristic(stageUsed, 'FolderScan auto-repair');

    // Rec 4: Record endpoint for potential Part B chaining
    if ((status === 'PASS' || status === 'MEANDER') && _partFamily) {
      const stations = traverse?.adjustedStations || traverse?.stations || [];
      const lastSt = stations[stations.length - 1];
      if (lastSt?.northing != null && lastSt?.easting != null) {
        familyEndpoints.set(_partFamily.base, { northing: lastSt.northing, easting: lastSt.easting });
        console.log(`[Rec4 Chain] Recorded endpoint for family "${_partFamily.base}": N${lastSt.northing.toFixed(2)} E${lastSt.easting.toFixed(2)}`);
      }
    }

    // Auto-output
    if (autoOutput) {
      try {
        const outputFolder = getOrCreateOutputFolder(req, validPath);
        await output.writeResultFiles(outputFolder, fileName, result, writeResult, shortFileNames, showConceptualDetail, leaderStyle, labelContentMode);
      } catch (ex) { console.warn('Auto-output failed:', ex.message); }
    }

    await sendResponse((status === 'PASS' || status === 'MEANDER') ? 'success' : 'error', result);
  } catch (ex) {
    if (keepAlive) clearInterval(keepAlive);
    console.error(`FolderScan item failed: ${req.query.file}`, ex.message);
    if (res.headersSent) {
      res.write(JSON.stringify({ error: ex.message }));
      res.end();
    } else {
      res.status(500).json({ error: ex.message });
    }
  }
});

// ── POST /api/folderscan/chain-adjacent ──────────────────────────────────────
// Resolves an Adjacent Lot Review failure by chaining a secondary deed.
// Body: { primaryCourses, secondaryDeedText, pob, units, county, state, fileName, batchId }
router.post('/chain-adjacent', async (req, res) => {
  try {
    const {
      primaryCourses,
      secondaryDeedText,
      pob,
      units = 'Feet',
      county = null,
      state  = null,
      fileName = 'unknown',
      batchId: inBatchId,
    } = req.body;

    if (!primaryCourses || !Array.isArray(primaryCourses)) {
      return res.status(400).json({ error: 'primaryCourses array is required.' });
    }
    if (!secondaryDeedText || secondaryDeedText.trim().length < 10) {
      return res.status(400).json({ error: 'secondaryDeedText is required.' });
    }

    const pobN = pob?.northing ?? 5000;
    const pobE = pob?.easting  ?? 5000;
    const batchId = inBatchId || uuidv4();
    db.saveBatchRun(batchId, 1, 0.0);

    console.log(`Chain-Adjacent: ${fileName} — extracting secondary deed (${secondaryDeedText.length} chars)…`);

    // Step 1: AI-extract courses from the secondary deed text
    let secondaryCourses = [];
    try {
      // Convert text to buffer for geminiVision
      const textBuf  = Buffer.from(secondaryDeedText, 'utf-8');
      const secResult = await geminiVision.extractBoundary(textBuf, 'text/plain');
      secondaryCourses = secResult?.courses || [];
      console.log(`Chain-Adjacent: extracted ${secondaryCourses.length} secondary courses`);
    } catch (aiEx) {
      console.warn(`Chain-Adjacent: AI extraction of secondary deed failed: ${aiEx.message}`);
    }

    // Step 2: Flag reference parcel calls in the primary courses
    const flagged = resolver.flagReferenceParcelCalls(primaryCourses);

    // Step 3: Run the splice engine
    const { resolvedCourses, log, strategy, spliced } =
      resolver.resolveWithSecondary(flagged, secondaryCourses, { northing: pobN, easting: pobE }, units);

    console.log(`Chain-Adjacent: strategy=${strategy || 'gap-solver'}, spliced=${spliced}, log=[${log.slice(-2).join(' | ')}]`);

    // Step 4: Compute traverse with resolved courses
    let traverse = null, traverseError = null, status = 'FAIL';
    try {
      traverse = traverseSvc.compute({
        pointOfBeginning: { northing: pobN, easting: pobE },
        courses: resolvedCourses,
        units,
        isOpenEnded: false,
      });
      // Check closure
      const linErr  = traverse.closure?.linearError ?? Infinity;
      const precStr = traverse.closure?.precisionRatio ?? '';
      const precVal = (() => {
        const p = precStr.split(':');
        if (p.length < 2) return 0;
        return parseFloat(p[1].replace(/,/g,'').replace('∞','999999999').trim()) || 0;
      })();
      if (linErr < 0.30 || precVal >= 10000) status = 'PASS';
      else if (linErr <= 1.0 && precVal >= 5000) status = 'PASS'; // Compass Rule
    } catch (tEx) {
      traverseError = tEx.message;
    }

    // Step 5: Write legal description if passing
    let writeResult = null;
    if (status === 'PASS' && resolvedCourses.length > 0) {
      try {
        writeResult = {
          legalDescription: legalWriter.write({
            courses: resolvedCourses, pobNorthing: pobN, pobEasting: pobE,
            county, state, units: units.toLowerCase(),
            areaAcres: traverse?.areaAcres, perimeter: traverse?.perimeter,
          }),
          courseCount: resolvedCourses.length,
        };
      } catch {}
    }

    const stageLabel = `Stage 4.5: Adjacent Lot Chain (${strategy || 'gap-solver'})${spliced ? ' [spliced]' : ''}`;
    saveDeedLogWrapper(req, batchId, fileName,
      county && state ? `${county}, ${state}` : `[CHAIN] ${fileName}`,
      resolvedCourses.length,
      traverse?.closure?.linearError ?? 999,
      parsePrecisionRatio(traverse?.closure?.precisionRatio),
      status, stageLabel,
      JSON.stringify({ courses: resolvedCourses }),
      traverse ? JSON.stringify(traverse) : null
    );

    res.json({
      status: (status === 'PASS' || status === 'MEANDER') ? 'success' : 'error',
      result: {
        fileName,
        status: (status === 'PASS' || status === 'MEANDER') ? 'success' : 'error',
        extraction: { courses: resolvedCourses, classification: 'METES_BOUNDS' },
        traverse,
        legalDescription: writeResult,
        error: traverseError,
        repairStageUsed: stageLabel,
        chainLog: log,
        strategy,
        spliced,
        secondaryCoursesExtracted: secondaryCourses.length,
      },
    });
  } catch (ex) {
    console.error('chain-adjacent error:', ex);
    res.status(500).json({ error: ex.message });
  }
});

// ── POST /api/folderscan/resolve-plat-manual ─────────────────────────────────
// Resolves a LOT_BLOCK Tier 3 failure using manually entered N/E coordinates.
// Body: { manualCoords: [{northing, easting}], pob, units, county, state, fileName, batchId }
router.post('/resolve-plat-manual', async (req, res) => {
  try {
    const { manualCoords, pob, units = 'Feet', county, state, fileName = 'unknown', batchId: inBatchId } = req.body;
    if (!manualCoords || manualCoords.length < 3) return res.status(400).json({ error: 'At least 3 coordinate pairs required.' });

    const pobN = pob?.northing ?? 5000;
    const pobE = pob?.easting  ?? 5000;
    const batchId = inBatchId || uuidv4();
    db.saveBatchRun(batchId, 1, 0.0);

    const platResult = platLookup.resolveManualCoords(manualCoords);
    const traverse   = traverseSvc.compute({ pointOfBeginning: { northing: pobN, easting: pobE }, courses: platResult.courses, units, isOpenEnded: false });
    let writeResult = null;
    try {
      writeResult = { legalDescription: legalWriter.write({ courses: platResult.courses, pobNorthing: pobN, pobEasting: pobE, county, state, units: units.toLowerCase(), areaAcres: platResult.areaAcres, perimeter: traverse?.perimeter }), courseCount: platResult.courses.length };
    } catch {}

    const stageLabel = 'Stage 4.5: LOT_BLOCK Manual Plat Coordinates (Tier 3)';
    saveDeedLogWrapper(req, batchId, fileName, county && state ? `${county}, ${state}` : `[MANUAL-PLAT] ${fileName}`, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify({ courses: platResult.courses }), JSON.stringify(traverse));

    res.json({
      status: 'success',
      result: { fileName, status: 'success', extraction: { courses: platResult.courses, classification: 'LOT_BLOCK' }, traverse, legalDescription: writeResult, error: null, platLookup: platResult, repairStageUsed: stageLabel },
    });
  } catch (ex) {
    console.error('resolve-plat-manual error:', ex);
    res.status(500).json({ error: ex.message });
  }
});

// ── POST /api/folderscan/retry-failed ─────────────────────────────────────────
// Streams SSE progress. Iterates all unresolved failed files using local Ollama
// models only (no cloud credits). Tries each model in cascade until one passes.
// Query params:
//   path      — folder where deed files live
//   pobN/pobE — POB defaults
//   units     — Feet|Meters
//   concurrency — parallel workers (default 2 for local LLM)
router.post('/retry-failed', async (req, res) => {
  const validPath = validatePath(req.query.path);
  if (!validPath) return res.status(403).json({ error: 'Path not allowed.' });
  if (!fs.existsSync(validPath)) return res.status(404).json({ error: 'Directory not found.' });

  if (!acquireLock('retry-failed', req.query.path)) {
    const info = _processingInfo;
    const elapsed = info ? Math.round((Date.now() - info.startTime) / 1000) : 0;
    return res.status(503).json({
      error: `Server is already processing (${info?.type ?? 'unknown'} — ${elapsed}s elapsed). Please wait for it to finish or restart the server.`
    });
  }

  const pobN      = parseFloat(req.query.pobN) || 5000;
  const pobE      = parseFloat(req.query.pobE) || 5000;
  const refName = req.query.refName || null;
  const refN = req.query.refN != null ? parseFloat(req.query.refN) : null;
  const refE = req.query.refE != null ? parseFloat(req.query.refE) : null;
  const units     = req.query.units || 'Feet';
  const county    = req.query.county || null;
  const state     = req.query.state  || null;
  const maxPasses = parseInt(req.query.maxPasses) || 3;   // retry rounds
  const concurrency = 1;  // MUST be 1 — setProvider() is global state; concurrent calls corrupt each other
  const PER_FILE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min max per file

  // Local model cascade — dynamically query available models from local Ollama
  const hasGemini = !!GEMINI_API_KEY;
  let LOCAL_MODELS = ['gemma3:4b', 'llama3.2:3b'];
  if (!hasGemini) {
    LOCAL_MODELS.push('deepseek-r1:8b');
    LOCAL_MODELS.push('deepseek-r1:14b');
    LOCAL_MODELS.push('gemma4:26b');
  }

  try {
    const status = await ollamaSvc.getStatus();
    if (status.online && status.models && status.models.length > 0) {
      // Sort status.models so that faster/smaller models come first:
      // - Prioritize models containing '1.5b', '2b', '3b', '4b', 'gemma3'
      // - Deprioritize models containing 'deepseek', 'r1', '8b', '7b', '26b'
      const sortedModels = [...status.models].sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        
        const isSlow = (name) => name.includes('deepseek') || name.includes('r1') || name.includes('8b') || name.includes('7b') || name.includes('26b');
        const aSlow = isSlow(aLower);
        const bSlow = isSlow(bLower);
        
        if (aSlow && !bSlow) return 1;
        if (!aSlow && bSlow) return -1;
        
        return aLower.localeCompare(bLower);
      });

      for (const m of sortedModels) {
        if (hasGemini && (m.includes('8b') || m.includes('14b') || m.includes('26b') || m.includes('70b') || m.includes('32b') || m.includes('deepseek') || m.includes('r1'))) {
          // Skip heavy local models on CPU since we have Gemini API fallback
          continue;
        }
        if (!LOCAL_MODELS.includes(m)) {
          LOCAL_MODELS.push(m);
        }
      }
    }
  } catch (err) {
    console.error('Failed to retrieve online local models:', err);
  }

  if (hasGemini) {
    LOCAL_MODELS.push('gemini:gemini-2.5-flash');
    LOCAL_MODELS.push('gemini:gemini-2.5-pro');
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Auto-release lock on premature disconnect / abort
  req.on('close', () => {
    if (!res.writableEnded) {
      console.log('🔌 Client disconnected from /retry-failed — releasing processing lock...');
      releaseLock();
    }
  });

  // Guard all writes — never throw if the client disconnected
  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    } catch { /* client disconnected mid-stream */ }
  };

  // Keepalive heartbeat every 25s — prevents proxy/browser from killing idle SSE
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(heartbeat); return; }
    try { res.write(': heartbeat\n\n'); if (res.flush) res.flush(); } catch { clearInterval(heartbeat); }
  }, 25000);

  // Save original provider so we can restore after
  const originalProvider = geminiVision.getActiveProvider();
  const originalModel    = geminiVision.getActiveModel();

  const provider = req.query.provider || originalProvider;
  let modelsToTry = [];
  if (provider === 'gemini') {
    modelsToTry = [req.query.model || originalModel || 'gemini-2.5-flash'];
  } else if (provider === 'openai') {
    modelsToTry = [req.query.model || originalModel || 'llama3'];
  } else {
    modelsToTry = LOCAL_MODELS;
  }

  try {
    // Get all files that are still failing
    const failedFileNames = db.getFailedFileNames();
    send('init', { total: failedFileNames.length, models: modelsToTry, maxPasses });

    if (failedFileNames.length === 0) {
      send('done', { fixed: 0, stillFailing: 0, message: 'No failed files to retry.' });
      res.end();
      return;
    }

    // Resolve file names to full paths (recursively search validPath if not found directly)
    const findFileRecursive = (dir, name, depth = 0) => {
      if (depth > 6) return null; // Prevent runaway recursion
      
      // Handle multi-parcel filenames containing '__'
      let cleanName = name;
      if (name.includes('__')) {
        const parts = name.split('__');
        const ext = path.extname(name);
        cleanName = parts[0] + ext;
      }
      
      const direct = path.join(dir, cleanName);
      if (fs.existsSync(direct)) return direct;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const targetLower = cleanName.toLowerCase();
        
        // First check files in this directory case-insensitively
        for (const entry of entries) {
          if (entry.isFile() && entry.name.toLowerCase() === targetLower) {
            return path.join(dir, entry.name);
          }
        }
        
        // Recurse into directories
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subDir = path.join(dir, entry.name);
            const found = findFileRecursive(subDir, cleanName, depth + 1);
            if (found) return found;
          }
        }
      } catch (err) {
        console.error(`Failed to read directory recursively: ${dir}`, err);
      }
      return null;
    };

    const queue = failedFileNames
      .map(fn => {
        const fp = findFileRecursive(validPath, fn);
        return fp ? { fileName: fn, filePath: fp } : null;
      })
      .filter(Boolean);

    const notFound = failedFileNames.length - queue.length;
    send('status', { message: `Found ${queue.length} files on disk (${notFound} not found in this folder)`, notFound });

    let fixed = 0, stillFailing = 0, skipped = 0;
    const batchId = uuidv4();
    db.saveBatchRun(batchId, queue.length, 0);

    // Process with concurrency limit — use atomic index capture to avoid cursor++ race
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const myIndex = cursor++;          // atomic in single-threaded JS
        if (myIndex >= queue.length) break;
        const item = queue[myIndex];
        if (!item) continue;
        const { fileName, filePath } = item;

        if (res.writableEnded) break;     // client disconnected — stop processing

        send('file-start', { fileName, index: myIndex + 1, total: queue.length, pct: Math.round((myIndex / queue.length) * 100) });

        // Read + convert the file ONCE before trying any model (saves disk I/O and LibreOffice calls)
        let imageBytes, mime;
        try {
          imageBytes = await fs.promises.readFile(filePath);
          mime = inferMimeType(fileName);
          if (isWordDocument(fileName)) {
            console.log(`Converting Word doc ${fileName} to PDF with fallback...`);
            const resFallback = await readWordDocWithFallback(filePath, fileName, imageBytes);
            imageBytes = resFallback.bytes;
            mime = resFallback.mime;
          }
        } catch (readEx) {
          send('file-fail', { fileName, error: `Cannot read file: ${readEx.message.slice(0, 80)}`, stillFailing: ++stillFailing, total: queue.length });
          continue;
        }

        const upperName = fileName.toUpperCase();
        const isOpenEnded = ['EASEMENT','EAESMENT','EASMENT','ROAD','BLVD','R/W','RIGHT OF WAY','CENTERLINE'].some(k => upperName.includes(k));
        const pob = { northing: pobN, easting: pobE };

        let succeeded = false;
        let lastError = '';

        let activeImageBytes = imageBytes;
        let activeMime = mime;
        let activeIsOpenEnded = isOpenEnded;

        let rawDocText = '';
        try {
          rawDocText = await ensureExtractedText(filePath, fileName, imageBytes, validPath);
        } catch (err) {
          console.warn(`Retry ensureExtractedText failed for ${fileName}:`, err.message);
        }
        const docInferred = geminiVision.inferCountyStateFromText(rawDocText || '');
        const resolvedCounty = county || docInferred.county || null;
        const resolvedState = state || docInferred.state || null;

        if (fileName.includes('__')) {
          const parts = fileName.split('__');
          const label = parts[1].split('.')[0].toUpperCase();
          if (rawDocText) {
            const namedParcels = extractNamedParcels(rawDocText);
            if (namedParcels) {
              const matchedParcel = namedParcels.find(p => p.label === label);
              if (matchedParcel) {
                console.log(`Retry: Found matched parcel text for label "${label}" in ${fileName}`);
                activeImageBytes = Buffer.from(matchedParcel.text, 'utf-8');
                activeMime = 'text/plain';
                activeIsOpenEnded = detectOpenEnded(matchedParcel.text, fileName, false);
              }
            }
          }
        }

        // Per-file 20-min timeout — if ALL models combined take too long, skip and move on
        const fileAbort = new AbortController();
        const fileTimeoutId = setTimeout(() => fileAbort.abort(), PER_FILE_TIMEOUT_MS);

        try {
          // Try each model in sequence until one passes (concurrency=1, so setProvider is safe)
          for (const model of modelsToTry) {
            if (succeeded) break;
            if (res.writableEnded || fileAbort.signal.aborted) break;
            try {
              let activeModelProvider = provider;
              let cleanModelName = model;
              if (model.includes(':')) {
                const parts = model.split(':');
                if (parts[0] === 'gemini' || parts[0] === 'ollama' || parts[0] === 'openai') {
                  activeModelProvider = parts[0];
                  cleanModelName = parts.slice(1).join(':');
                }
              } else if (model.startsWith('gemini-') || model.startsWith('gemini')) {
                activeModelProvider = 'gemini';
              }

              geminiVision.setProvider(activeModelProvider, cleanModelName);
              send('model-try', { fileName, model: cleanModelName });

              const thinkingInterval = setInterval(() => {
                send('status', { message: `🤖 [${cleanModelName}] is thinking... Inference in progress, please stand by...` });
              }, 15000);

              let repairResult;
              try {
                repairResult = await runRepairPipeline(activeImageBytes, activeMime, pob, units, activeIsOpenEnded, fileName, maxPasses, false);
              } finally {
                clearInterval(thinkingInterval);
              }

              if (repairResult.status === 'PASS' || repairResult.status === 'MEANDER') {
                const extraction = repairResult.finalExtraction;
                const traverse  = repairResult.finalTraverse;
                const stepsJson = repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null;
                saveDeedLogWrapper(req, batchId, fileName, resolvedCounty && resolvedState ? `${resolvedCounty}, ${resolvedState}` : `[RETRY] ${path.parse(fileName).name}`, extraction.courses?.length || 0, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), repairResult.status, `${repairResult.repairStageUsed} [${activeModelProvider}:${cleanModelName}]`, JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null, null, repairResult.trustScore ?? null, stepsJson);
                fixed++;
                succeeded = true;
                send('file-pass', { fileName, model: cleanModelName, stage: repairResult.repairStageUsed, status: repairResult.status, area: traverse?.areaAcres?.toFixed(4) ?? 'n/a', fixed, total: queue.length });
              } else {
                lastError = repairResult.traverseError || 'Did not pass closure';
              }
            } catch (ex) {
              lastError = ex.message;
              send('model-fail', { fileName, model, error: ex.message.slice(0, 120) });
            }
          }
        } finally {
          clearTimeout(fileTimeoutId);
        }

        if (fileAbort.signal.aborted && !succeeded) {
          lastError = `Per-file timeout: all ${provider} models exceeded 20 minutes`;
          send('model-fail', { fileName, model: 'timeout', error: lastError });
        }

        if (!succeeded) {
          stillFailing++;
          saveDeedLogWrapper(req, batchId, fileName, '[RETRY-FAILED]', 0, 999, 0, 'ERROR', `Retry: all ${provider} models failed`, null, null);
          send('file-fail', { fileName, error: lastError?.slice(0, 120), stillFailing, total: queue.length });
        }
      }
    });

    await Promise.all(workers);

    const passRate = queue.length > 0 ? fixed / queue.length : 0;
    db.saveBatchRun(batchId, queue.length, passRate);

    send('done', {
      total: queue.length,
      fixed,
      stillFailing,
      skipped,
      notFound,
      passRate: (passRate * 100).toFixed(1) + '%',
      message: `Retry complete: ${fixed}/${queue.length} files fixed using local LLMs.`,
    });
  } catch (ex) {
    console.error('retry-failed error:', ex);
    send('error', { message: ex.message });
  } finally {
    releaseLock();
    clearInterval(heartbeat);                              // stop keepalive
    try { geminiVision.setProvider(originalProvider, originalModel); } catch {}
    if (!res.writableEnded) res.end();
  }
});

// GET /api/folderscan/browse - Safe directory browser for selection
router.get('/browse', (req, res) => {
  try {
    const roots = getAllowedRoots();
    let currentPath = req.query.path ? path.resolve(req.query.path) : roots[0];

    // Validate path to prevent directory traversal
    const validPath = validatePath(currentPath);
    if (!validPath) {
      return res.status(403).json({ error: 'Path is not allowed. Set BOUNDARY_SCAN_ROOTS env var to configure.' });
    }

    if (!fs.existsSync(validPath)) {
      return res.status(404).json({ error: `Directory not found: ${validPath}` });
    }

    const stat = fs.statSync(validPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory.' });
    }

    const items = fs.readdirSync(validPath, { withFileTypes: true });
    const subfolders = items
      .filter(item => item.isDirectory() && !item.name.startsWith('.'))
      .map(item => item.name)
      .sort();

    // Determine parent path (if it's still within allowed roots)
    const parentPath = path.dirname(validPath);
    const hasParent = validatePath(parentPath) !== null;

    res.json({
      currentPath: validPath,
      parentPath: hasParent ? parentPath : null,
      subfolders,
      roots
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
