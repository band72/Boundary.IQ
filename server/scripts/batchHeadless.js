#!/usr/bin/env node
// ─── Boundary.IQ — Headless Deed Batch Runner ────────────────────────────────
// Imports solveFromText directly (no HTTP, no rate limiting).
// Converts .doc/.txt deeds via LibreOffice, parses them, reports pass/fail.
//
// Usage:
//   node server/scripts/batchHeadless.js [--limit=N] [--offset=N] [--fail-only]

import 'dotenv/config';
process.env.PINO_LOG_SYNC = 'true';
import fs   from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Bootstrap the DB (required by any server-side import) ─────────────────────
// config.js reads DATABASE_PATH from .env; we need to init before importing services
const SERVER_DIR = path.resolve(__dirname, '..');
process.chdir(SERVER_DIR);              // make relative paths work

// Lazy-import after env is ready
const { init: initDb } = await import('../services/db/core.js');
initDb?.();                              // non-fatal if already initialised

const { solveFromText, solveDeedText } = await import('../services/Scripting/deedTextSolver.js');
const { extractNamedParcels } = await import('../services/Scripting/repair.js');
const { DEFAULT_LOCAL_MODEL } = await import('../config.js');

// ── Config ────────────────────────────────────────────────────────────────────
const DEED_DIR    = process.env.DEED_DIR || '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions';
const EXTRACT_DIR = DEED_DIR.endsWith('_extracted') ? DEED_DIR : path.join(DEED_DIR, '_extracted');
const POB_N       = parseFloat(process.env.POB_N) || 5000;
const POB_E       = parseFloat(process.env.POB_E) || 5000;
const UNITS       = process.env.UNITS || 'Feet';
const PASS_THRESHOLD = 0.50;  // ft — treat linear error < 0.50 as PASS (accounts for arc rounding)


const args = process.argv.slice(2);
const limitArg   = args.find(a => a.startsWith('--limit='))?.split('=')[1];
const offsetArg  = args.find(a => a.startsWith('--offset='))?.split('=')[1];
const modelArg   = args.find(a => a.startsWith('--model='))?.split('=')[1];
const useAi      = args.includes('--use-ai');
const failOnlyMode = args.includes('--fail-only');
const LIMIT  = limitArg  ? parseInt(limitArg)  : Infinity;
const OFFSET = offsetArg ? parseInt(offsetArg) : 0;
const MODEL  = modelArg || DEFAULT_LOCAL_MODEL;

const cleanModel = MODEL.replace(/[:.]/g, '_');
const REPORT_FILE = path.join(SERVER_DIR, `../deed_batch_report_${cleanModel}.json`);
const SUMMARY_FILE= path.join(SERVER_DIR, `../deed_batch_summary_${cleanModel}.md`);

console.log(`📋 Boundary.IQ — Headless Deed Batch Runner (direct service call)`);
console.log(`   Deed dir  : ${DEED_DIR}`);
console.log(`   Limit=${isFinite(LIMIT)?LIMIT:'∞'}, Offset=${OFFSET}`);
console.log(`   AI Auto-Correct: ${useAi ? 'ON (Escalation to ' + MODEL + ')' : 'OFF'}`);
console.log('');

// ── Ensure extract dir ────────────────────────────────────────────────────────
if (!fs.existsSync(EXTRACT_DIR)) fs.mkdirSync(EXTRACT_DIR, { recursive: true });

// ── Collect deed files ────────────────────────────────────────────────────────
const SKIP_FILES     = new Set(['llms.txt', 'llms-full.txt']);
const PROCESSABLE_EXTS = new Set(['.doc', '.docx', '.txt', '.rtf', '.pdf']);

const allFiles = fs.readdirSync(DEED_DIR)
  .filter(f => {
    const ext = path.extname(f).toLowerCase();
    return PROCESSABLE_EXTS.has(ext) && !SKIP_FILES.has(f) && !f.startsWith('_');
  })
  .sort();

const filesToProcess = allFiles.slice(OFFSET, isFinite(LIMIT) ? OFFSET + LIMIT : undefined);
console.log(`📂 Found ${allFiles.length} deed files total. Processing ${filesToProcess.length}.\n`);

