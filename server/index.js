// ─── Boundary.IQ API — Node.js Entry Point ──────────────────────────────────
// Drop-in replacement for the ASP.NET Core 8 backend.
// Same API routes, same JSON shapes, same behavior.

import 'dotenv/config';
import dotenv from 'dotenv'; // kept for hot-reload: dotenv.config({ override: true })
import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'fs';
import path from 'path';

// ── Config & Logger ───────────────────────────────────────────────────────────
import {
  PORT, GEMINI_API_KEY, ACTIVE_PROVIDER, ACTIVE_MODEL,
  OLLAMA_PATH, OLLAMA_RUNS_ON_WSL,
  ALLOWED_ORIGINS, SERVER_TIMEOUT_MS, IS_PROD,
} from './config.js';
import logger from './logger.js';

// Configure global undici dispatcher to support 30-minute timeout for native
// fetch (e.g. Ollama calls). Must be set before any fetch is made.
setGlobalDispatcher(new Agent({
  connectTimeout: SERVER_TIMEOUT_MS,
  headersTimeout: SERVER_TIMEOUT_MS,
  bodyTimeout: SERVER_TIMEOUT_MS,
}));

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { spawn } from 'child_process';

// ── Services ──────────────────────────────────────────────────────────────────
import * as gemini from './services/geminiVision.js';
import * as diagnosticsDb from './services/diagnosticsDb.js';
import * as ollamaSvc from './services/ollamaVision.js';

// ── Route modules ─────────────────────────────────────────────────────────────
import healthRouter from './routes/health.js';
import traverseRouter from './routes/traverse.js';
import writerRouter from './routes/writer.js';
import platRouter from './routes/plat.js';
import dxfRouter from './routes/dxf.js';
import diagnosticsRouter from './routes/diagnostics.js';
import batchDeedRouter from './routes/batchDeed.js';
import folderScanRouter from './routes/folderScan.js';
import settingsRouter from './routes/settings.js';
import deedRouter from './routes/deed.js';
import authRouter from './routes/auth.js';
import billingRouter from './routes/billing.js';

const app = express();

// ── Global crash guards ───────────────────────────────────────────────────────
// Prevent unhandled promise rejections from silently crashing the process.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '⚠ Unhandled promise rejection — this is a bug');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '✗ Uncaught exception — shutting down');
  process.exit(1);
});

// ── Initialize Gemini API key ─────────────────────────────────────────────────
if (GEMINI_API_KEY) {
  gemini.init(GEMINI_API_KEY);
  logger.info('✓ Gemini API key loaded.');
} else {
  logger.warn('⚠ GEMINI_API_KEY not found — Gemini extraction will fail. Use Ollama for local inference.');
}

// ── Watch .env file for changes (Hot Reload) ──────────────────────────────────
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  let watchTimeout = null;
  fs.watch(envPath, (eventType) => {
    if (eventType === 'change') {
      if (watchTimeout) clearTimeout(watchTimeout);
      watchTimeout = setTimeout(() => {
        logger.info('⚡ .env change detected — reloading system configurations...');
        const configOutput = dotenv.config({ override: true });
        if (configOutput.error) {
          logger.error({ err: configOutput.error }, '✗ Failed to reload .env');
          return;
        }

        // Re-read keys directly from process.env (config.js exports are resolved at load time)
        const reloadedApiKey = process.env.GEMINI_API_KEY || process.env['Gemini__ApiKey'];
        if (reloadedApiKey) {
          gemini.init(reloadedApiKey);
          logger.info('✓ Gemini API key reloaded.');
        }

        const reloadedProvider = process.env.ACTIVE_PROVIDER || 'ollama';
        const reloadedModel = process.env.ACTIVE_MODEL;
        try {
          gemini.setProvider(reloadedProvider, reloadedModel);
          logger.info(`🔄 Provider hot-switched to: ${reloadedProvider} / ${reloadedModel}`);
        } catch (err) {
          logger.warn({ err }, '⚠️ Hot-swap provider switch failed');
        }
      }, 500);
    }
  });
}

