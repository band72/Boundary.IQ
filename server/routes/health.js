// ─── Health Route ─────────────────────────────────────────────────────────────
// GET /api/health         — liveness probe (Cloud Run / Fly.io / Render)
// GET /api/health/ready   — readiness probe (checks AI provider is configured)
//
// Cloud Run polls /api/health every 30 s to determine container health.
// A non-2xx response causes the container to be restarted.

import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GEMINI_API_KEY, ACTIVE_PROVIDER, ACTIVE_MODEL, NODE_ENV } from '../config.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const execAsync = promisify(exec);
const router = Router();
const startTime = Date.now();

async function checkBinary(binaryName) {
  try {
    await execAsync(`which ${binaryName}`);
    return true;
  } catch {
    return false;
  }
}

// ── GET /api/health — lightweight liveness probe ──────────────────────────────
router.get('/', (req, res) => {
  res.json({
    status:  'ok',
    service: 'Boundary.IQ API',
    version: '2.0.0-node',
    env:     NODE_ENV,
    uptime:  Math.floor((Date.now() - startTime) / 1000) + 's',
    utc:     new Date().toISOString(),
  });
});

// ── GET /api/health/ready — readiness probe (checks AI provider config) ────────
router.get('/ready', asyncHandler(async (req, res) => {
  const [libreofficeInstalled, python3Installed, pdftoppmInstalled] = await Promise.all([
    checkBinary('libreoffice'),
    checkBinary('python3'),
    checkBinary('pdftoppm'),
  ]);

  const checks = {
    gemini_key:  !!GEMINI_API_KEY,
    provider:    ACTIVE_PROVIDER || 'ollama',
    model:       ACTIVE_MODEL    || '(default)',
    libreoffice: libreofficeInstalled,
    python3:     python3Installed,
    pdftoppm:    pdftoppmInstalled,
  };

  const ready = ACTIVE_PROVIDER !== 'gemini' || checks.gemini_key;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    utc: new Date().toISOString(),
  });
}));

export default router;
