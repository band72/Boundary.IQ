#!/usr/bin/env node
/**
 * run_targeted_20.js
 * Runs process-file on the 20 known-failing deeds from the DB,
 * using gemma3:4b for speed (~30-60s/file vs 4min for deepseek-r1).
 * Reports pass/fail results at the end.
 */
import { fetch, Agent, setGlobalDispatcher } from 'undici';
import path from 'path';
import fs from 'fs';

setGlobalDispatcher(new Agent({
  connectTimeout: 1800000,
  headersTimeout: 1800000,
  bodyTimeout:    1800000,
}));

const PORT     = process.env.PORT || 5050;
const BASE_URL = `http://localhost:${PORT}`;
const BASE_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions';

// The 20 DB-confirmed failing deeds (db name → actual filename on disk)
const TARGETS = [
  { db: '12271.doc',        file: '12271.doc' },
  { db: '11211L.doc',       file: '11211L.doc' },
  { db: '13245L__IN.doc',   file: '13245L.doc' },
  { db: '13245L.doc',       file: '13245L.doc' },
  { db: '11928L2.doc',      file: '11928L2.doc' },
  { db: '11928L.doc',       file: '11928L.doc' },
  { db: '13235-L2.doc',     file: '13235-L2.doc' },
  { db: '14319L.doc',       file: '14319L.doc' },
  { db: '13161L3.doc',      file: '13161L3.doc' },
  { db: '11082L.doc',       file: '11082L.doc' },
  { db: '10667L.doc',       file: '10667L.doc' },
  { db: '14321L.doc',       file: '14321L.doc' },
  { db: '13225_1a__1.doc',  file: '13225_1a.doc' },
  { db: '13253-L1__1.doc',  file: '13253-L1.doc' },
  { db: '13801L__1.doc',    file: '13801L.doc' },
  { db: '11686L.doc',       file: '11686L.doc', dir: '_FAILED' },
  { db: '13225-1a__1.doc',  file: '13225-1a.doc' },
  { db: '13225-L3__1.doc',  file: '13225-L3.doc' },
  { db: '14200L-B__1.doc',  file: '14200L-B.doc' },
  { db: '12820L__1.doc',    file: '12820L.doc' },
];

// ── Auth ─────────────────────────────────────────────────────────────────────
let authToken = null;
async function authenticate() {
  for (const ep of [`${BASE_URL}/api/auth/login`, `${BASE_URL}/api/auth/register`]) {
    try {
      const r = await fetch(ep, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'cli_tester', password: 'CliPassword123!' }),
      });
      const j = await r.json();
      if (j.token) { authToken = j.token; console.log('✓ Authenticated'); return; }
    } catch {}
  }
  throw new Error('Auth failed');
}