// ── Initialize SQLite database ────────────────────────────────────────────────
try {
  diagnosticsDb.init();
  logger.info('✓ Diagnostics database initialized.');
  // Purge stale sessions on startup, then every 24 hours
  diagnosticsDb.purgeExpiredSessions();
  setInterval(() => diagnosticsDb.purgeExpiredSessions(), 24 * 60 * 60 * 1000);
} catch (ex) {
  logger.error({ err: ex }, '✗ Failed to initialize diagnostics database');
}

// ── Middleware ────────────────────────────────────────────────────────────────

// Helmet: adds ~12 security headers
app.use(helmet({
  contentSecurityPolicy: false, // disabled: React SPA needs inline scripts from Vite
  crossOriginEmbedderPolicy: false, // disabled: canvas/DXF exports need cross-origin fetch
}));

// Auth rate limiter: 100 attempts per IP per 15 min (skipped outside production)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !IS_PROD,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/google-login', authLimiter);

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Raw body for Stripe webhook signature verification (must come before json parser)
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging (skip /api/health to reduce noise)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path !== '/api/health') {
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms });
    }
  });
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/health', healthRouter);
app.use('/api/traverse', traverseRouter);
app.use('/api/writer', writerRouter);
app.use('/api/plat', platRouter);
app.use('/api/dxf', dxfRouter);
app.use('/api/diagnostics', diagnosticsRouter);
app.use('/api/batchdeed', batchDeedRouter);
app.use('/api/folderscan', folderScanRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/deed', deedRouter);
app.use('/api/auth', authRouter);
app.use('/api/billing', billingRouter);

// ── Global error handler ──────────────────────────────────────────────────────
// Catches errors forwarded by asyncHandler(fn) and any synchronous throws.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled route error');
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  logger.info(`\n🌐 Boundary.IQ API (Node.js) listening on http://localhost:${PORT}`);
  logger.info(`   Health check:  http://localhost:${PORT}/api/health`);
  logger.info(`   Diagnostics:   http://localhost:${PORT}/api/diagnostics/stats`);
  logger.info(`   Deed Solver:   http://localhost:${PORT}/api/deed/models (local LLM endpoint)\n`);

  // ── Auto-start Ollama if not running ──────────────────────────────────────
  try {
    const ollamaStatus = await ollamaSvc.getStatus();
    if (ollamaStatus.online) {
      logger.info(`✓ Ollama online — ${ollamaStatus.models.length} model(s): ${ollamaStatus.models.join(', ')}`);
    } else {
      logger.info('⏳ Ollama offline — attempting auto-start (ollama serve)…');
      const ollamaExe = OLLAMA_PATH;
      let cmd = ollamaExe;
      let args = ['serve'];
      if (
        process.platform === 'win32' &&
        (ollamaExe.startsWith('/') || ollamaExe.includes('wsl') || OLLAMA_RUNS_ON_WSL)
      ) {
        cmd = 'wsl';
        args = [ollamaExe === 'ollama' ? 'ollama' : ollamaExe, 'serve'];
      }
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        logger.warn({ err }, 'Ollama spawn failed');
      });
      child.unref();

      // Poll for up to 10s
      let waited = 0;
      const pollInterval = setInterval(async () => {
        waited += 2000;
        const s = await ollamaSvc.getStatus();
        if (s.online) {
          clearInterval(pollInterval);
          logger.info(`✓ Ollama auto-started — ${s.models.length} model(s): ${s.models.join(', ')}`);
        } else if (waited >= 10000) {
          clearInterval(pollInterval);
          logger.warn('⚠ Ollama did not respond after 10s. Start manually with: ollama serve');
        }
      }, 2000);
    }
  } catch (ex) {
    logger.warn({ err: ex }, '⚠ Ollama auto-start check failed');
  }
});

// Configure server timeouts to 30 minutes to support local CPU LLM inference
server.timeout = SERVER_TIMEOUT_MS;
server.requestTimeout = SERVER_TIMEOUT_MS;
server.keepAliveTimeout = SERVER_TIMEOUT_MS;
server.headersTimeout = SERVER_TIMEOUT_MS + 5000;