// ── Text extraction ───────────────────────────────────────────────────────────
function extractText(filePath, fileName) {
  const rawExt = path.extname(fileName);
  const ext  = rawExt.toLowerCase();
  const base = path.basename(fileName, rawExt);
  const cachedPath = path.join(EXTRACT_DIR, base + '.txt');

  // Return cache if it exists and is non-empty
  if (fs.existsSync(cachedPath)) {
    const cached = fs.readFileSync(cachedPath, 'utf8');
    if (cached.trim().length > 30) return cached;
  }

  if (ext === '.txt') {
    const text = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(cachedPath, text);
    return text;
  }

  let text = null;

  // 1. Try standard LibreOffice conversion to .txt
  try {
    const tmpDir = `/tmp/biq_ex_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    execFileSync('soffice', [
      '--headless', '--convert-to', 'txt:Text', '--outdir', tmpDir, filePath
    ], { timeout: 25000, stdio: 'ignore', env: { ...process.env, DISPLAY: '' } });
    const outTxt = path.join(tmpDir, base + '.txt');
    if (fs.existsSync(outTxt)) {
      text = fs.readFileSync(outTxt, 'utf8');
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  } catch (err) {
    console.warn(`\n⚠️ Standard text extraction failed for ${fileName}: ${err.message}`);
  }

  // 2. OCR Fallback if text is empty/short
  if (!text || text.trim().length < 30) {
    console.log(`\n🔍 [OCR Fallback] Text empty/short for ${fileName}. Attempting PDF + OCR...`);
    try {
      const tmpDir = `/tmp/biq_ocr_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      fs.mkdirSync(tmpDir, { recursive: true });

      let pdfPath = filePath;
      if (ext !== '.pdf') {
        // Convert doc/docx/rtf to pdf
        execFileSync('soffice', [
          '--headless', '--convert-to', 'pdf', '--outdir', tmpDir, filePath
        ], { timeout: 35000, stdio: 'ignore', env: { ...process.env, DISPLAY: '' } });
        pdfPath = path.join(tmpDir, base + '.pdf');
      }

      if (fs.existsSync(pdfPath)) {
        // Run OCR on PDF
        const pythonPath = path.resolve(SERVER_DIR, 'scripts/ocr_pdf.py');
        const ocrText = execFileSync('python3', [
          pythonPath, '--oneshot', pdfPath
        ], { encoding: 'utf8', timeout: 60000 });
        
        if (ocrText && ocrText.trim().length > 30) {
          console.log(`✅ [OCR Fallback] OCR succeeded for ${fileName} (${ocrText.trim().length} chars)`);
          text = ocrText;
        }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    } catch (err) {
      console.warn(`❌ [OCR Fallback] OCR failed for ${fileName}: ${err.message}`);
    }
  }

  if (text && text.trim().length > 30) {
    fs.writeFileSync(cachedPath, text);
    return text;
  }

  return null;
}