// ── Switch to gemma3:4b for speed ────────────────────────────────────────────
async function switchModel() {
  try {
    const r = await fetch(`${BASE_URL}/api/settings/model-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ provider: 'ollama', model: 'gemma3:4b' }),
    });
    if (r.ok) console.log('✓ Switched to gemma3:4b');
    else console.warn('⚠ Could not switch model — using current provider');
  } catch (e) {
    console.warn('⚠ Model switch failed:', e.message);
  }
}

// ── Process single file ───────────────────────────────────────────────────────
async function processFile(target, index) {
  const dir      = target.dir ? path.join(BASE_DIR, target.dir) : BASE_DIR;
  const filePath = path.join(dir, target.file);

  if (!fs.existsSync(filePath)) {
    console.log(`[${String(index).padStart(2,'0')}/20] ✗ ${target.db.padEnd(28)} MISSING  ${filePath}`);
    return { file: target.db, status: 'MISSING', error: `Not found: ${filePath}` };
  }

  // Endpoint: POST /api/folderscan/process-file?path=<folder>&file=<filename>
  const url = new URL(`${BASE_URL}/api/folderscan/process-file`);
  url.searchParams.set('path', dir);
  url.searchParams.set('file', target.file);
  url.searchParams.set('units', 'Feet');
  url.searchParams.set('autoOutput', 'true');

  const start = Date.now();
  try {
    const r = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      signal: AbortSignal.timeout(600000), // 10 min max per file
    });
    const txt = await r.text();
    if (!r.ok) {
      console.log(`[${String(index).padStart(2,'0')}/20] ✗ ${target.db.padEnd(28)} ERROR    ${txt.slice(0, 120)}`);
      return { file: target.db, status: 'ERROR', error: txt.slice(0, 200) };
    }
    // Response is newline-delimited JSON (streaming) — take last valid JSON line
    const lines = txt.trim().split('\n').filter(Boolean);
    let data = {};
    for (const line of lines.reverse()) {
      try { data = JSON.parse(line); break; } catch {}
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const result  = data.result || data;
    const status  = result.status || data.status || 'UNKNOWN';
    const err     = result.linearError ?? data.linearError ?? null;
    const icon    = status === 'PASS' ? '✓' : status === 'MEANDER' ? '〰' : '✗';
    const errStr  = err != null ? `  err=${parseFloat(err).toFixed(3)}ft` : '';
    const stage   = result.repairStageUsed ? `  [${result.repairStageUsed}]` : '';
    console.log(`[${String(index).padStart(2,'0')}/20] ${icon} ${target.db.padEnd(28)} ${status.padEnd(8)}${errStr}${stage}  (${elapsed}s)`);
    return { file: target.db, status, linearError: err, elapsed, repairStage: result.repairStageUsed };
  } catch (ex) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[${String(index).padStart(2,'0')}/20] ✗ ${target.db.padEnd(28)} ERROR    ${ex.message.slice(0,60)}  (${elapsed}s)`);
    return { file: target.db, status: 'ERROR', error: ex.message, elapsed };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const runStart = Date.now();
  console.log('\n' + '═'.repeat(70));
  console.log('  Boundary.IQ — Targeted 20-Failure Repair Run');
  console.log('  Model: gemma3:4b  ·  Files: 20 DB-confirmed failures');
  console.log('═'.repeat(70));

  await authenticate();
  await switchModel();

  console.log(`\nProcessing ${TARGETS.length} deeds sequentially...\n`);

  const results = [];
  for (let i = 0; i < TARGETS.length; i++) {
    results.push(await processFile(TARGETS[i], i + 1));
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const totalSec = ((Date.now() - runStart) / 1000).toFixed(0);
  const pass     = results.filter(r => r.status === 'PASS').length;
  const meander  = results.filter(r => r.status === 'MEANDER').length;
  const fail     = results.filter(r => r.status === 'FAIL').length;
  const error    = results.filter(r => r.status === 'ERROR' || r.status === 'MISSING').length;
  const resolved = pass + meander;

  console.log('\n' + '═'.repeat(70));
  console.log('  RESULTS SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  Total processed : ${results.length} / 20`);
  console.log(`  ✓  PASS         : ${pass}`);
  console.log(`  〰  MEANDER      : ${meander}`);
  console.log(`  ✗  FAIL         : ${fail}`);
  console.log(`  ⚠  ERROR/MISSING: ${error}`);
  console.log(`  ──────────────────────────`);
  console.log(`  Resolved (P+M)  : ${resolved} / 20  (${Math.round(resolved/20*100)}%)`);
  console.log(`  Total time      : ${totalSec}s`);

  if (fail > 0 || error > 0) {
    console.log('\n  Still failing:');
    results.filter(r => ['FAIL','ERROR','MISSING'].includes(r.status))
           .forEach(r => console.log(`    ✗ ${r.file}  [${r.status}]  ${r.linearError ? `err=${parseFloat(r.linearError).toFixed(1)}ft` : r.error || ''}`));
  }
  console.log('═'.repeat(70) + '\n');
})();
