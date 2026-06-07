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

