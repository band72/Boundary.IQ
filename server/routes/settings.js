// ─── Settings Route ─────────────────────────────────────────────────────────
// Runtime model/provider switching + Ollama status probe.
import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import * as gemini from '../services/geminiVision.js';
import * as ollamaSvc from '../services/ollamaVision.js';
import * as dbSvc from '../services/diagnosticsDb.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('settings');
const router = Router();

// ── Auth: all settings routes require a valid session ────────────────────────
router.use(requireAuth);

let ollamaSpawnPending = false;

// ── GET /api/settings/model — current provider & available options ────────────
// Any authenticated user can READ the current model (needed to render the settings UI).
router.get('/model', asyncHandler(async (req, res) => {
  const ollamaStatus = await ollamaSvc.getStatus();
  const openAiBaseUrl = gemini.getOpenAiBaseUrl();
  const openAiStatus = await ollamaSvc.getStatusOpenAI(openAiBaseUrl);

  const geminiModels = [
    { id: 'gemini-3.5-flash',       name: 'Gemini 3.5 Flash',       provider: 'gemini', description: 'Fast, cost-effective multimodal model' },
    { id: 'gemini-3.5-pro',         name: 'Gemini 3.5 Pro',         provider: 'gemini', description: 'Flagship high-capability reasoning model' },
    { id: 'gemini-3.1-pro',         name: 'Gemini 3.1 Pro',         provider: 'gemini', description: 'Production-grade high-capability reasoning model' },
    { id: 'gemini-3.1-flash-lite',  name: 'Gemini 3.1 Flash-Lite',  provider: 'gemini', description: 'Ultra-fast, light multimodal model' },
    { id: 'gemini-2.5-flash',       name: 'Gemini 2.5 Flash',       provider: 'gemini', description: 'Previous generation Flash' },
    { id: 'gemini-2.5-pro',         name: 'Gemini 2.5 Pro',         provider: 'gemini', description: 'High-capability reasoning model' },
  ];

  const ollamaModels = ollamaStatus.models.map(m => ({
    id: m,
    name: m.split(':')[0].charAt(0).toUpperCase() + m.split(':')[0].slice(1) + (m.includes(':') ? ` (${m.split(':')[1]})` : ''),
    provider: 'ollama',
    description: 'Local model via Ollama',
  }));

  // OpenAI-compat models — exclude any already in Ollama list to avoid duplicates
  const ollamaIds = new Set(ollamaStatus.models);
  const openAiModels = openAiStatus.models
    .filter(m => !ollamaIds.has(m))
    .map(m => ({
      id: m,
      name: m.split(':')[0].charAt(0).toUpperCase() + m.split(':')[0].slice(1) + (m.includes(':') ? ` (${m.split(':')[1]})` : ''),
      provider: 'openai',
      description: 'OpenAI-compatible local endpoint',
    }));

  res.json({
    activeProvider: gemini.getActiveProvider(),
    activeModel: gemini.getActiveModel(),
    allowApiFallback: process.env.ALLOW_API_FALLBACK !== 'false',
    enforceNoSelfIntersection: process.env.ENFORCE_NO_SELF_INTERSECTION === 'true',
    ollama: {
      online: ollamaStatus.online,
      url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
      error: ollamaStatus.error || null,
      modelCount: ollamaStatus.models.length,
    },
    openaiCompat: {
      online: openAiStatus.online,
      url: openAiBaseUrl,
      error: openAiStatus.error || null,
      modelCount: openAiStatus.models.length,
    },
    gemini: {
      configured: !!gemini.getActiveProvider(),
    },
    availableModels: [...geminiModels, ...ollamaModels, ...openAiModels],
  });
}));

// ── POST /api/settings/model — switch active provider & model (admin only) ────
router.post('/model', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { provider, model, openaiBaseUrl, allowApiFallback, enforceNoSelfIntersection } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider is required.' });

  gemini.setProvider(provider, model, openaiBaseUrl || undefined);

  if (allowApiFallback !== undefined) {
    process.env.ALLOW_API_FALLBACK = allowApiFallback ? 'true' : 'false';
  }

  if (enforceNoSelfIntersection !== undefined) {
    process.env.ENFORCE_NO_SELF_INTERSECTION = enforceNoSelfIntersection ? 'true' : 'false';
  }

  saveSystemSettingsToEnv(undefined, undefined, provider, model || undefined, allowApiFallback, enforceNoSelfIntersection);
  log.info({ provider, model, actor: req.user?.username }, 'AI provider switched');

  res.json({
    message: `Switched to ${provider}/${model || '(default)'}`,
    activeProvider: gemini.getActiveProvider(),
    activeModel: gemini.getActiveModel(),
    allowApiFallback: process.env.ALLOW_API_FALLBACK !== 'false',
    enforceNoSelfIntersection: process.env.ENFORCE_NO_SELF_INTERSECTION === 'true',
  });
}));

