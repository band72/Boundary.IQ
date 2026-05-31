// ─── Folder Scan Route ──────────────────────────────────────────────────────
import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { runRepairPipeline, extractNamedParcels, detectOpenEnded } from '../services/repair.js';
import * as legalWriter from '../services/legalWriter.js';
import * as db from '../services/diagnosticsDb.js';
import { isWordDocument, convertToPdf, getMimeType } from '../services/docConversion.js';
import * as output from '../services/output.js';
import * as geminiVision from '../services/geminiVision.js';
import * as platLookup from '../services/platLookupService.js';
import * as resolver from '../services/chainedTraverseResolver.js';
import * as plssParser from '../services/plssParser.js';
import * as traverseSvc from '../services/traverse.js';
import * as ollamaSvc from '../services/ollamaVision.js';
const router = Router();

const MAX_FILE_SIZE = 51 * 1024 * 1024;
const SUPPORTED_EXTS = new Set(['.pdf', '.doc', '.docx', '.txt']);

// ── Allowed roots (path traversal protection) ────────────────────────────────
function getAllowedRoots() {
  const envRoots = process.env.BOUNDARY_SCAN_ROOTS;
  if (envRoots) return envRoots.split(';').filter(Boolean).map(r => path.resolve(r.trim()));
  return [os.homedir()];
}

function validatePath(p) {
  if (!p) return null;
  if (p.includes('..')) return null;

  let normalized = p;
  // Translate developer's home folder to current user's home folder
  if (normalized.includes('/home/bando')) {
    normalized = normalized.replace('/home/bando', os.homedir());
  }

  // Translate /home/artwalk/Downloads/TrainPDF or /home/artwalk/Downloads/Legal Descriptions
  // to their actual locations under the extracted training folder if the directly requested ones don't exist
  if (!fs.existsSync(normalized)) {
    if (normalized.includes('/Downloads/TrainPDF')) {
      const candidate = normalized.replace('/Downloads/TrainPDF', '/Downloads/training-20260530T124201Z-3-001/training/TrainPDF');
      if (fs.existsSync(candidate)) normalized = candidate;
    } else if (normalized.includes('/Downloads/Legal Descriptions')) {
      const candidate = normalized.replace('/Downloads/Legal Descriptions', '/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions');
      if (fs.existsSync(candidate)) normalized = candidate;
    }
  }

  const resolved = path.resolve(normalized);
  const roots = getAllowedRoots();
  for (const root of roots) {
    if (resolved.startsWith(root)) return resolved;
  }
  return null;
}

// ── Document classification ─────────────────────────────────────────────────
const BOUNDARY_KEYWORDS = [' - WD', ' - SWD', ' - LWD', ' - QCD', 'Deed', 'Easement', 'Right of Way', 'Monument Road', 'Deed of Dedication', 'Grant of Easement', 'Utility Easement', 'Road', 'Blvd', 'Order of Taking', 'Closing of Pt'];

const SKIP_KEYWORDS = [
  // Legal instruments — no boundary geometry
  'Memo of Lease', 'Short Form Lease', 'Operating Agreement', 'Administrative Fine',
  'Adminstrative Fine', 'Lis Pendens', 'Bankruptcy', 'Letters of Administration',
  'Order Admitting Will', 'Petition for Administration', 'Memo of Management',
  'Memo of ROFR', 'Memo of Transfer', 'Affidavit', 'Aff-Cert', 'Electric Service',
  'Assign & Assump', 'REA Assign', 'Agreement Concerning Lease', 'Fourth Amendment',
  '2nd Amend', "Vendor_s Lien", 'Certificate', 'Contribution Agreement',
  'Utility Agreement', 'Dec of Expiration',
  // NOTE: 'CERT', 'CERTIFICATION' intentionally NOT in this list —
  // a deed file may be named with CERT but still contain valid THENCE courses.
  // Content-based filtering below handles pure cert-only documents.
  'TITLE OPINION', 'ELEVATION CERT', 'FLOOD CERT', 'ENCROACHMENT',
];

function containsWord(source, word) {
  let index = 0;
  const upperSource = source.toUpperCase();
  const upperWord = word.toUpperCase();
  while ((index = upperSource.indexOf(upperWord, index)) !== -1) {
    const prevOk = index === 0 || !/[a-zA-Z0-9]/.test(upperSource[index - 1]);
    const nextOk = index + upperWord.length >= upperSource.length || !/[a-zA-Z0-9]/.test(upperSource[index + upperWord.length]);
    if (prevOk && nextOk) return true;
    index += upperWord.length;
  }
  return false;
}

