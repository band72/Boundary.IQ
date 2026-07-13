#!/usr/bin/env node
// ─── Consecutive Local Model Batch Runner ──────────────────────────────────────
// Runs batchHeadless.js sequentially for each local model:
//   gemma3:4b, llama3.2:3b, deepseek-r1:8b, deepseek-r1:14b, gemma4:26b
//
// Usage:
//   node server/scripts/runConsecutiveBatches.js [--limit=N] [--offset=N] [--fail-only]

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BATCH_SCRIPT = path.join(__dirname, 'batchHeadless.js');

const MODELS = [
  'gemma3:4b',
  'llama3.2:3b',
  'deepseek-r1:8b',
  'deepseek-r1:14b',
  'gemma4:26b'
];

// Capture and forward all command-line args (limit, offset, etc.)
const forwardedArgs = process.argv.slice(2).filter(arg => !arg.startsWith('--model='));

function runBatchForModel(model) {
  return new Promise((resolve, reject) => {
    console.log(`\n======================================================================`);
    console.log(`🚀 STARTING BATCH RUN FOR MODEL: ${model}`);
    console.log(`======================================================================\n`);

    const args = [BATCH_SCRIPT, `--model=${model}`, '--use-ai', ...forwardedArgs];
    const child = spawn('node', args, {
      stdio: 'inherit'
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`\n✅ COMPLETED BATCH RUN FOR MODEL: ${model}\n`);
        resolve();
      } else {
        console.error(`\n❌ BATCH RUN FAILED FOR MODEL ${model} WITH EXIT CODE ${code}\n`);
        resolve(); // Continue to next model even if one fails
      }
    });

    child.on('error', (err) => {
      console.error(`\n❌ FAILED TO LAUNCH BATCH RUN FOR MODEL ${model}: ${err.message}\n`);
      resolve();
    });
  });
}

async function main() {
  const startTime = Date.now();
  console.log(`📋 Starting consecutive batch runs across ${MODELS.length} models...`);
  console.log(`   Forwarded args: ${forwardedArgs.join(' ') || '(none)'}`);

  for (const model of MODELS) {
    await runBatchForModel(model);
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n======================================================================`);
  console.log(`🎉 ALL CONSECUTIVE BATCH RUNS COMPLETE!`);
  console.log(`   Total Duration: ${duration} minutes`);
  console.log(`======================================================================\n`);
}

main().catch(err => {
  console.error('Fatal error in runner:', err);
  process.exit(1);
});