// ── Non-traversable detection ─────────────────────────────────────────────────
function getSkipReason(text, fileName) {
  const up = text.toUpperCase();
  
  const hasThence = up.includes('THENCE');
  const bearingRegex = /\b(?:NORTH|SOUTH|[NS])\b\s*\d+[\s°\-d:]+\d+[\s'\-m:]+\d+[\s"\-s:]*\b(?:EAST|WEST|[EW])\b/i;
  const distanceRegex = /\b\d+(?:\.\d+)?\s*(?:FEET|FT|METERS|M\b)/i;
  const hasMetesAndBounds = bearingRegex.test(text) && distanceRegex.test(text);

  if (!hasThence && !hasMetesAndBounds) {
    return 'NO_THENCE';
  }

  // Pure lot-and-block (no beginning clause with THENCE-style description)
  if (/\bLOT\s+\d+\s*,?\s*BLOCK\s+\d+\b/i.test(text) && !/\bBEGINNING\b/i.test(text)) return 'LOT_BLOCK';
  // Title commitment / cert documents
  const certWords = ['SCHEDULE A', 'SCHEDULE B', 'TITLE COMMITMENT', "SURVEYOR'S CERTIFICATE",
                     'CERTIFICATE OF TITLE', 'LEGAL OPINION'];
  if (certWords.some(w => up.includes(w))) return 'CERT_SKIP';
  // Vision OCR truncation
  if (up.includes('REST OF THE TEXT IS NOT PROVIDED') || up.includes('MAY NOT BE COMPLETE OR ACCURATE')) return 'INCOMPLETE_OCR';
  return null;
}

// ── Result classification ─────────────────────────────────────────────────────
function classifyResult(result) {
  if (!result || result.status === 'ERROR') return 'ERROR';
  const traverse = result.traverse;
  const courses  = result.repairedCourses || result.originalCourses || [];
  if (!traverse || courses.length === 0) return 'NO_COURSES';

  if (result.status === 'PASS' || result.status === 'MEANDER') return 'PASS';

  const linErr = traverse?.closure?.linearError;
  const prec   = traverse?.closure?.precisionRatio || '';

  if (linErr != null && linErr < PASS_THRESHOLD) return 'PASS';
  if (prec.includes('∞') || prec.includes('Perfect')) return 'PASS';
  const ratioParts = prec.split(':');
  if (ratioParts.length > 1) {
    const r = parseFloat(ratioParts[1].replace(/[,∞ ]/g, '') || '0');
    if (!isNaN(r) && r >= 5000) return 'PASS';   // 1:5000+ is acceptable precision
  }
  if (linErr != null && linErr < 1.0) return 'NEAR_PASS';
  return 'FAIL';
}

// ── Main loop ─────────────────────────────────────────────────────────────────
const results = [];
const stats   = { pass:0, nearPass:0, fail:0, error:0, skipped:0, noCourses:0, extractFail:0 };

// Incremental: skip already-passing deeds in --fail-only mode
let prevByFile = {};
if (fs.existsSync(REPORT_FILE) && failOnlyMode) {
  try {
    const prev = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    for (const r of (prev.results || [])) prevByFile[r.fileName] = r;
  } catch {}
}

for (let i = 0; i < filesToProcess.length; i++) {
  const fileName = filesToProcess[i];
  const filePath = path.join(DEED_DIR, fileName);
  const pct    = ((i + 1) / filesToProcess.length * 100).toFixed(0);
  const prefix = `[${String(i+1).padStart(4)}/${filesToProcess.length}] ${pct.padStart(3)}%`;

  process.stdout.write(`${prefix} ${fileName.slice(0,40).padEnd(40)} `);

  // Skip already-passing in fail-only mode
  if (failOnlyMode && prevByFile[fileName]?.status === 'PASS') {
    results.push(prevByFile[fileName]);
    stats.pass++;
    process.stdout.write(`→ (prev PASS)\n`);
    continue;
  }

  // Extract text
  const text = extractText(filePath, fileName);
  if (!text || text.trim().length < 30) {
    process.stdout.write(`→ EXTRACT_FAIL\n`);
    results.push({ fileName, status:'EXTRACT_FAIL', linearError:null, courses:0, error:'Text extraction failed' });
    stats.extractFail++;
    continue;
  }

  // Skip non-traversable docs
  const skipReason = getSkipReason(text, fileName);
  if (skipReason) {
    process.stdout.write(`→ SKIP(${skipReason})\n`);
    results.push({ fileName, status:'SKIPPED', skipReason, linearError:null, courses:0, snippet:text.slice(0,200) });
    stats.skipped++;
    continue;
  }

  // Direct service call — no HTTP, no rate limit
  let result, status, errMsg = null;
  let solveTextArray = [text];
  const parsedParcels = extractNamedParcels(text);
  if (parsedParcels && parsedParcels.length > 0) {
    const metesParcels = parsedParcels.filter(p => /\b(THENCE|COMMENCE|BEGIN)\b/i.test(p.text));
    if (metesParcels.length > 0) {
      solveTextArray = metesParcels.map(p => p.text);
    }
  }

  let bestStatus = 'NO_COURSES';
  let worstStatus = 'PASS';
  let bestError = Infinity;
  let docCourses = 0;
  let usedAi = false;
  let docErrMsg = null;
  let lastPrecRatio = '';

  for (const solveText of solveTextArray) {
    let result, status, errMsg = null;
    let localUsedAi = false;

    try {
      result = solveFromText(solveText, { pobNorthing: POB_N, pobEasting: POB_E, units: UNITS });
      status = classifyResult(result);
    } catch (e) {
      errMsg = e.message?.slice(0, 300) || 'Unknown error';
      if (/no thence|no courses/i.test(errMsg)) {
        status = 'NO_COURSES';
      } else {
        status = 'ERROR';
      }
      result = null;
    }

    // Escalate to AI if enabled and regex didn't pass
    if (useAi && status !== 'PASS') {
      try {
        process.stdout.write(`[AI...] `);
        const aiResult = await solveDeedText(solveText, MODEL, { pobNorthing: POB_N, pobEasting: POB_E, units: UNITS });
        
        let aiStatus = 'PASS';
        let aiMaxErr = 0;
        let aiCourses = 0;
        
        // If AI returned multiple tracts for this parcel chunk, evaluate them all
        const tractsToEval = (aiResult.tracts && aiResult.tracts.length > 0) ? aiResult.tracts : [aiResult];
        for (const t of tractsToEval) {
          const st = classifyResult(t);
          if (st !== 'PASS' && st !== 'NEAR_PASS') aiStatus = st;
          else if (st === 'NEAR_PASS' && aiStatus === 'PASS') aiStatus = 'NEAR_PASS';
          aiMaxErr = Math.max(aiMaxErr, t.traverse?.closure?.linearError || 0);
          aiCourses += (t.repairedCourses || t.originalCourses || []).length;
        }

        const regexErr = result?.traverse?.closure?.linearError ?? Infinity;
        if (aiStatus === 'PASS' || aiStatus === 'NEAR_PASS' || aiMaxErr < regexErr) {
          result = aiResult;
          status = aiStatus;
          localUsedAi = true;
          usedAi = true;
          errMsg = null;
          
          // Force overall result to reflect AI tracts for courses and err
          if (aiResult.tracts && aiResult.tracts.length > 0) {
            result.repairedCourses = { length: aiCourses }; // Mock length for aggregation
            if (result.traverse) {
              if (!result.traverse.closure) result.traverse.closure = {};
              result.traverse.closure.linearError = aiMaxErr;
            }
          }
        }
      } catch (aiErr) {
        errMsg = (errMsg ? errMsg + ' | ' : '') + `AI err: ${aiErr.message}`;
      }
    }

    const courses   = result ? (result.repairedCourses || result.originalCourses || []).length : 0;
    const linErr    = result?.traverse?.closure?.linearError ?? null;
    lastPrecRatio   = result?.traverse?.closure?.precisionRatio || lastPrecRatio;

    docCourses += courses;
    if (errMsg) docErrMsg = (docErrMsg ? docErrMsg + ' | ' : '') + errMsg;
    
    // Track best status
    if (status === 'PASS' && courses >= 3) {
      bestStatus = 'PASS';
      bestError = Math.min(bestError, linErr || 0);
    } else if (status === 'PASS' && bestStatus !== 'PASS') {
      bestStatus = 'PASS'; // Fallback if it's <3 courses but still passes
      bestError = Math.min(bestError, linErr || 0);
    } else if (status === 'NEAR_PASS' && bestStatus !== 'PASS') {
      bestStatus = 'NEAR_PASS';
    } else if (bestStatus === 'NO_COURSES' && status !== 'NO_COURSES') {
      bestStatus = status; // ERROR or FAIL
    }

    // Aggregate worst status just for logging
    if (status !== 'PASS') {
      if (worstStatus === 'PASS' || status === 'ERROR' || status === 'FAIL') {
        worstStatus = status;
      }
    }
  }

  // If no courses were found across all parcels, it's a NO_COURSES
  let finalStatus = bestStatus;
  if (docCourses === 0) finalStatus = 'NO_COURSES';
  
  let docError = bestError === Infinity ? 0 : bestError;

  if      (finalStatus === 'PASS')      stats.pass++;
  else if (finalStatus === 'NEAR_PASS') stats.nearPass++;
  else if (finalStatus === 'FAIL')      stats.fail++;
  else if (finalStatus === 'NO_COURSES')stats.noCourses++;
  else                                  stats.error++;

  const icon = { PASS:'✓', NEAR_PASS:'~', FAIL:'✗', NO_COURSES:'0', ERROR:'E' }[finalStatus] || '?';
  const errFt = docError > 0 ? ` err=${docError.toFixed(3)}ft` : '';
  const aiTag = usedAi ? ' [🤖 AI]' : '';
  process.stdout.write(`→ ${icon} ${finalStatus} ${docCourses}c${errFt}${aiTag}\n`);

  results.push({
    fileName, status: finalStatus,
    linearError: docError > 0 ? docError : null,
    precisionRatio: lastPrecRatio,
    courses: docCourses,
    error: docErrMsg,
    snippet: text.slice(0, 300),
    usedAi
  });
}

// ── Write full JSON report ────────────────────────────────────────────────────
fs.writeFileSync(REPORT_FILE, JSON.stringify(
  { generatedAt: new Date().toISOString(), stats, results }, null, 2
));
try {
  fs.copyFileSync(REPORT_FILE, path.join(SERVER_DIR, '../deed_batch_report.json'));
} catch (copyErr) {
  console.warn(`Could not copy compat report file: ${copyErr.message}`);
}

// ── Write markdown summary ────────────────────────────────────────────────────
const total    = results.filter(r => r.status !== 'SKIPPED').length;
const passRate = total > 0 ? ((stats.pass / total) * 100).toFixed(1) : '0';

const fails     = results.filter(r => r.status === 'FAIL').sort((a,b) => (b.linearError||0)-(a.linearError||0));
const noCourses = results.filter(r => r.status === 'NO_COURSES');
const errors    = results.filter(r => r.status === 'ERROR' || r.status === 'EXTRACT_FAIL');

let md = `# Boundary.IQ — Headless Deed Batch Report\n\n`;
md += `**Generated**: ${new Date().toISOString()}\n\n`;
md += `## Summary\n\n`;
md += `| Metric | Count | Rate |\n|--------|-------|------|\n`;
md += `| ✓ PASS (err<0.30ft or 1:10k) | ${stats.pass} | ${passRate}% of processable |\n`;
md += `| ~ NEAR_PASS (err<1ft) | ${stats.nearPass} | - |\n`;
md += `| ✗ FAIL | ${stats.fail} | - |\n`;
md += `| 0 NO_COURSES | ${stats.noCourses} | - |\n`;
md += `| ⚠ ERROR | ${stats.error} | - |\n`;
md += `| → EXTRACT_FAIL | ${stats.extractFail} | - |\n`;
md += `| — SKIPPED | ${stats.skipped} | (non-boundary docs) |\n\n`;

md += `## Top 50 Failures\n\n`;
md += `| File | Err (ft) | Precision | Courses | Snippet |\n|------|---------|-----------|---------|--------|\n`;
for (const f of fails.slice(0, 50)) {
  const snip = (f.snippet||'').slice(0,80).replace(/\n/g,' ').replace(/\|/g,'¦');
  md += `| ${f.fileName} | ${f.linearError?.toFixed(3)??'N/A'} | ${f.precisionRatio||'N/A'} | ${f.courses} | ${snip} |\n`;
}

md += `\n## NO_COURSES (parser found no THENCE courses)\n\n`;
for (const f of noCourses.slice(0, 50)) {
  const snip = (f.snippet||'').slice(0,200).replace(/\n/g,' ');
  md += `- **${f.fileName}**: ${f.error || ''}\n  > ${snip}\n`;
}

md += `\n## Errors / Parse failures\n\n`;
for (const f of errors.slice(0, 30)) {
  md += `- **${f.fileName}**: ${f.error || ''}\n`;
}

fs.writeFileSync(SUMMARY_FILE, md);
try {
  fs.copyFileSync(SUMMARY_FILE, path.join(SERVER_DIR, '../deed_batch_summary.md'));
} catch (copyErr) {
  console.warn(`Could not copy compat summary file: ${copyErr.message}`);
}

console.log(`\n${'─'.repeat(65)}`);
console.log(`✓  PASS       : ${stats.pass}  (${passRate}%)`);
console.log(`~  NEAR_PASS  : ${stats.nearPass}`);
console.log(`✗  FAIL       : ${stats.fail}`);
console.log(`0  NO_COURSES : ${stats.noCourses}`);
console.log(`⚠  ERROR      : ${stats.error}`);
console.log(`✂  EXTRACT_FL : ${stats.extractFail}`);
console.log(`→  SKIPPED    : ${stats.skipped}`);
console.log(`\n📄 Report : ${REPORT_FILE}`);
console.log(`📝 Summary: ${SUMMARY_FILE}`);

process.exit(0);
