/**
 * autoRepairLoop.js
 * Iterates all deeds in _FAILED, records closure errors, and writes a JSON
 * analysis report. Uses the same undici + folderscan/process-file pattern as
 * runBatchTest.js.
 *
 * Usage:
 *   node scripts/autoRepairLoop.js [--dir <folder>]
 */
import { fetch, Agent, setGlobalDispatcher } from 'undici';
import fs   from 'fs';
import path from 'path';
import { createOutputFolder, writeBatchSummary, writeCombinedBatchPdf } from '../services/output.js';

setGlobalDispatcher(new Agent({
  connectTimeout: 1800000,
  headersTimeout: 1800000,
  bodyTimeout:    1800000,
}));

const PORT     = process.env.PORT || 5050;
const BASE_URL = `http://localhost:${PORT}`;
const dirIdx = process.argv.indexOf('--dir');
const FAILED_DIR = (dirIdx !== -1 && process.argv[dirIdx + 1])
  || process.env.TRAINING_DIR
  || null;

if (!FAILED_DIR) {
  console.error('\n✗ No input directory specified.');
  console.error('  Use:  node scripts/autoRepairLoop.js --dir /path/to/_FAILED');
  console.error('  Or:   set TRAINING_DIR=/path/to/_FAILED in your .env\n');
  process.exit(1);
}

// ── Auth ─────────────────────────────────────────────────────────────────────
let authToken = null;
async function authenticate() {
  for (const endpoint of [`${BASE_URL}/api/auth/login`, `${BASE_URL}/api/auth/register`]) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'cli_tester', password: 'CliPassword123!' }),
      });
      if (r.ok) { ({ token: authToken } = await r.json()); return; }
    } catch { /* try next */ }
  }
  throw new Error('Authentication failed on both login and register endpoints');
}

// ── Ollama model warmup — ensures the model is loaded before batch starts ─────
async function warmupOllama(model = 'deepseek-r1:14b') {
  const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  try {
    console.log(`Warming up Ollama model: ${model}…`);
    const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'ping', stream: false, options: { num_predict: 1, num_ctx: 512 } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (r.ok) {
      const data = await r.json();
      if (data.response !== undefined) {
        console.log(`✓ Ollama model "${model}" warmed up and ready.`);
        return;
      }
    }
    console.warn(`Ollama warmup returned unexpected response (status ${r.status}). Proceeding anyway.`);
  } catch (e) {
    console.warn(`Ollama warmup failed: ${e.message}. Proceeding anyway.`);
  }
}

