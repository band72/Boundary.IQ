/**
 * Boundary.IQ -- Continuous Batch Testing and Verification Utility (Per-File Concurrency Version)
 * 
 * This script interacts with the running Express server to execute, monitor,
 * and analyze batches of deed legal descriptions. By calling the single-file
 * processing API endpoint, it avoids HTTP timeout limitations and provides real-time
 * per-file logging and progress tracking.
 * 
 * Usage:
 *   node scripts/runBatchTest.js --scan
 *   node scripts/runBatchTest.js --batch <index>
 *   node scripts/runBatchTest.js --all
 *   node scripts/runBatchTest.js --stats
 */

import { argv } from 'process';
import { fetch, Agent, setGlobalDispatcher } from 'undici';

// Configure global undici dispatcher to support 30 minutes timeout for native fetch (client requests to Express server)
setGlobalDispatcher(new Agent({
  connectTimeout: 1800000,
  headersTimeout: 1800000,
  bodyTimeout: 1800000
}));

const PORT = process.env.PORT || 5050;
const BASE_URL = `http://localhost:${PORT}`;
const DEFAULT_PATH = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF/Regency-Title';

let authToken = null;

async function authenticate() {
  const username = 'cli_tester';
  const password = 'CliPassword123!';
  try {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (loginRes.ok) {
      const data = await loginRes.json();
      authToken = data.token;
      return;
    }
  } catch (err) {
    // Ignore error and try registering
  }
  
  try {
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (regRes.ok) {
      const data = await regRes.json();
      authToken = data.token;
    }
  } catch (err) {
    console.error(`Authentication helper error: ${err.message}`);
  }
}

const ANSI_COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  
  fgBlack: '\x1b[30m',
  fgRed: '\x1b[31m',
  fgGreen: '\x1b[32m',
  fgYellow: '\x1b[33m',
  fgBlue: '\x1b[34m',
  fgMagenta: '\x1b[35m',
  fgCyan: '\x1b[36m',
  fgWhite: '\x1b[37m',
  
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m'
};

async function getStats() {
  try {
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/api/diagnostics/stats`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stats = await res.json();
    return stats;
  } catch (err) {
    console.error(`${ANSI_COLORS.fgRed}✗ Failed to fetch database stats: ${err.message}${ANSI_COLORS.reset}`);
    return null;
  }
}

async function scanFolder(folderPath) {
  console.log(`\n${ANSI_COLORS.fgCyan}🔍 Scanning folder: ${folderPath}...${ANSI_COLORS.reset}`);
  try {
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/api/folderscan/scan?path=${encodeURIComponent(folderPath)}`, { headers });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    console.log(`${ANSI_COLORS.fgGreen}✓ Scan complete!${ANSI_COLORS.reset}`);
    console.log(`  Total supported files: ${ANSI_COLORS.bright}${data.total}${ANSI_COLORS.reset}`);
    console.log(`  Processable files:     ${ANSI_COLORS.fgGreen}${data.toProcess}${ANSI_COLORS.reset}`);
    console.log(`  Files to skip:         ${ANSI_COLORS.fgYellow}${data.toSkip}${ANSI_COLORS.reset}`);
    console.log(`  Batches needed:        ${ANSI_COLORS.bright}${data.batchesNeeded}${ANSI_COLORS.reset} (20 files per batch)`);
    return data;
  } catch (err) {
    console.error(`${ANSI_COLORS.fgRed}✗ Folder scan failed: ${err.message}${ANSI_COLORS.reset}`);
    console.log(`  Make sure the local server is running on port ${PORT}.`);
    return null;
  }
}
async function processSingleFile(folderPath, fileName, index, total, batchId) {
  const startTime = Date.now();
  try {
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const url = `${BASE_URL}/api/folderscan/process-file?path=${encodeURIComponent(folderPath)}&file=${encodeURIComponent(fileName)}&batchId=${batchId}&autoOutput=true&force=true`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(1800000) // 30 min timeout for local CPU inference
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    if (data.status === 'success') {
      const r = data.result;
      const cachedStr = r.cached ? ` ${ANSI_COLORS.fgBlue}(CACHED)${ANSI_COLORS.reset}` : '';
      const precisionStr = r.traverse?.closure?.precisionRatio || 'Open-Ended';
      const linearErr = r.traverse?.closure?.linearError != null ? `${r.traverse.closure.linearError.toFixed(4)}ft` : 'N/A';
      console.log(`  [${index}/${total}] ${ANSI_COLORS.fgGreen}✓ ${fileName}${ANSI_COLORS.reset}:${cachedStr} PASS in ${duration}s | Error: ${linearErr} | Precision: ${precisionStr}`);
      return { success: true, skipped: false, fileName };
    } else if (data.status === 'skipped') {
      const r = data.result;
      console.log(`  [${index}/${total}] ${ANSI_COLORS.fgYellow}⚠ ${fileName}${ANSI_COLORS.reset}: SKIPPED in ${duration}s | Reason: ${r?.skipReason || 'Non-traversable'}`);
      return { success: false, skipped: true, fileName };
    } else {
      const r = data.result;
      const linearErr = r?.traverse?.closure?.linearError != null ? `${r.traverse.closure.linearError.toFixed(4)}ft` : 'N/A';
      console.log(`  [${index}/${total}] ${ANSI_COLORS.fgRed}✗ ${fileName}${ANSI_COLORS.reset}: FAIL in ${duration}s | Error: ${linearErr} | ErrorDetails: ${r?.error || 'OCR/LLM parsing failure'}`);
      return { success: false, skipped: false, fileName };
    }
  } catch (err) {
    console.log(`  [${index}/${total}] ${ANSI_COLORS.fgRed}✗ ${fileName}${ANSI_COLORS.reset}: CRASHED in ${((Date.now() - startTime) / 1000).toFixed(1)}s | Error: ${err.message}`);
    return { success: false, skipped: false, fileName };
  }
}

