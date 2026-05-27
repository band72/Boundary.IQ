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
const router = Router();

const MAX_FILE_SIZE = 51 * 1024 * 1024;
const SUPPORTED_EXTS = new Set(['.pdf', '.doc', '.docx']);

// ── Allowed roots (path traversal protection) ────────────────────────────────
function getAllowedRoots() {
  const envRoots = process.env.BOUNDARY_SCAN_ROOTS;
  if (envRoots) return envRoots.split(';').filter(Boolean).map(r => path.resolve(r.trim()));
  return [os.homedir()];
}

function validatePath(p) {
  if (!p) return null;
  if (p.includes('..')) return null;
  const resolved = path.resolve(p);
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
  'Memo of ROFR', 'Memo of Transfer', 'Affidavit', 'Aff-Cert', 'Commitment',
  'Committment', 'Electric Service', 'Assign & Assump', 'REA Assign',
  'Agreement Concerning Lease', 'Fourth Amendment', '2nd Amend', "Vendor_s Lien",
  'Certificate', 'Contribution Agreement', 'Utility Agreement', 'Dec of Expiration',
  // NOTE: 'CERT', 'CERTIFICATION' intentionally NOT in this list —
  // a deed file may be named with CERT but still contain valid THENCE courses.
  // Content-based filtering below handles pure cert-only documents.
  'TITLE COMMITMENT', 'TITLE OPINION', 'ELEVATION CERT', 'FLOOD CERT',
  'ENCROACHMENT',
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
  return 'SKIP';
}

function getDocType(filePath, fileName) {
  // For Word docs: filename keyword check first, then companion .txt content if available
  if (isWordDocument(fileName)) {
    const upper = fileName.toUpperCase();
    for (const skip of SKIP_KEYWORDS) if (upper.includes(skip.toUpperCase())) return 'SKIP';

    // Check companion _extracted/*.txt for content-based classification
    const dir = path.dirname(filePath);
    const base = path.parse(fileName).name;
    const extractedTxt = path.join(dir, '_extracted', base + '.txt');
    if (fs.existsSync(extractedTxt)) {
      try {
        const raw = fs.readFileSync(extractedTxt, 'utf-8');
        const txt = raw.toUpperCase();
        if (raw.trim().length < 80) return 'SKIP';  // stub/cover page
        // Skip ONLY if it's a pure certification doc with NO boundary courses
        if ((txt.includes('DOES HEREBY CERTIFY') || txt.includes('I HEREBY CERTIFY') ||
             txt.includes('ALTA/ACSM') || txt.includes('ELEVATION CERTIFICATE') ||
             txt.includes('FLOOD INSURANCE')) && !txt.includes('THENCE')) return 'SKIP';
        // Must have at least one boundary keyword to be a deed
        if (!txt.includes('THENCE') && !txt.includes('BEGINNING AT')) return 'SKIP';
      } catch {}
    }

    return 'DEED';
  }

  // For PDFs: try to find companion .txt file in _extracted/ for content pre-screen
  const dir = path.dirname(filePath);
  const base = path.parse(fileName).name;
  const extractedTxt = path.join(dir, '_extracted', base + '.txt');
  if (fs.existsSync(extractedTxt)) {
    try {
      const raw = fs.readFileSync(extractedTxt, 'utf-8');
      const txt = raw.toUpperCase();

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
      // Must have at least one THENCE to be a deed
      if (!txt.includes('THENCE') && !txt.includes('BEGINNING AT')) {
        return 'SKIP';
      }
    } catch {}
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
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.doc': 'application/pdf', '.docx': 'application/pdf' };
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

// POST /api/folderscan/process-batch
router.post('/process-batch', async (req, res) => {
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
    const concurrency = parseInt(req.query.concurrency) || 5;
    const autoOutput = req.query.autoOutput === 'true';

    const allProcessable = getSupportedFiles(validPath).filter(f => {
      const stats = fs.statSync(f);
      const docType = getDocType(f, path.basename(f));
      return docType !== 'SKIP' && stats.size <= MAX_FILE_SIZE;
    });

    if (allProcessable.length === 0) return res.json({ message: 'No processable deed PDFs found.', results: [] });

    const totalBatches = Math.ceil(allProcessable.length / 20);
    if (batchIndex >= totalBatches) return res.status(400).json({ error: `batchIndex ${batchIndex} out of range (0–${totalBatches - 1}).` });

    const batch = allProcessable.slice(batchIndex * 20, (batchIndex + 1) * 20);
    const batchId = uuidv4();
    const results = new Array(batch.length);

    db.saveBatchRun(batchId, batch.length, 0.0);
    console.log(`FolderScan batch ${batchIndex}/${totalBatches - 1}: ${batch.length} files from ${req.query.path}`);

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
        // If _extracted/<base>.txt exists and contains labeled "Parcel A" / "Parcel B"
        // sections, process each parcel independently and save separate DB records
        // named <filename>__A and <filename>__B.
        // The original file is still processed below as a "container" record.
        const extractedTxtPath = path.join(validPath, '_extracted', path.parse(fileName).name + '.txt');
        let rawDocText = '';
        try {
          if (fs.existsSync(extractedTxtPath)) {
            rawDocText = fs.readFileSync(extractedTxtPath, 'utf-8');
          }
        } catch {}

        const namedParcels = extractNamedParcels(rawDocText);
        if (namedParcels && namedParcels.length >= 2) {
          console.log(`FolderScan: Multi-parcel deed detected in ${fileName} — ${namedParcels.length} parcels: ${namedParcels.map(p => p.label).join(', ')}`);
          for (const { label, text: parcelText } of namedParcels) {
            const ext = path.extname(fileName);       // e.g. '.pdf'
            const base = path.parse(fileName).name;   // e.g. '2525.894 - Monument Road'
            const parcelFileName = `${base}__${label}${ext}`;  // e.g. '2525.894 - Monument Road__A.pdf'
            const isOE = detectOpenEnded(parcelText, parcelFileName, false);
            console.log(`FolderScan: Processing parcel ${label} → ${parcelFileName} (isOpenEnded=${isOE})`);
            try {
              // Re-run repair pipeline on full image but with parcel context in fileName
              const pResult = await runRepairPipeline(imageBytes, mime, pob, units, isOE, parcelFileName);
              const pEx = pResult.finalExtraction;
              const pTr = pResult.finalTraverse;
              const pStatus = pResult.status;
              const pStage  = pResult.repairStageUsed;
              const pLabel  = `[${label}] ${county && state ? `${county}, ${state}` : base}`;
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
          // Fall through to also save the original file as-is (container record)
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

          // All tiers failed — fall through to original SKIP
          console.log(`FolderScan batch: ${fileName} — SKIPPED (${extraction.classification})`);
          results[index] = {
            fileName, status: 'skipped', extraction, traverse: null, legalDescription: null,
            error: null, skipReason: `Non-traversable: ${extraction.classification}`,
          };
          db.saveDeedLog(batchId, fileName, `[SKIPPED] ${path.parse(fileName).name}`, 0, 0, 0,
            'SKIPPED', 'Non-traversable document', JSON.stringify(extraction), null);
          return;
        }

        // Original SKIP for PLAT type (no geometry possible)
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
          output.writeResultFiles(outputFolder, r.fileName, r, r.legalDescription);
        }
        output.writeBatchSummary(outputFolder, req.query.path, results, Date.now() - start);
      } catch (ex) { console.warn('Auto-output failed:', ex.message); }
    }

    res.json({ batchId, batchIndex, totalBatches, filesInBatch: batch.length, outputFolder, results: { results, totalProcessed: results.length, succeeded, failed: results.length - succeeded } });
  } catch (ex) {
    console.error('FolderScan process-batch error:', ex);
    res.status(500).json({ error: ex.message });
  }
});

