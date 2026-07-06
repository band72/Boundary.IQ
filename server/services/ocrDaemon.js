/**
 * ocrDaemon.js — Persistent EasyOCR child process manager
 *
 * The ocr_pdf.py script is kept alive as a single child process for the entire
 * Node server lifetime. Jobs are submitted as newline-delimited JSON over stdin
 * and results are read from stdout the same way. This eliminates the ~100 MB
 * EasyOCR model cold-start on every document call.
 *
 * Usage:
 *   import { ocrFile } from './ocrDaemon.js';
 *   const text = await ocrFile('/abs/path/to/file.pdf');
 *
 * Error handling:
 *   - The daemon prints { "status": "ready" } once on startup.
 *   - Jobs time out after OCR_DAEMON_TIMEOUT_MS (default 120 s).
 *   - If the process crashes, it is respawned transparently on the next call
 *     (up to 3 attempts).
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('ocrDaemon');
const execAsync = promisify(exec);

let _ocrSupported = null; // null = untested, true = available, false = unavailable

export async function checkOcrSupport() {
  if (_ocrSupported !== null) return _ocrSupported;
  try {
    // Fast import check to see if easyocr package is available
    await execAsync('python3 -c "import easyocr"', { timeout: 10000 });
    _ocrSupported = true;
    log.info('EasyOCR is available in the Python environment.');
  } catch (err) {
    _ocrSupported = false;
    log.info('EasyOCR is not available in the Python environment. Local OCR fallback is bypassed.');
  }
  return _ocrSupported;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '../scripts/ocr_pdf.py');
const TIMEOUT_MS = parseInt(process.env.OCR_DAEMON_TIMEOUT_MS || '120000', 10);
const MAX_PAGES  = parseInt(process.env.OCR_DAEMON_MAX_PAGES || '10', 10);

// ── Daemon state ─────────────────────────────────────────────────────────────

let _proc    = null;   // child_process.ChildProcess
let _ready   = false;  // true once the daemon printed {"status":"ready"}
let _buffer  = '';     // incomplete line buffer for stdout
const _pending = new Map(); // jobId → { resolve, reject, timer }
let _startPromise = null; // in-flight boot promise

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function _startDaemon() {
  if (_startPromise) return _startPromise;
  _startPromise = new Promise((resolve, reject) => {
    log.info({ script: SCRIPT_PATH }, 'Spawning OCR daemon');
    _proc = spawn('python3', [SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    _proc.stdout.setEncoding('utf-8');
    _proc.stdout.on('data', (chunk) => {
      _buffer += chunk;
      const lines = _buffer.split('\n');
      _buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        _handleLine(trimmed, resolve, reject);
      }
    });

    _proc.stderr.setEncoding('utf-8');
    _proc.stderr.on('data', (data) => {
      log.warn({ stderr: data.trim() }, 'OCR daemon stderr');
    });

    _proc.on('exit', (code, signal) => {
      log.warn({ code, signal }, 'OCR daemon exited');
      _proc = null;
      _ready = false;
      _startPromise = null;
      // Reject all pending jobs
      for (const [id, { reject: rej, timer }] of _pending) {
        clearTimeout(timer);
        rej(new Error(`OCR daemon exited with code ${code}`));
      }
      _pending.clear();
    });

    _proc.on('error', (err) => {
      log.error({ err: err.message }, 'OCR daemon spawn error');
      _proc = null;
      _ready = false;
      _startPromise = null;
      reject(err);
    });
  });
  return _startPromise;
}

function _handleLine(line, readyResolve, readyReject) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log.warn({ line }, 'Unparseable line from OCR daemon');
    return;
  }

  // Startup acknowledgement
  if (msg.status === 'ready') {
    _ready = true;
    log.info('OCR daemon is ready');
    if (readyResolve) readyResolve();
    return;
  }

  // Job result
  const { id, text, error } = msg;
  const pending = _pending.get(id);
  if (!pending) {
    log.warn({ id }, 'No pending job found for OCR result');
    return;
  }
  clearTimeout(pending.timer);
  _pending.delete(id);
  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(text || '');
  }
}

async function _ensureReady() {
  if (_proc && _ready) return;
  await _startDaemon();
  // Wait for ready signal (already resolved inside _startDaemon)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run OCR on an absolute file path using the persistent daemon.
 * Falls back to spawning a one-shot process if the daemon is unavailable
 * after 3 start attempts.
 *
 * @param {string} filePath  Absolute path to a PDF or image file
 * @param {object} [opts]
 * @param {number} [opts.maxPages]   Override max pages for pdftoppm (default: OCR_DAEMON_MAX_PAGES env or 10)
 * @returns {Promise<string>}  Extracted text
 */
export async function ocrFile(filePath, opts = {}) {
  const isSupported = await checkOcrSupport();
  if (!isSupported) {
    log.debug('Bypassing local OCR daemon because EasyOCR is not available');
    return '';
  }

  const maxPages = opts.maxPages ?? MAX_PAGES;
  const id = crypto.randomUUID();

  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      await _ensureReady();
      break;
    } catch (err) {
      log.warn({ attempt: attempts, err: err.message }, 'OCR daemon start failed, retrying');
      if (attempts >= 3) throw new Error(`OCR daemon failed to start after 3 attempts: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500 * attempts));
    }
  }

  return new Promise((resolve, reject) => {
    const job = JSON.stringify({ id, path: filePath, maxPages }) + '\n';

    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`OCR daemon job timed out after ${TIMEOUT_MS}ms for ${filePath}`));
    }, TIMEOUT_MS);

    _pending.set(id, { resolve, reject, timer });

    try {
      _proc.stdin.write(job);
    } catch (writeErr) {
      clearTimeout(timer);
      _pending.delete(id);
      reject(writeErr);
    }
  });
}

/**
 * Gracefully shut down the daemon (call on process exit).
 */
export function shutdownDaemon() {
  if (_proc) {
    try {
      _proc.stdin.write(JSON.stringify({ exit: true }) + '\n');
    } catch {}
    setTimeout(() => {
      if (_proc) {
        _proc.kill('SIGTERM');
        _proc = null;
      }
    }, 2000);
  }
}

// Auto-shutdown on process exit
process.on('exit', shutdownDaemon);
process.on('SIGINT',  () => { shutdownDaemon(); process.exit(0); });
process.on('SIGTERM', () => { shutdownDaemon(); process.exit(0); });