async function getActiveProvider() {
  try {
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/api/settings/model`, { headers });
    if (!res.ok) return 'gemini';
    const data = await res.json();
    return data.activeProvider || 'gemini';
  } catch {
    return 'gemini';
  }
}

async function processBatch(folderPath, scanData, batchIndex) {
  const provider = await getActiveProvider();
  const concurrencyLimit = provider === 'ollama' ? 1 : 6;
  
  console.log(`\n${ANSI_COLORS.fgBlue}🚀 Launching Batch ${batchIndex} (Per-File Concurrency)...${ANSI_COLORS.reset}`);
  console.log(`  Provider: ${ANSI_COLORS.bright}${provider}${ANSI_COLORS.reset} | Concurrency: ${ANSI_COLORS.bright}${concurrencyLimit}${ANSI_COLORS.reset}`);
  const startTime = Date.now();
  
  const allProcessable = scanData.files.filter(f => f.willProcess);
  const batchFiles = allProcessable.slice(batchIndex * 20, (batchIndex + 1) * 20);
  
  if (batchFiles.length === 0) {
    console.log(`${ANSI_COLORS.fgYellow}⚠ No processable files in this batch.${ANSI_COLORS.reset}`);
    return null;
  }
  
  const batchId = crypto.randomUUID ? crypto.randomUUID() : 'batch_' + Date.now();
  const queue = [...batchFiles];
  const results = [];
  let completedCount = 0;
  
  async function worker() {
    while (queue.length > 0) {
      const fileObj = queue.shift();
      const currIdx = ++completedCount;
      const res = await processSingleFile(folderPath, fileObj.fileName, currIdx, batchFiles.length, batchId);
      results.push(res);
    }
  }
  
  // Start parallel workers
  const numWorkers = Math.min(concurrencyLimit, batchFiles.length);
  const workers = Array.from({ length: numWorkers }, () => worker());
  await Promise.all(workers);
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const succeeded = results.filter(r => r.success && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  const failed = results.filter(r => !r.success && !r.skipped).length;
  const processableCount = results.length - skipped;
  const passRate = processableCount > 0 ? (succeeded / processableCount * 100).toFixed(1) : 0;
  
  console.log(`\n${ANSI_COLORS.fgGreen}✓ Batch ${batchIndex} Completed in ${duration}s!${ANSI_COLORS.reset}`);
  console.log(`  Total: ${ANSI_COLORS.bright}${results.length}${ANSI_COLORS.reset} | Succeeded: ${ANSI_COLORS.fgGreen}${succeeded}${ANSI_COLORS.reset} | Skipped: ${ANSI_COLORS.fgYellow}${skipped}${ANSI_COLORS.reset} | Failed: ${ANSI_COLORS.fgRed}${failed}${ANSI_COLORS.reset}`);
  console.log(`  Processable Pass Rate: ${ANSI_COLORS.bright}${passRate}%${ANSI_COLORS.reset}`);
  
  return { totalProcessed: results.length, succeeded, skipped, failed };
}

async function printDBStats() {
  const stats = await getStats();
  if (!stats) return;
  
  console.log(`\n${ANSI_COLORS.bgBlue}${ANSI_COLORS.fgWhite}  BOUNDARY.IQ DATABASE STATS  ${ANSI_COLORS.reset}`);
  console.log(`  Database Path: ${ANSI_COLORS.dim}${stats.dbPath}${ANSI_COLORS.reset}`);
  console.log(`  Total Deed Logs:   ${ANSI_COLORS.bright}${stats.deedLogCount}${ANSI_COLORS.reset}`);
  console.log(`  Passing Deeds:     ${ANSI_COLORS.fgGreen}${stats.passCount}${ANSI_COLORS.reset}`);
  console.log(`  Failing Deeds:     ${ANSI_COLORS.fgRed}${stats.failCount}${ANSI_COLORS.reset}`);
  console.log(`  Batch Runs Saved:  ${ANSI_COLORS.bright}${stats.batchRunCount}${ANSI_COLORS.reset}`);
  
  const overallPassRate = stats.deedLogCount > 0 ? (stats.passCount / stats.deedLogCount * 100).toFixed(1) : 0;
  console.log(`  Overall Accuracy:  ${ANSI_COLORS.bright}${overallPassRate}%${ANSI_COLORS.reset}`);
}

async function main() {
  await authenticate();
  const args = argv.slice(2);
  let folderPath = DEFAULT_PATH;
  const dirIdx = args.indexOf('--dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    folderPath = args[dirIdx + 1];
    args.splice(dirIdx, 2);
  }

  const mode = args[0] || '--stats';
  
  console.log(`${ANSI_COLORS.fgCyan}=====================================================${ANSI_COLORS.reset}`);
  console.log(`${ANSI_COLORS.bright}       Boundary.IQ Node.js Batch Testing Utility     ${ANSI_COLORS.reset}`);
  console.log(`${ANSI_COLORS.fgCyan}=====================================================${ANSI_COLORS.reset}`);
  
  if (mode === '--stats') {
    await printDBStats();
    return;
  }
  
  const scanData = await scanFolder(folderPath);
  if (!scanData) return;
  
  if (mode === '--scan') {
    return;
  }
  
  if (mode === '--batch') {
    const idx = parseInt(args[1]);
    if (isNaN(idx) || idx < 0 || idx >= scanData.batchesNeeded) {
      console.error(`${ANSI_COLORS.fgRed}✗ Invalid batch index. Must be between 0 and ${scanData.batchesNeeded - 1}.${ANSI_COLORS.reset}`);
      return;
    }
    await processBatch(folderPath, scanData, idx);
    await printDBStats();
    return;
  }
  
  if (mode === '--all') {
    console.log(`\n${ANSI_COLORS.fgYellow}⚡ RUNNING ALL BATCHES SEQUENTIALLY ⚡${ANSI_COLORS.reset}`);
    const startIdx = parseInt(args[1]) || 0;
    
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    
    for (let i = startIdx; i < scanData.batchesNeeded; i++) {
      console.log(`\n--------------------------------------------`);
      console.log(`Batch Progress: ${i + 1} / ${scanData.batchesNeeded}`);
      console.log(`--------------------------------------------`);
      
      const batchResult = await processBatch(folderPath, scanData, i);
      if (batchResult) {
        totalProcessed += batchResult.totalProcessed;
        totalSucceeded += batchResult.succeeded;
        totalSkipped += batchResult.skipped || 0;
        totalFailed += batchResult.failed;
      }
      
      const currStats = await getStats();
      if (currStats) {
        const passRate = currStats.deedLogCount > 0 ? (currStats.passCount / currStats.deedLogCount * 100).toFixed(1) : 0;
        console.log(`Accumulated accuracy in SQLite: ${ANSI_COLORS.bright}${passRate}%${ANSI_COLORS.reset}`);
      }
    }
    
    console.log(`\n${ANSI_COLORS.bgGreen}${ANSI_COLORS.fgBlack} 🌟 BATCH PROCESSING RUN COMPLETE 🌟 ${ANSI_COLORS.reset}`);
    console.log(`Processed: ${totalProcessed} | Succeeded: ${totalSucceeded} | Skipped: ${totalSkipped} | Failed: ${totalFailed}`);
    await printDBStats();
    return;
  }
  
  console.log(`Unknown argument. Options:`);
  console.log(`  --scan            Scan the folder to show processable files and batches.`);
  console.log(`  --stats           Display active SQLite DB statistics.`);
  console.log(`  --batch <index>   Execute a specific 20-file batch (e.g. node runBatchTest.js --batch 0).`);
  console.log(`  --all [startIdx]  Sequentially process all batches.`);
}

main();