function classifyByFilename(fileName) {
  const upper = fileName.toUpperCase();
  for (const skip of SKIP_KEYWORDS) if (upper.includes(skip.toUpperCase())) return 'SKIP';
  if (containsWord(upper, 'WD') || containsWord(upper, 'SWD') || containsWord(upper, 'LWD')) return 'WARRANTY_DEED';
  if (containsWord(upper, 'QCD') || containsWord(upper, 'QC')) return 'QUIT_CLAIM_DEED';
  if (upper.includes('EASEMENT') || upper.includes('EAESMENT') || upper.includes('EASMENT')) return 'EASEMENT';
  if (upper.includes('DEED OF DEDICATION') || upper.includes('DEDICATION')) return 'DEDICATION';
  if (upper.includes('ORDER OF TAKING')) return 'CONDEMNATION';
  if (upper.includes('ROAD') || upper.includes('BLVD')) return 'ROAD_CLOSING';
  if (upper.includes('DEED') || upper.includes('GRANT')) return 'DEED';
  if (upper.includes('COMMITMENT') || upper.includes('COMMITTMENT')) return 'DEED';
  return 'SKIP';
}

function getDocType(filePath, fileName) {
  const dir = path.dirname(filePath);
  const base = path.parse(fileName).name;
  const ext = path.extname(fileName).toLowerCase();

  let raw = '';
  if (ext === '.txt') {
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {}
  } else {
    const extractedTxt = path.join(dir, '_extracted', base + '.txt');
    if (fs.existsSync(extractedTxt)) {
      try {
        raw = fs.readFileSync(extractedTxt, 'utf-8');
      } catch {}
    }
  }

  if (raw) {
    try {
      const txt = raw.toUpperCase();

      // Filename-level skip takes priority — even if content contains THENCE,
      // known non-boundary instrument types must be excluded first.
      const upperFileName = fileName.toUpperCase();
      for (const skip of SKIP_KEYWORDS) {
        if (upperFileName.includes(skip.toUpperCase())) {
          console.log(`classifyDocument: SKIP — filename matches skip keyword "${skip}": ${fileName}`);
          return 'SKIP';
        }
      }

      // Hard skip: stub documents (cover pages, stamps, annotations)
      if (raw.trim().length < 80) {
        console.log(`classifyDocument: SKIP — stub document (${raw.trim().length} chars): ${fileName}`);
        return 'SKIP';
      }

      // Hard skip: pure certification docs with no boundary geometry
      // A deed may contain certification language (surveyor's cert block) alongside THENCE courses —
      // only skip if there are NO courses at all.
      if ((txt.includes('DOES HEREBY CERTIFY') || txt.includes('I HEREBY CERTIFY') ||
           txt.includes('ALTA/ACSM') || txt.includes('ELEVATION CERTIFICATE') ||
           txt.includes('FLOOD INSURANCE')) && !txt.includes('THENCE')) {
        console.log(`classifyDocument: SKIP — pure certification, no boundary courses: ${fileName}`);
        return 'SKIP';
      }

      // Check if it has township/range/section/quarter for PLSS/aliquot deeds
      const isPlss = txt.includes('SECTION') || txt.includes('SEC.') || txt.includes('TOWNSHIP') || txt.includes('RANGE');

      // If the content explicitly contains boundary geometry or PLSS info, immediately return 'DEED'!
      if (txt.includes('THENCE') || txt.includes('BEGINNING AT') || isPlss) {
        return 'DEED';
      }
    } catch {}
  }

  // Word docs fallback
  if (isWordDocument(fileName)) {
    const upper = fileName.toUpperCase();
    for (const skip of SKIP_KEYWORDS) if (upper.includes(skip.toUpperCase())) return 'SKIP';
    return 'DEED';
  }

  return classifyByFilename(fileName);
}

function getSupportedFiles(dirPath) {
  return fs.readdirSync(dirPath)
    .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(dirPath, f));
}

function inferMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.doc': 'application/pdf',
    '.docx': 'application/pdf',
    '.txt': 'text/plain'
  };
  return map[ext] || 'application/pdf';
}

function parsePrecisionRatio(precisionStr) {
  if (!precisionStr) return 0;
  try {
    const parts = precisionStr.split(':');
    if (parts.length > 1) { const val = parseFloat(parts[1].replace(/,/g, '').replace('∞', '999999999').trim()); if (!isNaN(val)) return val; }
  } catch {}
  return 0;
}

