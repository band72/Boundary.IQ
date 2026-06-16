// ─── Deed Text Solver Route ──────────────────────────────────────────────────
// Accepts raw legal description text and returns a corrected traverse.
// POST /api/deed/solve          — solve using local LLM extraction + COGO math
// GET  /api/deed/models         — list available Ollama models
// POST /api/deed/solve-direct   — solve pre-parsed courses with COGO only (no LLM)

import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { solveDeedText, listAvailableModels, solveFromText } from '../services/deedTextSolver.js';
import * as traverseSvc from '../services/traverse.js';
import { requireAuth, trackDeedUsage } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import logger from '../logger.js';
import { DEED_SOLVE_RATE_LIMIT, DEFAULT_LOCAL_MODEL, OLLAMA_URL } from '../config.js';

const router = Router();
router.use(requireAuth);

// ── Per-user rate limiter for LLM-backed solve routes ─────────────────────────
const solveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: DEED_SOLVE_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ? String(req.user.id) : ipKeyGenerator(req),
  skip: (req) => req.user?.role === 'admin',
  message: { error: `Too many solve requests. Maximum ${DEED_SOLVE_RATE_LIMIT} per minute per user.` },
});

// ── GET /api/deed/models ─────────────────────────────────────────────────────
// Returns all available Ollama models with suitability ratings for deed extraction.
router.get('/models', asyncHandler(async (req, res) => {
  const models = await listAvailableModels();
  res.json({ models, ollamaUrl: OLLAMA_URL });
}));

// ── POST /api/deed/solve ──────────────────────────────────────────────────────
// Body: { deedText: string, model?: string, pobNorthing?: number, pobEasting?: number, units?: string }
router.post('/solve', trackDeedUsage, solveLimiter, asyncHandler(async (req, res) => {
  const { deedText, model, pobNorthing, pobEasting, units, isOpenEnded } = req.body;

  if (!deedText || typeof deedText !== 'string' || deedText.trim().length < 20) {
    return res.status(400).json({ error: 'deedText is required (minimum 20 characters).' });
  }

  const selectedModel = model || DEFAULT_LOCAL_MODEL;
  logger.info({ model: selectedModel, textLength: deedText.length }, '[deed/solve]');

  const result = await solveDeedText(deedText, selectedModel, {
    pobNorthing: parseFloat(pobNorthing) || 5000,
    pobEasting:  parseFloat(pobEasting)  || 5000,
    units:       units || 'Feet',
    isOpenEnded: isOpenEnded === true || isOpenEnded === 'true',
  });

  res.json(result);
}));

// ── POST /api/deed/solve-text ─────────────────────────────────────────────────
// No LLM, no Ollama. Parses deed text with regex + full COGO repair.
router.post('/solve-text', trackDeedUsage, solveLimiter, asyncHandler(async (req, res) => {
  const { deedText, pobNorthing, pobEasting, units } = req.body;
  if (!deedText || typeof deedText !== 'string' || deedText.trim().length < 20) {
    return res.status(400).json({ error: 'deedText is required (minimum 20 characters).' });
  }
  const result = solveFromText(deedText, {
    pobNorthing: parseFloat(pobNorthing) || 5000,
    pobEasting:  parseFloat(pobEasting)  || 5000,
    units: units || 'Feet',
  });
  res.json(result);
}));

// ── POST /api/deed/solve-direct ───────────────────────────────────────────────
// Accepts pre-parsed courses (no LLM needed) and runs only the COGO repair engine.
// Useful for UI-driven manual correction or testing.
// Body: { courses: [...], pobNorthing, pobEasting, units }
router.post('/solve-direct', asyncHandler(async (req, res) => {
  const { courses, pobNorthing, pobEasting, units, isOpenEnded } = req.body;

  if (!courses || !Array.isArray(courses) || courses.length === 0) {
    return res.status(400).json({ error: 'courses array is required.' });
  }

  const pob = {
    northing: parseFloat(pobNorthing) || 5000,
    easting:  parseFloat(pobEasting)  || 5000,
  };

  const result = traverseSvc.compute({
    pointOfBeginning: pob,
    courses: normalizeCourses(courses),
    units: units || 'Feet',
    isOpenEnded: isOpenEnded === true || isOpenEnded === 'true',
  });

  res.json({ status: 'computed', traverse: result, pob, units: units || 'Feet' });
}));

function normalizeCourses(arr) {
  return arr.map(c => ({
    type: c.type ?? c.Type ?? 'Line',
    bearing: c.bearing ?? c.Bearing ?? null,
    distance: c.distance ?? c.Distance ?? null,
    delta: c.delta ?? c.Delta ?? null,
    radius: c.radius ?? c.Radius ?? null,
    arcLength: c.arcLength ?? c.ArcLength ?? null,
    curveDirection: c.curveDirection ?? c.CurveDirection ?? c.Direction ?? null,
    chordBearing: c.chordBearing ?? c.ChordBearing ?? null,
    chordDistance: c.chordDistance ?? c.ChordDistance ?? null,
    isUnknown: c.isUnknown ?? c.IsUnknown ?? false,
  }));
}

export default router;