// ── GET /api/settings/ollama/status — detailed Ollama health check ────────────
router.get('/ollama/status', asyncHandler(async (req, res) => {
  const status = await ollamaSvc.getStatus();
  res.json(status);
}));

// ── POST /api/settings/ollama/start — launch `ollama serve` (admin only) ──────
router.post('/ollama/start', requireRole(['admin']), asyncHandler(async (req, res) => {
  // Check if already online
  const current = await ollamaSvc.getStatus();
  if (current.online) {
    return res.json({ started: false, message: 'Ollama is already running.', models: current.models });
  }

  if (ollamaSpawnPending) {
    return res.json({ started: false, message: 'Ollama startup already in progress. Please wait a moment then refresh.' });
  }

  ollamaSpawnPending = true;
  const ollamaPath = process.env.OLLAMA_PATH || 'ollama';

  // On Windows: if ollamaPath looks like a WSL path, wrap with `wsl`
  let cmd = ollamaPath;
  let args = ['serve'];
  if (
    process.platform === 'win32' &&
    (ollamaPath.startsWith('/') || ollamaPath.includes('wsl') || process.env.OLLAMA_RUNS_ON_WSL === 'true')
  ) {
    cmd = 'wsl';
    args = [ollamaPath === 'ollama' ? 'ollama' : ollamaPath, 'serve'];
  }

  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    // Spawn failed (e.g. `ollama` not on PATH) — log and clear pending flag
    log.warn({ err: err.message, cmd }, 'Ollama spawn failed');
    ollamaSpawnPending = false;
  });
  child.unref(); // Let node exit without waiting for this process

  // Wait 2.5 s then verify it came up
  await new Promise(r => setTimeout(r, 2500));
  const status = await ollamaSvc.getStatus();
  ollamaSpawnPending = false;

  if (status.online) {
    log.info({ modelCount: status.models.length }, 'Ollama auto-started via settings');
    return res.json({ started: true, message: `Ollama started. ${status.models.length} model(s) available.`, models: status.models });
  } else {
    return res.json({ started: false, message: 'Ollama spawn attempted but server did not respond yet. Wait a few seconds and refresh.', error: status.error });
  }
}));

// ── POST /api/settings/keys — update API keys in memory (admin only) ──────────
router.post('/keys', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { geminiApiKey, openAiApiKey } = req.body;
  if (geminiApiKey) {
    gemini.init(geminiApiKey);
    process.env.GEMINI_API_KEY = geminiApiKey;
    log.info({ actor: req.user?.username }, 'Gemini API key updated dynamically');
  }
  if (openAiApiKey) {
    process.env.OPENAI_API_KEY = openAiApiKey;
    log.info({ actor: req.user?.username }, 'OpenAI API key updated dynamically');
  }
  saveSystemSettingsToEnv(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, geminiApiKey);
  res.json({ success: true, message: 'API keys updated successfully in server memory and persisted to .env.' });
}));

// ── GET /api/settings/system — retrieve SQLite path, scan roots, path overrides ─
router.get('/system', asyncHandler(async (req, res) => {
  const dbPath = dbSvc.getDbPath();
  const rawScanRoots = process.env.BOUNDARY_SCAN_ROOTS || '';
  const allowedRoots = rawScanRoots
    ? rawScanRoots.split(';').filter(Boolean).map(r => path.resolve(r.trim()))
    : [os.homedir()];

  res.json({
    dbPath,
    rawScanRoots,
    allowedRoots,
    ocrCacheDir:        process.env.OCR_CACHE_DIR             || '',
    downloadsDir:       process.env.BOUNDARY_DOWNLOADS_DIR    || '',
    wordDocTrainingDir: process.env.WORD_DOC_TRAINING_DIR     || '',
    ocrEnabled:        process.env.OCR_ENABLED === 'true',
  });
}));