// GET /api/folderscan/scan
router.get('/scan', (req, res) => {
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
  res.json({ path: req.query.path, total, toProcess, toSkip: total - toProcess, batchesNeeded: Math.ceil(toProcess / 20), files });
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
let _processingLock = false;
let _processingInfo = null; // { type, startTime, path }

function acquireLock(type, path) {
  if (_processingLock) return false;
  _processingLock = true;
  _processingInfo = { type, path, startTime: Date.now() };
  return true;
}
function releaseLock() {
  _processingLock = false;
  _processingInfo = null;
}

// GET /api/folderscan/status  — is the server currently processing?
router.get('/status', (req, res) => {
  if (_processingLock && _processingInfo) {
    const elapsedSec = Math.round((Date.now() - _processingInfo.startTime) / 1000);
    return res.json({ busy: true, type: _processingInfo.type, path: _processingInfo.path, elapsedSec });
  }
  res.json({ busy: false });
});

// POST /api/folderscan/reset-lock — force-release the processing lock
router.post('/reset-lock', (req, res) => {
  const wasLocked = _processingLock;
  const previousInfo = _processingInfo;
  releaseLock();
  console.log('🔓 Processing lock was force-released by manual client request.');
  res.json({
    success: true,
    message: wasLocked
      ? `Processing lock for '${previousInfo?.type || 'unknown'}' was successfully released.`
      : 'Server was not locked, but processing state has been reset.',
  });
});

// POST /api/folderscan/process-batch
router.post('/process-batch', async (req, res) => {
  let keepAlive = null;
  try {
    const validPath = validatePath(req.query.path);
    if (!validPath) return res.status(403).json({ error: 'Path is not allowed.' });
    if (!fs.existsSync(validPath)) return res.status(404).json({ error: `Directory not found: ${validPath}` });

    const batchIndex = parseInt(req.query.batchIndex) || 0;
    const pobN = parseFloat(req.query.pobN) || 5000;
    const pobE = parseFloat(req.query.pobE) || 5000;
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

    const allProcessable = getSupportedFiles(validPath).filter(f => {
      const stats = fs.statSync(f);
      const docType = getDocType(f, path.basename(f));
      return docType !== 'SKIP' && stats.size <= MAX_FILE_SIZE;
    });

    if (allProcessable.length === 0) return res.json({ message: 'No processable deed PDFs found.', results: [] });

    const totalBatches = Math.ceil(allProcessable.length / 20);
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

    const batch = allProcessable.slice(batchIndex * 20, (batchIndex + 1) * 20);
    const batchId = uuidv4();
    const results = new Array(batch.length);

    db.saveBatchRun(batchId, batch.length, 0.0);
    console.log(`FolderScan batch ${batchIndex}/${totalBatches - 1}: ${batch.length} files from ${req.query.path} using ${geminiVision.getActiveProvider()}/${geminiVision.getActiveModel()}`);

    const semaphore = { current: 0, max: concurrency };
    const tasks = batch.map((filePath, index) => async () => {
      const fileName = path.basename(filePath);
      console.log(`FolderScan processing: ${fileName}`);

      try {
        // Check cache
        const solvedCase = db.findSolvedCase(fileName);
        if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
          console.log(`Cache hit for ${fileName}`);
          const cachedEx = JSON.parse(solvedCase.extractionJson);
          const cachedTr = JSON.parse(solvedCase.traverseJson);
          let cachedWrite = null;
          if (cachedEx.courses?.length > 0) {
            try {
              cachedWrite = { legalDescription: legalWriter.write({ courses: cachedEx.courses, pobNorthing: pobN, pobEasting: pobE, county, state, units: units.toLowerCase(), areaAcres: cachedTr.areaAcres, perimeter: cachedTr.perimeter }), courseCount: cachedEx.courses.length };
            } catch {}
          }
          results[index] = { fileName, status: 'success', extraction: cachedEx, traverse: cachedTr, legalDescription: cachedWrite, error: null };
          db.saveDeedLog(batchId, fileName, solvedCase.parcelName || 'CACHED', cachedEx.courses?.length || 0, cachedTr.closure?.linearError || 0, parsePrecisionRatio(cachedTr.closure?.precisionRatio), 'PASS', 'Stage 5: SQLite Case Finder Solved', solvedCase.extractionJson, solvedCase.traverseJson);
          return;
        }

        const upperName = fileName.toUpperCase();
        const isOpenEnded = ['EASEMENT', 'EAESMENT', 'EASMENT', 'ROAD', 'BLVD', 'R/W', 'RIGHT OF WAY', 'CENTERLINE'].some(k => upperName.includes(k));

        let imageBytes = await fs.promises.readFile(filePath);
        let mime = inferMimeType(fileName);

        if (isWordDocument(fileName)) {
          console.log(`Converting Word doc ${fileName} to PDF...`);
          imageBytes = await convertToPdf(imageBytes, fileName);
          mime = 'application/pdf';
        }

        const pob = { northing: pobN, easting: pobE };

        // ── Multi-Parcel Fan-Out ───────────────────────────────────────────────
        let rawDocText = '';
        try {
          const ext = path.extname(fileName).toLowerCase();
          if (ext === '.txt') {
            rawDocText = fs.readFileSync(filePath, 'utf-8');
          } else {
            const extractedTxtPath = path.join(validPath, '_extracted', path.parse(fileName).name + '.txt');
            if (fs.existsSync(extractedTxtPath)) {
              rawDocText = fs.readFileSync(extractedTxtPath, 'utf-8');
            }
          }
        } catch {}

        const namedParcels = extractNamedParcels(rawDocText);
        if (namedParcels && namedParcels.length >= 2) {
          console.log(`FolderScan: Multi-parcel deed detected in ${fileName} — ${namedParcels.length} parcels: ${namedParcels.map(p => p.label).join(', ')}`);
          
          let parcelResults = [];
          for (const { label, text: parcelText } of namedParcels) {
            const ext = path.extname(fileName);
            const base = path.parse(fileName).name;
            const parcelFileName = `${base}__${label}${ext}`;
            const isOE = detectOpenEnded(parcelText, parcelFileName, false);
            console.log(`FolderScan: Processing parcel ${label} → ${parcelFileName} (isOpenEnded=${isOE})`);
            
            // Try offline PLSS intercept first for the parcel
            const plssParsedObj = plssParser.parsePlss(parcelText);
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
                      county,
                      state,
                      units: units.toLowerCase(),
                      areaAcres: platResult.areaAcres,
                      perimeter: traverse?.perimeter
                    }),
                    courseCount: platResult.courses.length
                  };
                } catch {}

                const pRes = { fileName: parcelFileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, platLookup: platResult };
                parcelResults.push(pRes);

                const stageLabel = `Stage 1.5: Offline PLSS Intercept (${platResult.isFallback ? 'fallback grid' : 'BLM API'})`;
                const pLabel = `[${label}] ${county && state ? `${county}, ${state}` : base}`;
                db.saveDeedLog(batchId, parcelFileName, pLabel, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse));
                
                continue; // successfully processed this parcel offline!
              }
            }

            try {
              const pResult = await runRepairPipeline(imageBytes, mime, pob, units, isOE, parcelFileName);
              const pEx = pResult.finalExtraction;
              const pTr = pResult.finalTraverse;
              const pStatus = pResult.status;
              const pStage  = pResult.repairStageUsed;
              const pLabel  = `[${label}] ${county && state ? `${county}, ${state}` : base}`;
              
              let pWrite = null;
              if (pEx.courses?.length > 0) {
                try {
                  pWrite = {
                    legalDescription: legalWriter.write({
                      courses: pEx.courses, pobNorthing: pobN, pobEasting: pobE, county, state, units: units.toLowerCase(), areaAcres: pTr?.areaAcres, perimeter: pTr?.perimeter
                    }),
                    courseCount: pEx.courses.length
                  };
                } catch {}
              }

              const pRes = { fileName: parcelFileName, status: pStatus === 'PASS' ? 'success' : 'error', extraction: pEx, traverse: pTr, legalDescription: pWrite, error: pResult.traverseError, platLookup: null };
              parcelResults.push(pRes);

              db.saveDeedLog(
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
              );
              console.log(`FolderScan: Parcel ${label} saved as ${parcelFileName} — ${pStatus}`);
            } catch (parcelEx) {
              console.warn(`FolderScan: Parcel ${label} (${parcelFileName}) failed:`, parcelEx.message);
            }
          }

          if (parcelResults.length > 0) {
            results[index] = {
              fileName,
              status: 'success',
              isMultiParcel: true,
              parcels: parcelResults,
              extraction: parcelResults[0].extraction,
              traverse: parcelResults[0].traverse,
              legalDescription: parcelResults[0].legalDescription,
              error: null,
            };
            return;
          }
        }

        // Check for PLSS description first to avoid Gemini API calls for .txt deeds
        const plssParsedObj = plssParser.parsePlss(rawDocText);
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
                  county,
                  state,
                  units: units.toLowerCase(),
                  areaAcres: platResult.areaAcres,
                  perimeter: traverse?.perimeter
                }),
                courseCount: platResult.courses.length
              };
            } catch {}

            results[index] = { fileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, platLookup: platResult };
            const stageLabel = `Stage 1.5: Offline PLSS Intercept (${platResult.isFallback ? 'fallback grid' : 'BLM API'})`;
            db.saveDeedLog(batchId, fileName, county && state ? `${county}, ${state}` : `[PLAT-INTERCEPT] ${path.parse(fileName).name}`, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse));
            return;
          }
        }

        const repairResult = await runRepairPipeline(imageBytes, mime, pob, units, isOpenEnded, fileName);

        const extraction = repairResult.finalExtraction;
        const traverse = repairResult.finalTraverse;
        const status = repairResult.status;
        const stageUsed = repairResult.repairStageUsed;

        let writeResult = null;
        if (extraction.courses?.length > 0) {
          try {
            writeResult = { legalDescription: legalWriter.write({ courses: extraction.courses, pobNorthing: pobN, pobEasting: pobE, county, state, units: units.toLowerCase(), areaAcres: traverse?.areaAcres, perimeter: traverse?.perimeter }), courseCount: extraction.courses.length };
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
              platResult = await platLookup.resolveLotBlock(extraction, county);
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
              try { writeResult = { legalDescription: legalWriter.write({ courses: platResult.courses, pobNorthing: pobN, pobEasting: pobE, county, state, units: units.toLowerCase(), areaAcres: platResult.areaAcres, perimeter: traverse?.perimeter }), courseCount: platResult.courses.length }; } catch {}
              const stageLabel = `Stage 3.5: PlatLookup Tier ${platResult.tier} (${isLotBlock ? 'LOT_BLOCK' : 'PLSS'})${platResult.isFallback ? ' [fallback grid]' : ''}`;
              results[index] = { fileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, platLookup: platResult };
              db.saveDeedLog(batchId, fileName, county && state ? `${county}, ${state}` : `[PLAT] ${path.parse(fileName).name}`, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse));
              return;
            } else if (platResult?.needsManual) {
              results[index] = { fileName, status: 'error', extraction, traverse: null, legalDescription: null, error: 'LOT_BLOCK lookup requires manual coordinate entry (Tier 3)', needsManualPlat: true, platInfo: { lot: platResult.lot, block: platResult.block, subdivision: platResult.subdivision } };
              db.saveDeedLog(batchId, fileName, `[LOT_BLOCK-MANUAL] ${path.parse(fileName).name}`, 0, 999, 0, 'FAIL', 'Stage 4: LOT_BLOCK needs manual plat coordinates', JSON.stringify(extraction), null);
              return;
            }
          } catch (platEx) {
            console.warn(`PlatLookup batch failed for ${fileName}: ${platEx.message}`);
          }

          console.log(`FolderScan batch: ${fileName} — SKIPPED (${extraction.classification})`);
          results[index] = {
            fileName, status: 'skipped', extraction, traverse: null, legalDescription: null,
            error: null, skipReason: `Non-traversable: ${extraction.classification}`,
          };
          db.saveDeedLog(batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
            'SKIPPED', 'Non-traversable document', JSON.stringify(extraction), null);
          return;
        }

        const isNonTraversable = (!extraction.courses || extraction.courses.length === 0) &&
          (extraction.classification === 'PLAT' ||
           (repairResult.traverseError || '').toLowerCase().includes('no traversable'));

        if (isNonTraversable) {
          console.log(`FolderScan batch: ${fileName} — SKIPPED (${extraction.classification})`);
          results[index] = {
            fileName, status: 'skipped', extraction, traverse: null, legalDescription: null,
            error: null, skipReason: `Non-traversable: ${extraction.classification}`,
          };
          db.saveDeedLog(batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
            'SKIPPED', 'Non-traversable document', JSON.stringify(extraction), null);
          return;
        }

        results[index] = { fileName, status: status === 'PASS' ? 'success' : 'error', extraction, traverse, legalDescription: writeResult, error: repairResult.traverseError, originalExtraction: repairResult.originalExtraction, solutionSteps: repairResult.solutionSteps || null };

        const parcelLabel = county && state ? `${county}, ${state}` : `[${extraction.classification}] ${path.parse(fileName).name}`;
        const stepsJson = repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null;
        db.saveDeedLog(batchId, fileName, parcelLabel, extraction.courses?.length || 0, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), status, stageUsed, JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null, repairResult.agentTurns ? JSON.stringify(repairResult.agentTurns) : null, repairResult.trustScore ?? null, stepsJson);
        if (extraction.courses?.length > 0) db.incrementHeuristic(stageUsed, 'FolderScan auto-repair');
      } catch (ex) {
        console.error(`FolderScan item failed: ${fileName}`, ex.message);
        results[index] = { fileName, status: 'error', extraction: null, traverse: null, legalDescription: null, error: ex.message };
        db.saveDeedLog(batchId, fileName, 'ERROR', 0, 999, 0, 'ERROR', 'AI Extraction Error', null, null);
      }
    });

    // Run with concurrency
    await Promise.all(tasks.map(async (fn) => {
      while (semaphore.current >= semaphore.max) await new Promise(r => setTimeout(r, 50));
      semaphore.current++;
      try { await fn(); } finally { semaphore.current--; }
    }));

    const succeeded = results.filter(r => r?.status === 'success').length;
    const passRate = results.length > 0 ? succeeded / results.length : 0;
    db.saveBatchRun(batchId, results.length, passRate);

    // Auto-output
    let outputFolder = null;
    if (autoOutput) {
      try {
        const start = Date.now();
        outputFolder = output.createOutputFolder(req.query.path);
        for (const r of results) {
          if (!r) continue;
          if (r.isMultiParcel && r.parcels) {
            for (const pr of r.parcels) {
              output.writeResultFiles(outputFolder, pr.fileName, pr, pr.legalDescription);
            }
          } else {
            output.writeResultFiles(outputFolder, r.fileName, r, r.legalDescription);
          }
        }
        output.writeBatchSummary(outputFolder, req.query.path, results, Date.now() - start);
      } catch (ex) { console.warn('Auto-output failed:', ex.message); }
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
  }
});

