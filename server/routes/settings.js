// ─── Settings Route ─────────────────────────────────────────────────────────
// Runtime model/provider switching + Ollama status probe.
import { Router } from 'express';
import { spawn } from 'child_process';
import * as gemini from '../services/geminiVision.js';
import * as ollamaSvc from '../services/ollamaVision.js';
import * as dbSvc from '../services/diagnosticsDb.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
const router = Router();

// Secure all settings routes with session authentication
router.use(requireAuth);

let ollamaSpawnPending = false;

// GET /api/settings/model — current provider & available options
router.get('/model', async (req, res) => {
  try {
    const ollamaStatus = await ollamaSvc.getStatus();
    const openAiBaseUrl = gemini.getOpenAiBaseUrl();
    const openAiStatus = await ollamaSvc.getStatusOpenAI(openAiBaseUrl);

    const geminiModels = [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'gemini', description: 'Fast, cost-effective multimodal model' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', description: 'Previous generation Flash' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', description: 'High-capability reasoning model' },
    ];

    const ollamaModels = ollamaStatus.models.map(m => ({
      id: m,
      name: m.split(':')[0].charAt(0).toUpperCase() + m.split(':')[0].slice(1) + (m.includes(':') ? ` (${m.split(':')[1]})` : ''),
      provider: 'ollama',
      description: 'Local model via Ollama',
    }));

    // OpenAI-compat models — exclude any that are already in Ollama list to avoid dups
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
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

// POST /api/settings/model — switch active provider & model
router.post('/model', (req, res) => {
  try {
    const { provider, model, openaiBaseUrl, allowApiFallback, enforceNoSelfIntersection } = req.body;
    if (!provider) return res.status(400).json({ error: 'provider is required.' });

    gemini.setProvider(provider, model, openaiBaseUrl || undefined);

    if (allowApiFallback !== undefined) {
      process.env.ALLOW_API_FALLBACK = String(allowApiFallback);
    }

    if (enforceNoSelfIntersection !== undefined) {
      process.env.ENFORCE_NO_SELF_INTERSECTION = String(enforceNoSelfIntersection);
    }

    // Save active provider/model settings to .env
    saveSystemSettingsToEnv(undefined, undefined, provider, model || undefined, allowApiFallback, enforceNoSelfIntersection);

    res.json({
      message: `Switched to ${provider}/${model || '(default)'}`,
      activeProvider: gemini.getActiveProvider(),
      activeModel: gemini.getActiveModel(),
      allowApiFallback: process.env.ALLOW_API_FALLBACK !== 'false',
      enforceNoSelfIntersection: process.env.ENFORCE_NO_SELF_INTERSECTION === 'true',
    });
  } catch (ex) {
    res.status(400).json({ error: ex.message });
  }
});

// GET /api/settings/ollama/status — detailed Ollama health check
router.get('/ollama/status', async (req, res) => {
  try {
    const status = await ollamaSvc.getStatus();
    res.json(status);
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

// POST /api/settings/ollama/start — launch `ollama serve` detached if not running
router.post('/ollama/start', async (req, res) => {
  // First check if already online
  const current = await ollamaSvc.getStatus();
  if (current.online) {
    return res.json({ started: false, message: 'Ollama is already running.', models: current.models });
  }

  if (ollamaSpawnPending) {
    return res.json({ started: false, message: 'Ollama startup already in progress. Please wait a moment then refresh.' });
  }

  try {
    ollamaSpawnPending = true;
    const ollamaPath = process.env.OLLAMA_PATH || 'ollama';
    let cmd = ollamaPath;
    let args = ['serve'];
    if (process.platform === 'win32' && (ollamaPath.startsWith('/') || ollamaPath.includes('wsl') || process.env.OLLAMA_RUNS_ON_WSL === 'true' || ollamaPath === '/home/friend/.local/bin/ollama')) {
      cmd = 'wsl';
      args = [ollamaPath === 'ollama' ? 'ollama' : ollamaPath, 'serve'];
    }
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      // Handle spawn error gracefully without crashing
    });
    child.unref(); // Let node exit without waiting for this process

    // Wait 2.5 s then verify it came up
    await new Promise(r => setTimeout(r, 2500));
    const status = await ollamaSvc.getStatus();
    ollamaSpawnPending = false;

    if (status.online) {
      return res.json({ started: true, message: `Ollama started. ${status.models.length} model(s) available.`, models: status.models });
    } else {
      return res.json({ started: false, message: 'Ollama spawn attempted but server did not respond yet. Wait a few seconds and refresh.', error: status.error });
    }
  } catch (ex) {
    ollamaSpawnPending = false;
    res.status(500).json({ error: `Failed to spawn ollama: ${ex.message}` });
  }
});

// POST /api/settings/keys — update API keys in memory (admin only)
router.post('/keys', requireRole(['admin']), (req, res) => {
  try {
    const { geminiApiKey, openAiApiKey } = req.body;
    if (geminiApiKey) {
      gemini.init(geminiApiKey);
      console.log('✓ Gemini API key updated dynamically via settings.');
    }
    if (openAiApiKey) {
      process.env.OPENAI_API_KEY = openAiApiKey;
      console.log('✓ OpenAI API key updated dynamically via settings.');
    }
    res.json({ success: true, message: 'API keys updated successfully in server memory.' });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

// Helper to save system settings back to .env file for persistence (atomic write)
function saveSystemSettingsToEnv(newDbPath, newScanRoots, newProvider, newModel, newAllowFallback, newEnforceIntersection, newOcrCacheDir, newDownloadsDir, newWordDocTrainingDir) {
  const envPath = path.resolve(process.cwd(), '.env');
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
    const parts = trimmed.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      vars[key] = val;
    }
  }

  if (newDbPath !== undefined) vars['DATABASE_PATH'] = newDbPath;
  if (newScanRoots !== undefined) vars['BOUNDARY_SCAN_ROOTS'] = newScanRoots;
  if (newProvider !== undefined) vars['ACTIVE_PROVIDER'] = newProvider;
  if (newModel !== undefined) vars['ACTIVE_MODEL'] = newModel;
  if (newAllowFallback !== undefined) vars['ALLOW_API_FALLBACK'] = String(newAllowFallback);
  if (newEnforceIntersection !== undefined) vars['ENFORCE_NO_SELF_INTERSECTION'] = String(newEnforceIntersection);
  if (newOcrCacheDir !== undefined) vars['OCR_CACHE_DIR'] = newOcrCacheDir;
  if (newDownloadsDir !== undefined) vars['BOUNDARY_DOWNLOADS_DIR'] = newDownloadsDir;
  if (newWordDocTrainingDir !== undefined) vars['WORD_DOC_TRAINING_DIR'] = newWordDocTrainingDir;

  const newLines = [];
  newLines.push('# Boundary.IQ — Environment Variables');
  for (const [key, val] of Object.entries(vars)) {
    newLines.push(`${key}=${val}`);
  }

  // Atomic write: write to .env.tmp first, then rename over .env
  // This ensures a crash mid-write never leaves a truncated .env file.
  fs.writeFileSync(envTmpPath, newLines.join('\n') + '\n', 'utf8');
  fs.renameSync(envTmpPath, envPath);
  console.log(`✓ System settings persisted to .env file at: ${envPath}`);
}

// GET /api/settings/system — retrieve SQLite path, scan roots, and path overrides
router.get('/system', (req, res) => {
  try {
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
    });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

// POST /api/settings/system — update all path settings (admin only)
router.post('/system', requireRole(['admin']), (req, res) => {
  try {
    const { dbPath, scanRoots, ocrCacheDir, downloadsDir, wordDocTrainingDir } = req.body;

    // 1. Switch Database Path if changed
    if (dbPath && dbPath !== dbSvc.getDbPath()) {
      dbSvc.switchDbPath(dbPath);
      process.env.DATABASE_PATH = dbPath;
    }

    // 2. Switch Allowed Scan Roots if changed
    if (scanRoots !== undefined) {
      process.env.BOUNDARY_SCAN_ROOTS = scanRoots;
    }

    // 3. Path overrides — apply to process.env immediately (no restart needed)
    if (ocrCacheDir !== undefined)        process.env.OCR_CACHE_DIR             = ocrCacheDir;
    if (downloadsDir !== undefined)       process.env.BOUNDARY_DOWNLOADS_DIR    = downloadsDir;
    if (wordDocTrainingDir !== undefined) process.env.WORD_DOC_TRAINING_DIR     = wordDocTrainingDir;

    // 4. Persist to .env file for server restarts
    saveSystemSettingsToEnv(dbPath, scanRoots, undefined, undefined, undefined, undefined, ocrCacheDir, downloadsDir, wordDocTrainingDir);

    res.json({
      success: true,
      message: 'System settings updated and persisted to .env.',
      dbPath: dbSvc.getDbPath(),
      scanRoots:          process.env.BOUNDARY_SCAN_ROOTS   || '',
      ocrCacheDir:        process.env.OCR_CACHE_DIR          || '',
      downloadsDir:       process.env.BOUNDARY_DOWNLOADS_DIR || '',
      wordDocTrainingDir: process.env.WORD_DOC_TRAINING_DIR  || '',
    });
  } catch (ex) {
    res.status(500).json({ error: `Failed to update system settings: ${ex.message}` });
  }
});

export default router;
