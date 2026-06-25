// ─── Health Route ─────────────────────────────────────────────────────────────
// GET /api/health         — liveness probe (Cloud Run / Fly.io / Render)
// GET /api/health/ready   — readiness probe (checks AI provider is configured)
//
// Cloud Run polls /api/health every 30 s to determine container health.
// A non-2xx response causes the container to be restarted.

import { Router } from 'express';
import { GEMINI_API_KEY, ACTIVE_PROVIDER, ACTIVE_MODEL, NODE_ENV } from '../config.js';

const router = Router();
const startTime = Date.now();

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
router.get('/ready', (req, res) => {
  const checks = {
    gemini_key: !!GEMINI_API_KEY,
    provider:   ACTIVE_PROVIDER || 'ollama',
    model:      ACTIVE_MODEL    || '(default)',
  };

  const ready = ACTIVE_PROVIDER !== 'gemini' || checks.gemini_key;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    utc: new Date().toISOString(),
  });
});

export default router;
