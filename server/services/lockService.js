// Global processing lock service
// Ollama is single-threaded. Concurrent batch requests each queue 20+ LLM calls
// that all block for up to 30 min. This lock ensures only ONE batch or retry run
// is active at a time, returning 503 immediately if already busy.

let _processingLock = false;
let _processingInfo = null; // { type, path, startTime }

export function acquire(type, path) {
  if (_processingLock) return false;
  _processingLock = true;
  _processingInfo = {
    type,
    path,
    startTime: Date.now()
  };
  return true;
}

export function release() {
  _processingLock = false;
  _processingInfo = null;
}

export function status() {
  if (_processingLock && _processingInfo) {
    const elapsedSec = Math.round((Date.now() - _processingInfo.startTime) / 1000);
    return {
      busy: true,
      type: _processingInfo.type,
      path: _processingInfo.path,
      elapsedSec
    };
  }
  return { busy: false };
}

export function reset() {
  const wasLocked = _processingLock;
  const previousInfo = _processingInfo;
  release();
  return { wasLocked, previousInfo };
}

// ── Per-user locks ────────────────────────────────────────────────────────────
// Allows multiple users to run batches concurrently while preventing a single
// user from submitting two batches at the same time.

const _userLocks = new Map(); // userId (string) → { startTime: number }

/**
 * Attempt to acquire a per-user batch lock.
 * @param {string|number} userId
 * @returns {boolean} true if lock was acquired, false if user already has one active.
 */
export function acquirePerUser(userId) {
  const key = String(userId);
  if (_userLocks.has(key)) return false;
  _userLocks.set(key, { startTime: Date.now() });
  return true;
}

/**
 * Release the per-user batch lock.
 * @param {string|number} userId
 */
export function releasePerUser(userId) {
  _userLocks.delete(String(userId));
}

/**
 * Return elapsed seconds for a user's active batch, or null if not active.
 * @param {string|number} userId
 */
export function statusPerUser(userId) {
  const info = _userLocks.get(String(userId));
  if (!info) return null;
  return Math.round((Date.now() - info.startTime) / 1000);
}

export class FifoSemaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }
}