// POST /api/folderscan/process-file
router.post('/process-file', async (req, res) => {
  try {
    const validPath = validatePath(req.query.path);
    if (!validPath) return res.status(403).json({ error: 'Path is not allowed.' });
    if (!fs.existsSync(validPath)) return res.status(404).json({ error: `Directory not found: ${validPath}` });

    const fileName = req.query.file;
    if (!fileName) return res.status(400).json({ error: 'file query parameter is required.' });

    const filePath = path.join(validPath, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: `File not found: ${filePath}` });

    const pobN = parseFloat(req.query.pobN) || 5000;
    const pobE = parseFloat(req.query.pobE) || 5000;
    const units = req.query.units || 'Feet';
    const county = req.query.county || null;
    const state = req.query.state || null;
    const batchId = req.query.batchId || uuidv4();
    db.saveBatchRun(batchId, 1, 0.0);
    const autoOutput = req.query.autoOutput === 'true';

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
        return res.json({ status: 'success', result });
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
      return res.json({ status: 'skipped', result });
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

    res.json({ status: status === 'PASS' ? 'success' : 'error', result });
  } catch (ex) {
    console.error(`FolderScan item failed: ${req.query.file}`, ex.message);
    res.status(500).json({ error: ex.message });
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

  const pobN      = parseFloat(req.query.pobN) || 5000;
  const pobE      = parseFloat(req.query.pobE) || 5000;
  const units     = req.query.units || 'Feet';
  const county    = req.query.county || null;
  const state     = req.query.state  || null;
  const maxPasses = parseInt(req.query.maxPasses) || 3;   // retry rounds
  const concurrency = 1;  // MUST be 1 — setProvider() is global state; concurrent calls corrupt each other
  const PER_FILE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min max per file

  // Local model cascade — try best first, fall back
  const LOCAL_MODELS = ['gemma4:e2b', 'qwen2.5-coder:7b', 'deepseek-coder:6.7b', 'qwen2.5-coder:1.5b'];

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

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

              const repairResult = await runRepairPipeline(imageBytes, mime, pob, units, isOpenEnded, fileName, maxPasses);

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
    clearInterval(heartbeat);                              // stop keepalive
    try { geminiVision.setProvider(originalProvider, originalModel); } catch {}
    if (!res.writableEnded) res.end();
  }
});

export default router;