// ── Process one file via the folderscan/process-file endpoint ─────────────────
async function processFile(folderPath, fileName, outputPath, force) {
  const url = `${BASE_URL}/api/folderscan/process-file`
    + `?path=${encodeURIComponent(folderPath)}`
    + `&file=${encodeURIComponent(fileName)}`
    + `&batchId=autoloop&autoOutput=true&force=${force}`
    + `&outputPath=${encodeURIComponent(outputPath)}`;

  const startMs = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(1_800_000),
    });
    const elapsed = Date.now() - startMs;
    const body = await r.json().catch(() => ({}));

    if (!r.ok) {
      return {
        file: fileName,
        status: 'HTTP_ERROR',
        httpStatus: r.status,
        elapsed,
        error: body.error || '',
        apiResult: { fileName, status: 'error', error: body.error || `HTTP ${r.status}` }
      };
    }

    const result   = body.result || body;
    const apiStatus = body.status; // 'success'|'fail'|'skipped'

    const pipeStatus   = result.status         || '';
    const stage        = result.repairStageUsed || '';
    const trav         = result.traverse        || {};
    const closure      = trav.closure           || {};
    const linErr       = closure.linearError    ?? null;
    const precStr      = closure.precisionRatio ?? null;
    const errN         = closure.errorNorthing  ?? null;
    const errE         = closure.errorEasting   ?? null;
    const traverseError = result.traverseError  || result.error || null;
    const skipped      = apiStatus === 'skipped';

    // Determine final status for our reporting
    let status;
    if (skipped)                                   status = 'SKIPPED';
    else if (apiStatus === 'success')              status = 'PASS';
    else if (pipeStatus === 'PASS')                status = 'PASS';
    else if (pipeStatus === 'MEANDER')             status = 'MEANDER';
    else                                            status = 'FAIL';

    return { file: fileName, status, stage, linErr, precStr, errN, errE, traverseError, elapsed, apiResult: result };
  } catch (err) {
    return {
      file: fileName,
      status: 'CRASH',
      error: err.message,
      elapsed: Date.now() - startMs,
      apiResult: { fileName, status: 'error', error: err.message }
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Find run index
  let runIdx = 1;
  while (fs.existsSync(`/tmp/repair_run_${runIdx}.json`)) runIdx++;

  const line = '═'.repeat(70);
  console.log(`\n${line}`);
  console.log(`  Boundary.IQ — Autonomous Failed-Deed Repair Loop  [Run #${runIdx}]`);
  console.log(`  Dir: ${FAILED_DIR}`);
  console.log(`${line}\n`);

  await authenticate();
  console.log('✓ Authenticated\n');

  // Warmup: ensure the target LLM model is loaded before serial batch processing
  const modelToWarmup = process.env.ACTIVE_MODEL || 'deepseek-r1:14b';
  await warmupOllama(modelToWarmup);

  const fileIdx = process.argv.indexOf('--file');
  const fileFilter = fileIdx !== -1 ? process.argv[fileIdx + 1] : null;

  let files = fs.readdirSync(FAILED_DIR)
    .filter(f => /\.(doc|docx|pdf)$/i.test(f))
    .sort();

  if (fileFilter) {
    const filters = fileFilter.split(',').map(s => s.trim().toUpperCase());
    files = files.filter(f => filters.some(filt => f.toUpperCase().includes(filt)));
    console.log(`Applying filter --file: "${fileFilter}" (matches ${files.length} file(s))`);
  }

  console.log(`Processing ${files.length} files...\n`);

  // Create a single dated output folder inside the FAILED_DIR
  const outputFolder = createOutputFolder(FAILED_DIR);

  const results = [];
  let passed = 0, failed = 0, skipped = 0, crashed = 0;

  const forceIdx = process.argv.indexOf('--force');
  const forceBypass = forceIdx !== -1;

  const startMs = Date.now();

  for (let i = 0; i < files.length; i++) {
    const rec = await processFile(FAILED_DIR, files[i], outputFolder, forceBypass);
    results.push(rec);

    const icon = rec.status === 'PASS'    ? '\x1b[32m✓\x1b[0m'
               : rec.status === 'MEANDER' ? '\x1b[33m~\x1b[0m'
               : rec.status === 'SKIPPED' ? '\x1b[34m-\x1b[0m'
               : rec.status === 'CRASH'   ? '\x1b[35m💥\x1b[0m'
               : '\x1b[31m✗\x1b[0m';

    if (['PASS','MEANDER'].includes(rec.status)) passed++;
    else if (rec.status === 'SKIPPED') skipped++;
    else if (rec.status === 'CRASH')   crashed++;
    else failed++;

    const eStr = rec.linErr != null ? `err=${rec.linErr.toFixed(3).padStart(8)}ft` : '             ';
    const cStr = (rec.errN != null && rec.errE != null)
      ? `  N=${rec.errN.toFixed(3).padStart(8)} E=${rec.errE.toFixed(3).padStart(8)}`
      : '';
    console.log(`[${String(i+1).padStart(3)}/${files.length}] ${icon} ${rec.file.padEnd(28)} ${rec.status.padEnd(8)} ${eStr}${cStr}`);
    if (rec.stage && rec.status !== 'PASS')  console.log(`          stage: ${rec.stage}`);
    if (rec.traverseError) console.log(`          tErr: ${String(rec.traverseError).slice(0,120)}`);
    if (rec.error)         console.log(`          err:  ${String(rec.error).slice(0,120)}`);
  }

  // ── Summary & Pattern Analysis ────────────────────────────────────────────
  const line2 = '─'.repeat(70);
  console.log(`\n${line2}`);
  console.log(`Run #${runIdx} Complete: ${files.length} files | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped} | Crashed: ${crashed}`);
  console.log(`Pass rate: ${((passed / (files.length - skipped)) * 100).toFixed(1)}%  (excl. skipped)`);

  const failedRecs = results.filter(r => !['PASS','MEANDER','SKIPPED'].includes(r.status));
  const withErr    = failedRecs.filter(r => r.linErr != null);
  const unidirFails = withErr.filter(r =>
    r.errN != null && r.errE != null &&
    Math.min(Math.abs(r.errN), Math.abs(r.errE)) / (Math.hypot(r.errN, r.errE) || 1) < 0.08
  );
  const smallFails = withErr.filter(r => r.linErr <= 5);
  const largeFails = withErr.filter(r => r.linErr > 50);

  console.log(`\nFailure patterns:`);
  console.log(`  Unidirectional error (bearing mismatch):  ${unidirFails.length}`);
  console.log(`  Small near-miss (≤5ft):                   ${smallFails.length}`);
  console.log(`  Large error (>50ft, likely extraction):   ${largeFails.length}`);
  console.log(`  Crashed / no-server-reach:                ${crashed}`);

  console.log(`\nTop 15 worst failures (by linear error):`);
  withErr
    .sort((a,b) => b.linErr - a.linErr)
    .slice(0, 15)
    .forEach(r => {
      const udir = (r.errN != null && r.errE != null &&
        Math.min(Math.abs(r.errN), Math.abs(r.errE)) / (Math.hypot(r.errN, r.errE)||1) < 0.08)
        ? ' [UNIDIR]' : '';
      console.log(`  ${r.file.padEnd(30)} linErr=${r.linErr.toFixed(3).padStart(8)}ft  N=${(r.errN??0).toFixed(3).padStart(8)} E=${(r.errE??0).toFixed(3).padStart(8)}${udir}`);
    });

  // Write JSON report
  const summary = {
    runIdx, timestamp: new Date().toISOString(), dir: FAILED_DIR,
    total: files.length, passed, failed, skipped, crashed,
    passRate: ((passed / (files.length - skipped)) * 100).toFixed(1),
    patterns: { unidirectional: unidirFails.length, smallError: smallFails.length, largeError: largeFails.length, crash: crashed },
    results,
  };
  const jsonPath = `/tmp/repair_run_${runIdx}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  console.log(`\n✓ Report saved: ${jsonPath}`);

  // Write batch summary JSON/TXT to outputFolder
  const batchSummaryResults = results.map(r => {
    const apiRes = r.apiResult || {};
    return {
      fileName: apiRes.fileName || r.file,
      status: apiRes.status || (r.status === 'PASS' ? 'success' : (r.status === 'SKIPPED' ? 'skipped' : 'error')),
      extraction: apiRes.extraction || { courses: [] },
      traverse: apiRes.traverse || { closure: { linearError: r.linErr, precisionRatio: r.precStr } },
      error: apiRes.error || r.traverseError || r.error
    };
  });

  const elapsedTotal = Date.now() - startMs;
  writeBatchSummary(outputFolder, FAILED_DIR, batchSummaryResults, elapsedTotal);

  // Compile single combined PDF
  console.log('Compiling combined batch PDF report...');
  await writeCombinedBatchPdf(outputFolder);

  return summary;
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
