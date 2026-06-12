// ─── Boundary.IQ API — Node.js Entry Point ──────────────────────────────────
// Drop-in replacement for the ASP.NET Core 8 backend.
// Same API routes, same JSON shapes, same behavior. (restarted)

import 'dotenv/config';
import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv'; // kept for hot-reload: dotenv.config({ override: true })

// Configure global undici dispatcher to support 30 minutes timeout for native fetch (e.g. Ollama calls)
setGlobalDispatcher(new Agent({
  connectTimeout: 1800000,
  headersTimeout: 1800000,
  bodyTimeout: 1800000
}));

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// Initialize services
import * as gemini from './services/geminiVision.js';
import * as diagnosticsDb from './services/diagnosticsDb.js';
import * as ollamaSvc from './services/ollamaVision.js';
import { spawn } from 'child_process';

// Route modules
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

const app = express();
const PORT = parseInt(process.env.PORT || '5050');

// ── Strip quoted values from env vars (common .env issue) ────────────────────
function getEnv(key) {
  let val = process.env[key];
  if (val && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  if (val && val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
  return val;
}

// ── Initialize Gemini API key ───────────────────────────────────────────────
const apiKey = getEnv('GEMINI_API_KEY') || getEnv('Gemini__ApiKey');
if (apiKey) {
  gemini.init(apiKey);
  console.log('✓ Gemini API key loaded.');
} else {
  console.warn('⚠ GEMINI_API_KEY not found — Gemini extraction will fail. Use Ollama for local inference.');
}

// ── Watch .env file for changes (Hot Reload) ─────────────────────────────────
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  let watchTimeout = null;
  fs.watch(envPath, (eventType) => {
    if (eventType === 'change') {
      if (watchTimeout) clearTimeout(watchTimeout);
      watchTimeout = setTimeout(() => {
        console.log('⚡ .env file change detected. Reloading system configurations...');
        const configOutput = dotenv.config({ override: true });
        if (configOutput.error) {
          console.error('✗ Failed to reload .env:', configOutput.error.message);
          return;
        }

        const reloadedApiKey = getEnv('GEMINI_API_KEY') || getEnv('Gemini__ApiKey');
        if (reloadedApiKey) {
          gemini.init(reloadedApiKey);
          console.log('✓ Gemini API key reloaded.');
        }

        const reloadedProvider = getEnv('ACTIVE_PROVIDER') || 'ollama';
        const reloadedModel = getEnv('ACTIVE_MODEL');
        try {
          gemini.setProvider(reloadedProvider, reloadedModel);
          console.log(`🔄 System configurations hot-switched to: ${reloadedProvider} / ${reloadedModel}`);
        } catch (err) {
          console.warn('⚠️ Hot-swap provider switch failed:', err.message);
        }
      }, 500);
    }
  });
}

// ── Initialize SQLite database ──────────────────────────────────────────────
try {
  diagnosticsDb.init();
  console.log('✓ Diagnostics database initialized.');
  // Purge stale sessions on startup, then every 24 hours
  diagnosticsDb.purgeExpiredSessions();
  setInterval(() => diagnosticsDb.purgeExpiredSessions(), 24 * 60 * 60 * 1000);
} catch (ex) {
  console.error('✗ Failed to initialize diagnostics database:', ex.message);
}

// ── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(';').filter(Boolean).map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'];

// ── Security middleware ──────────────────────────────────────────────────────
// Helmet adds ~12 security headers (CSP, X-Frame-Options, HSTS, etc.)
app.use(helmet({
  contentSecurityPolicy: false, // disabled: React SPA needs inline scripts from Vite
  crossOriginEmbedderPolicy: false, // disabled: canvas/DXF exports need cross-origin fetch
}));

// Rate limit: auth endpoints only — 10 attempts per IP per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development' && req.ip === '::1', // skip localhost in dev
});
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/google-login', authLimiter);

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path !== '/api/health') {
      console.log(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

// ── Routes ──────────────────────────────────────────────────────────────────
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

// ── Error handling ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  console.log(`\n🌐 Boundary.IQ API (Node.js) listening on http://localhost:${PORT}`);
  console.log(`   Health check:  http://localhost:${PORT}/api/health`);
  console.log(`   Diagnostics:   http://localhost:${PORT}/api/diagnostics/stats`);
  console.log(`   Deed Solver:   http://localhost:${PORT}/api/deed/models (local LLM endpoint)\n`);

  // ── Auto-start Ollama if not running ─────────────────────────────────────
  try {
    const ollamaStatus = await ollamaSvc.getStatus();
    if (ollamaStatus.online) {
      console.log(`✓ Ollama online — ${ollamaStatus.models.length} model(s): ${ollamaStatus.models.join(', ')}`);
    } else {
      console.log('⏳ Ollama offline — attempting auto-start (ollama serve)…');
      const ollamaPath = process.env.OLLAMA_PATH || 'ollama';
      const child = spawn(ollamaPath, ['serve'], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        // Handle spawn errors (like ENOENT) gracefully without crashing
      });
      child.unref();
      // Poll for up to 10s
      let waited = 0;
      const pollInterval = setInterval(async () => {
        waited += 2000;
        const s = await ollamaSvc.getStatus();
        if (s.online) {
          clearInterval(pollInterval);
          console.log(`✓ Ollama auto-started — ${s.models.length} model(s): ${s.models.join(', ')}`);
        } else if (waited >= 10000) {
          clearInterval(pollInterval);
          console.warn('⚠ Ollama did not respond after 10s. Start manually with: ollama serve');
        }
      }, 2000);
    }
  } catch (ex) {
    console.warn('⚠ Ollama auto-start check failed:', ex.message);
  }
});

// Configure server timeouts to 30 minutes to support local CPU LLM inference
server.timeout = 1800000;
server.requestTimeout = 1800000;
server.keepAliveTimeout = 1800000;
server.headersTimeout = 1805000;