// ── POST /api/settings/system — update all path settings (admin only) ─────────
router.post('/system', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { dbPath, scanRoots, ocrCacheDir, downloadsDir, wordDocTrainingDir, ocrEnabled } = req.body;

  // 1. Validate dbPath stays within safe boundaries (prevent path traversal via settings)
  if (dbPath) {
    const resolved = path.resolve(dbPath);
    const home = os.homedir();
    const tmp  = os.tmpdir();
    if (!resolved.startsWith(home) && !resolved.startsWith(tmp) && !resolved.startsWith('/var') && !resolved.startsWith('/data')) {
      return res.status(400).json({
        error: `Database path must be within the user home directory or a data directory. Got: ${resolved}`,
      });
    }
  }

  // 2. Switch Database Path if changed
  if (dbPath && dbPath !== dbSvc.getDbPath()) {
    dbSvc.switchDbPath(dbPath);
    process.env.DATABASE_PATH = dbPath;
    log.info({ dbPath, actor: req.user?.username }, 'Database path switched');
  }

  // 3. Switch Allowed Scan Roots if changed
  if (scanRoots !== undefined) {
    process.env.BOUNDARY_SCAN_ROOTS = scanRoots;
  }

  // 4. Path overrides — apply to process.env immediately (no restart needed)
  if (ocrCacheDir !== undefined)        process.env.OCR_CACHE_DIR             = ocrCacheDir;
  if (downloadsDir !== undefined)       process.env.BOUNDARY_DOWNLOADS_DIR    = downloadsDir;
  if (wordDocTrainingDir !== undefined) process.env.WORD_DOC_TRAINING_DIR     = wordDocTrainingDir;
  if (ocrEnabled !== undefined)         process.env.OCR_ENABLED               = ocrEnabled ? 'true' : 'false';

  // 5. Persist to .env file for server restarts
  saveSystemSettingsToEnv(dbPath, scanRoots, undefined, undefined, undefined, undefined, ocrCacheDir, downloadsDir, wordDocTrainingDir, ocrEnabled);

  res.json({
    success: true,
    message: 'System settings updated and persisted to .env.',
    dbPath: dbSvc.getDbPath(),
    scanRoots:          process.env.BOUNDARY_SCAN_ROOTS   || '',
    ocrCacheDir:        process.env.OCR_CACHE_DIR          || '',
    downloadsDir:       process.env.BOUNDARY_DOWNLOADS_DIR || '',
    wordDocTrainingDir: process.env.WORD_DOC_TRAINING_DIR  || '',
    ocrEnabled:        process.env.OCR_ENABLED === 'true',
  });
}));

// ── Helper: persist system settings to .env file (atomic write) ───────────────
// Reads existing .env, merges only the supplied keys, and atomically renames.
// Comments and unrelated keys are preserved.
function saveSystemSettingsToEnv(newDbPath, newScanRoots, newProvider, newModel, newAllowFallback, newEnforceIntersection, newOcrCacheDir, newDownloadsDir, newWordDocTrainingDir, newOcrEnabled, newGeminiApiKey) {
  const envPath    = path.resolve(process.cwd(), '.env');
  const envTmpPath = envPath + '.tmp';

  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  const lines = envContent.split(/\r?\n/);
  const vars = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    vars[key] = val;
  }

  if (newDbPath           !== undefined) vars['DATABASE_PATH']            = newDbPath;
  if (newScanRoots        !== undefined) vars['BOUNDARY_SCAN_ROOTS']      = newScanRoots;
  if (newProvider         !== undefined) vars['ACTIVE_PROVIDER']          = newProvider;
  if (newModel            !== undefined) vars['ACTIVE_MODEL']             = newModel;
  if (newAllowFallback    !== undefined) vars['ALLOW_API_FALLBACK']       = newAllowFallback ? 'true' : 'false';
  if (newEnforceIntersection !== undefined) vars['ENFORCE_NO_SELF_INTERSECTION'] = newEnforceIntersection ? 'true' : 'false';
  if (newOcrCacheDir      !== undefined) vars['OCR_CACHE_DIR']            = newOcrCacheDir;
  if (newDownloadsDir     !== undefined) vars['BOUNDARY_DOWNLOADS_DIR']   = newDownloadsDir;
  if (newWordDocTrainingDir !== undefined) vars['WORD_DOC_TRAINING_DIR']  = newWordDocTrainingDir;
  if (newOcrEnabled       !== undefined) vars['OCR_ENABLED']              = newOcrEnabled ? 'true' : 'false';
  if (newGeminiApiKey     !== undefined) vars['GEMINI_API_KEY']           = newGeminiApiKey;

  const newLines = ['# Boundary.IQ — Environment Variables'];
  for (const [key, val] of Object.entries(vars)) {
    newLines.push(`${key}=${val}`);
  }

  // Atomic write: write to .env.tmp first, then rename over .env.
  // A crash mid-write will never leave a truncated .env file.
  fs.writeFileSync(envTmpPath, newLines.join('\n') + '\n', 'utf8');
  fs.renameSync(envTmpPath, envPath);
  log.info({ envPath }, 'System settings persisted to .env');
}

export default router;
