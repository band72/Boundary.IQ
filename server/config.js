// ─── Central Configuration ────────────────────────────────────────────────────
// All environment variable reads live here. Import { cfg } in any module instead
// of calling process.env directly. This makes misconfiguration visible at startup
// rather than silently at runtime.

/**
 * Strip surrounding quotes that Windows/Linux .env editors sometimes add.
 * e.g.  GEMINI_API_KEY="abc"  →  "abc"  (quotes are already stripped by dotenv,
 * but some tools double-encode them).
 */
function getEnv(key) {
  let val = process.env[key];
  if (!val) return undefined;
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return val || undefined;
}

function getInt(key, fallback) {
  const v = parseInt(getEnv(key) || '');
  return isNaN(v) ? fallback : v;
}

function getBool(key, fallback = false) {
  const v = getEnv(key);
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

// ── Server ────────────────────────────────────────────────────────────────────
export const PORT = getInt('PORT', 5051);
export const NODE_ENV = getEnv('NODE_ENV') || 'development';
export const IS_PROD = NODE_ENV === 'production';

// ── AI Providers ──────────────────────────────────────────────────────────────
export const GEMINI_API_KEY = getEnv('GEMINI_API_KEY') || getEnv('Gemini__ApiKey');
export const ACTIVE_PROVIDER = getEnv('ACTIVE_PROVIDER') || 'ollama';
export const ACTIVE_MODEL = getEnv('ACTIVE_MODEL');
export const OLLAMA_URL = getEnv('OLLAMA_URL') || 'http://127.0.0.1:11434';
export const OLLAMA_PATH = getEnv('OLLAMA_PATH') || 'ollama';
export const OLLAMA_RUNS_ON_WSL = getBool('OLLAMA_RUNS_ON_WSL');
export const OLLAMA_FALLBACK_MODEL = getEnv('OLLAMA_FALLBACK_MODEL') || 'gemma4:26b';
export const OPENAI_BASE_URL = getEnv('OPENAI_BASE_URL') || 'http://127.0.0.1:11434/v1';
export const DEFAULT_LOCAL_MODEL = getEnv('DEFAULT_LOCAL_MODEL') || 'llama3.2';
export const ALLOW_API_FALLBACK = getBool('ALLOW_API_FALLBACK', true);

// ── Database ──────────────────────────────────────────────────────────────────
export const DATABASE_PATH = getEnv('DATABASE_PATH');

// ── CORS ──────────────────────────────────────────────────────────────────────
export const FRONTEND_URL   = getEnv('FRONTEND_URL')   || 'http://localhost:5174';
export const CLOUD_RUN_URL  = getEnv('CLOUD_RUN_URL');   // e.g. https://boundary-iq-xxxx-uc.a.run.app
export const FLY_APP_URL    = getEnv('FLY_APP_URL');     // e.g. https://boundary-iq.fly.dev

// Dynamic origin validator — accepts localhost dev origins plus any deployment URL
// explicitly provided, plus wildcard subdomains for Cloud Run / Fly.io.
export const ALLOWED_ORIGINS = getEnv('ALLOWED_ORIGINS')
  ? getEnv('ALLOWED_ORIGINS').split(';').filter(Boolean).map(o => o.trim())
  : (function buildOrigins() {
      const fixed = [
        'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175',
        'http://127.0.0.1:5173', 'http://127.0.0.1:5174', 'http://127.0.0.1:5175',
        FRONTEND_URL,
        CLOUD_RUN_URL,
        FLY_APP_URL,
      ].filter(Boolean);

      // Accept any *.run.app or *.fly.dev origin dynamically (Cloud Run / Fly.io)
      return (origin) => {
        if (!origin) return true; // allow non-browser callers (curl, server-to-server)
        if (fixed.includes(origin)) return true;
        if (/^https:\/\/[\w-]+\.a\.run\.app$/.test(origin)) return true;  // Cloud Run
        if (/^https:\/\/[\w-]+\.fly\.dev$/.test(origin)) return true;     // Fly.io
        return false;
      };
    })();

// ── Auth & Email ──────────────────────────────────────────────────────────────
export const GOOGLE_CLIENT_ID = getEnv('GOOGLE_CLIENT_ID');
export const INVITE_ONLY = getBool('INVITE_ONLY');
export const RESEND_API_KEY = getEnv('RESEND_API_KEY');
export const EMAIL_FROM = getEnv('EMAIL_FROM') || 'noreply@boundary.iq';
export const EMAIL_FROM_NAME = getEnv('EMAIL_FROM_NAME') || 'Boundary.IQ';

// ── Billing ───────────────────────────────────────────────────────────────────
export const STRIPE_SECRET_KEY = getEnv('STRIPE_SECRET_KEY');
export const STRIPE_WEBHOOK_SECRET = getEnv('STRIPE_WEBHOOK_SECRET');

// ── File Processing ───────────────────────────────────────────────────────────
export const BOUNDARY_SCAN_ROOTS = getEnv('BOUNDARY_SCAN_ROOTS');
export const BOUNDARY_PATH_USER_MAP = getEnv('BOUNDARY_PATH_USER_MAP');
export const OCR_CACHE_DIR = getEnv('OCR_CACHE_DIR');
export const OCR_ENABLED = getBool('OCR_ENABLED');
/** Maximum in-memory OCR cache entries. Each entry ≈ 0.7 MB. Default 200 ≈ 140 MB. */
export const OCR_CACHE_MAX_ENTRIES = getInt('OCR_CACHE_MAX_ENTRIES', 200);
/** Days before a disk-cached OCR entry is considered stale and re-processed. */
export const OCR_CACHE_TTL_DAYS = getInt('OCR_CACHE_TTL_DAYS', 30);

// ── Logging ───────────────────────────────────────────────────────────────────
export const LOG_LEVEL = getEnv('LOG_LEVEL') || (getEnv('NODE_ENV') === 'production' ? 'info' : 'debug');

// ── Timeouts (ms) — 30-minute defaults to support local CPU LLM inference ─────
export const SERVER_TIMEOUT_MS = getInt('SERVER_TIMEOUT_MS', 1_800_000);

// ── Rate Limits ────────────────────────────────────────────────────────────────
/** Max deed solve requests per user per minute on the /api/deed/* endpoints. */
export const DEED_SOLVE_RATE_LIMIT = getInt('DEED_SOLVE_RATE_LIMIT', 10);
/** Max folder scan requests per user per minute on the /api/folderscan/* endpoints. */
export const SCAN_RATE_LIMIT = getInt('SCAN_RATE_LIMIT', 5);

// ── Convenience bundle ────────────────────────────────────────────────────────
export const cfg = {
  PORT, NODE_ENV, IS_PROD,
  GEMINI_API_KEY, ACTIVE_PROVIDER, ACTIVE_MODEL,
  OLLAMA_URL, OLLAMA_PATH, OLLAMA_RUNS_ON_WSL, OLLAMA_FALLBACK_MODEL,
  OPENAI_BASE_URL, DEFAULT_LOCAL_MODEL, ALLOW_API_FALLBACK,
  DATABASE_PATH,
  FRONTEND_URL, CLOUD_RUN_URL, FLY_APP_URL, ALLOWED_ORIGINS,
  GOOGLE_CLIENT_ID, INVITE_ONLY, RESEND_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  BOUNDARY_SCAN_ROOTS, BOUNDARY_PATH_USER_MAP,
  OCR_CACHE_DIR, OCR_ENABLED, OCR_CACHE_MAX_ENTRIES, OCR_CACHE_TTL_DAYS,
  LOG_LEVEL, SERVER_TIMEOUT_MS,
  DEED_SOLVE_RATE_LIMIT, SCAN_RATE_LIMIT,
};