// POST /api/folderscan/process-file
router.post('/process-file', async (req, res) => {
  let keepAlive = null;
  try {
    const validPath = validatePath(req.query.path);
    if (!validPath) return res.status(403).json({ error: 'Path is not allowed.' });
    if (!fs.existsSync(validPath)) return res.status(404).json({ error: `Directory not found: ${validPath}` });

    const fileName = req.query.file;
    if (!fileName) return res.status(400).json({ error: 'file query parameter is required.' });

    let filePath = path.join(validPath, fileName);
    if (!fs.existsSync(filePath)) {
      // Fallback: search in common training and dataset directories
      const trainingBase = path.join(os.homedir(), 'Downloads', 'training-20260530T124201Z-3-001', 'training');
      const candidates = [
        path.join(trainingBase, 'Legal Descriptions', fileName),
        path.join(trainingBase, 'TrainPDF', fileName),
        path.join(trainingBase, 'TrainPDF', 'Regency-Title', fileName),
        path.join(trainingBase, 'TrainPDF', 'LIDO', fileName),
        path.join(trainingBase, 'Bowtie-Failures', fileName),
        path.join(trainingBase, 'Bowtie-Test', fileName),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          filePath = cand;
          break;
        }
      }
    }

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: `File not found: ${filePath}` });

    const pobN = parseFloat(req.query.pobN) || 5000;
    const pobE = parseFloat(req.query.pobE) || 5000;
    const units = req.query.units || 'Feet';
    const county = req.query.county || null;
    const state = req.query.state || null;
    const batchId = req.query.batchId || uuidv4();
    const autoOutput = req.query.autoOutput === 'true';

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

    db.saveBatchRun(batchId, 1, 0.0);
    console.log(`FolderScan processing single file: ${fileName}`);

    // Check cache (unless forced)
    const force = req.query.force === 'true';
    if (!force) {
      const solvedCase = db.findSolvedCase(fileName);
      if (solvedCase?.extractionJson && solvedCase?.traverseJson) {
        console.log(`Cache hit for ${fileName}`);
        const cachedEx = JSON.parse(solvedCase.extractionJson);
        const cachedTr = JSON.parse(solvedCase.traverseJson);
        let cachedWrite = null;
        const courses = cachedEx.courses || cachedEx.Courses || [];
        if (courses.length > 0) {
          try {
            cachedWrite = {
              legalDescription: legalWriter.write({
                courses,
                pobNorthing: pobN,
                pobEasting: pobE,
                county,
                state,
                units: units.toLowerCase(),
                areaAcres: cachedTr.areaAcres ?? cachedTr.AreaAcres ?? 0,
                perimeter: cachedTr.perimeter ?? cachedTr.Perimeter ?? 0
              }),
              courseCount: courses.length
            };
          } catch {}
        }
        const result = { fileName, status: 'success', extraction: cachedEx, traverse: cachedTr, legalDescription: cachedWrite, error: null, cached: true };
        const linErr = cachedTr.closure?.linearError ?? cachedTr.Closure?.LinearError ?? 0;
        const precRatio = cachedTr.closure?.precisionRatio ?? cachedTr.Closure?.PrecisionRatio ?? '';
        db.saveDeedLog(batchId, fileName, solvedCase.parcelName || 'CACHED',
          courses.length, linErr,
          parsePrecisionRatio(precRatio), 'PASS', 'Stage 5: SQLite Case Finder Solved',
          solvedCase.extractionJson, solvedCase.traverseJson);

        if (keepAlive) clearInterval(keepAlive);
        res.write(JSON.stringify({ status: 'success', result }));
        res.end();
        return;
      }
    }

    const upperName = fileName.toUpperCase();
    const isOpenEnded = ['EASEMENT', 'EAESMENT', 'EASMENT', 'ROAD', 'BLVD', 'R/W', 'RIGHT OF WAY', 'CENTERLINE'].some(k => upperName.includes(k));

    let imageBytes = await fs.promises.readFile(filePath);
    let mime = inferMimeType(fileName);

    if (isWordDocument(fileName)) {
      console.log(`Converting Word doc ${fileName} to PDF...`);
      imageBytes = await convertToPdf(imageBytes, fileName);
      mime = 'application/pdf';
    }

    const pob = { northing: pobN, easting: pobE };

    // Check for PLSS description first to avoid Gemini API calls for .txt deeds
    let rawDocText = '';
    try {
      const ext = path.extname(fileName).toLowerCase();
      if (ext === '.txt') {
        rawDocText = fs.readFileSync(filePath, 'utf-8');
      } else {
        const extractedTxtPath = path.join(validPath, '_extracted', path.parse(fileName).name + '.txt');
        if (fs.existsSync(extractedTxtPath)) {
          rawDocText = fs.readFileSync(extractedTxtPath, 'utf-8');
        }
      }
    } catch {}

    if (rawDocText) {
      const plssParsedObj = plssParser.parsePlss(rawDocText);
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
                county,
                state,
                units: units.toLowerCase(),
                areaAcres: platResult.areaAcres,
                perimeter: traverse?.perimeter
              }),
              courseCount: platResult.courses.length
            };
          } catch {}

          const result = { fileName, status: 'success', extraction, traverse, legalDescription: writeResult, error: null, cached: false, platLookup: platResult };
          const stageLabel = `Stage 1.5: Offline PLSS Intercept (${platResult.isFallback ? 'fallback grid' : 'BLM API'})`;
          db.saveDeedLog(batchId, fileName, county && state ? `${county}, ${state}` : `[PLAT-INTERCEPT] ${path.parse(fileName).name}`, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify(extraction), JSON.stringify(traverse));
          
          if (autoOutput) {
            try {
              const outputFolder = output.createOutputFolder(validPath);
              output.writeResultFiles(outputFolder, fileName, result, writeResult);
            } catch (ex) { console.warn('Auto-output failed:', ex.message); }
          }

          if (keepAlive) clearInterval(keepAlive);
          res.write(JSON.stringify({ status: 'success', result }));
          res.end();
          return;
        }
      }
    }

    const repairResult = await runRepairPipeline(imageBytes, mime, pob, units, isOpenEnded, fileName);

    const extraction = repairResult.finalExtraction;
    const traverse = repairResult.finalTraverse;
    const status = repairResult.status;
    const stageUsed = repairResult.repairStageUsed;

    let writeResult = null;
    if (extraction.courses?.length > 0) {
      try {
        writeResult = { legalDescription: legalWriter.write({ courses: extraction.courses, pobNorthing: pobN, pobEasting: pobE, county, state, units: units.toLowerCase(), areaAcres: traverse?.areaAcres, perimeter: traverse?.perimeter }), courseCount: extraction.courses.length };
      } catch {}
    }

    // Detect non-traversable documents (certification pages, title commitments, etc.)
    const isNonTraversable = (!extraction.courses || extraction.courses.length === 0) &&
      (['PLAT', 'LOT_BLOCK', 'SECTION_BREAKDOWN'].includes(extraction.classification) ||
       (repairResult.traverseError || '').toLowerCase().includes('no traversable') ||
       (repairResult.traverseError || '').toLowerCase().includes('zero segment'));

    if (isNonTraversable) {
      console.log(`FolderScan: ${fileName} — SKIPPED (non-traversable: ${extraction.classification})`);
      const result = {
        fileName, status: 'skipped',
        extraction, traverse: null, legalDescription: null,
        error: null,
        skipReason: `Document contains no traversable boundary geometry (AI classification: ${extraction.classification}).`,
        cached: false,
      };
      db.saveDeedLog(batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
        'SKIPPED', 'Non-traversable document', JSON.stringify(extraction), null);

      if (keepAlive) clearInterval(keepAlive);
      res.write(JSON.stringify({ status: 'skipped', result }));
      res.end();
      return;
    }

    const result = { fileName, status: status === 'PASS' ? 'success' : 'error', extraction, traverse, legalDescription: writeResult, error: repairResult.traverseError, originalExtraction: repairResult.originalExtraction, cached: false, solutionSteps: repairResult.solutionSteps || null };

    const parcelLabel = county && state ? `${county}, ${state}` : `[${extraction.classification}] ${path.parse(fileName).name}`;
    const stepsJson = repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null;
    db.saveDeedLog(batchId, fileName, parcelLabel, extraction.courses?.length || 0, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), status, stageUsed, JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null, repairResult.agentTurns ? JSON.stringify(repairResult.agentTurns) : null, repairResult.trustScore ?? null, stepsJson);
    if (extraction.courses?.length > 0) db.incrementHeuristic(stageUsed, 'FolderScan auto-repair');

    // Auto-output
    if (autoOutput) {
      try {
        const outputFolder = output.createOutputFolder(validPath);
        output.writeResultFiles(outputFolder, fileName, result, writeResult);
      } catch (ex) { console.warn('Auto-output failed:', ex.message); }
    }

    if (keepAlive) clearInterval(keepAlive);
    res.write(JSON.stringify({ status: status === 'PASS' ? 'success' : 'error', result }));
    res.end();
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
    db.saveDeedLog(batchId, fileName,
      county && state ? `${county}, ${state}` : `[CHAIN] ${fileName}`,
      resolvedCourses.length,
      traverse?.closure?.linearError ?? 999,
      parsePrecisionRatio(traverse?.closure?.precisionRatio),
      status, stageLabel,
      JSON.stringify({ courses: resolvedCourses }),
      traverse ? JSON.stringify(traverse) : null
    );

    res.json({
      status: status === 'PASS' ? 'success' : 'error',
      result: {
        fileName,
        status: status === 'PASS' ? 'success' : 'error',
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
    db.saveDeedLog(batchId, fileName, county && state ? `${county}, ${state}` : `[MANUAL-PLAT] ${fileName}`, platResult.courses.length, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), 'PASS', stageLabel, JSON.stringify({ courses: platResult.courses }), JSON.stringify(traverse));

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
  const units     = req.query.units || 'Feet';
  const county    = req.query.county || null;
  const state     = req.query.state  || null;
  const maxPasses = parseInt(req.query.maxPasses) || 3;   // retry rounds
  const concurrency = 1;  // MUST be 1 — setProvider() is global state; concurrent calls corrupt each other
  const PER_FILE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min max per file

  // Local model cascade — dynamically query available models from local Ollama
  let LOCAL_MODELS = ['gemma4:e2b', 'qwen2.5-coder:1.5b'];
  try {
    const status = await ollamaSvc.getStatus();
    if (status.online && status.models && status.models.length > 0) {
      // Sort status.models so that faster/smaller models come first:
      // - Prioritize models containing '1.5b', '2b', '3b', '4b', 'gemma3'
      // - Deprioritize models containing 'deepseek', 'r1', '8b', '7b'
      const sortedModels = [...status.models].sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        
        const isSlow = (name) => name.includes('deepseek') || name.includes('r1') || name.includes('8b') || name.includes('7b');
        const aSlow = isSlow(aLower);
        const bSlow = isSlow(bLower);
        
        if (aSlow && !bSlow) return 1;
        if (!aSlow && bSlow) return -1;
        
        return aLower.localeCompare(bLower);
      });

      for (const m of sortedModels) {
        if (!LOCAL_MODELS.includes(m)) {
          LOCAL_MODELS.push(m);
        }
      }
    }
  } catch (err) {
    console.error('Failed to retrieve online local models:', err);
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

  try {
    // Get all files that are still failing
    const failedFileNames = db.getFailedFileNames();
    send('init', { total: failedFileNames.length, models: LOCAL_MODELS, maxPasses });

    if (failedFileNames.length === 0) {
      send('done', { fixed: 0, stillFailing: 0, message: 'No failed files to retry.' });
      res.end();
      return;
    }

    // Resolve file names to full paths
    const queue = failedFileNames
      .map(fn => {
        const fp = path.join(validPath, fn);
        return fs.existsSync(fp) ? { fileName: fn, filePath: fp } : null;
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
            imageBytes = await convertToPdf(imageBytes, fileName);
            mime = 'application/pdf';
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

        // Per-file 20-min timeout — if ALL models combined take too long, skip and move on
        const fileAbort = new AbortController();
        const fileTimeoutId = setTimeout(() => fileAbort.abort(), PER_FILE_TIMEOUT_MS);

        try {
          // Try each local model in sequence until one passes (concurrency=1, so setProvider is safe)
          for (const model of LOCAL_MODELS) {
            if (succeeded) break;
            if (res.writableEnded || fileAbort.signal.aborted) break;
            try {
              geminiVision.setProvider('ollama', model);
              send('model-try', { fileName, model });

              const thinkingInterval = setInterval(() => {
                send('status', { message: `🤖 [${model}] is thinking... CPU inference takes several minutes per file. Please stand by...` });
              }, 15000);

              let repairResult;
              try {
                repairResult = await runRepairPipeline(imageBytes, mime, pob, units, isOpenEnded, fileName, maxPasses);
              } finally {
                clearInterval(thinkingInterval);
              }

              if (repairResult.status === 'PASS' || repairResult.status === 'MEANDER') {
                const extraction = repairResult.finalExtraction;
                const traverse  = repairResult.finalTraverse;
                const stepsJson = repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null;
                db.saveDeedLog(batchId, fileName, county && state ? `${county}, ${state}` : `[RETRY] ${path.parse(fileName).name}`, extraction.courses?.length || 0, traverse?.closure?.linearError || 0, parsePrecisionRatio(traverse?.closure?.precisionRatio), repairResult.status, `${repairResult.repairStageUsed} [local:${model}]`, JSON.stringify(extraction), traverse ? JSON.stringify(traverse) : null, null, repairResult.trustScore ?? null, stepsJson);
                fixed++;
                succeeded = true;
                send('file-pass', { fileName, model, stage: repairResult.repairStageUsed, status: repairResult.status, area: traverse?.areaAcres?.toFixed(4) ?? 'n/a', fixed, total: queue.length });
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
          lastError = 'Per-file timeout: all models exceeded 20 minutes';
          send('model-fail', { fileName, model: 'timeout', error: lastError });
        }

        if (!succeeded) {
          stillFailing++;
          db.saveDeedLog(batchId, fileName, '[RETRY-FAILED]', 0, 999, 0, 'ERROR', 'Retry: all local models failed', null, null);
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
