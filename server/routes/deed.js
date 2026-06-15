// ─── Deed Text Solver Route ──────────────────────────────────────────────────
// Accepts raw legal description text and returns a corrected traverse.
// POST /api/deed/solve          — solve using local LLM extraction + COGO math
// GET  /api/deed/models         — list available Ollama models
// POST /api/deed/solve-direct   — solve pre-parsed courses with COGO only (no LLM)

import { Router } from 'express';
import { solveDeedText, listAvailableModels, solveFromText, solveFromCourses } from '../services/deedTextSolver.js';
import * as traverseSvc from '../services/traverse.js';
import { requireAuth, trackDeedUsage } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);

// ── GET /api/deed/models ─────────────────────────────────────────────────────
// Returns all available Ollama models with suitability ratings for deed extraction.
router.get('/models', async (req, res) => {
  try {
    const models = await listAvailableModels();
    res.json({ models, ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434' });
  } catch (ex) {
    res.status(503).json({
      error: `Ollama not reachable: ${ex.message}`,
      suggestion: 'Start Ollama with: ollama serve'
    });
  }
});

// ── POST /api/deed/solve ──────────────────────────────────────────────────────
// Body: { deedText: string, model?: string, pobNorthing?: number, pobEasting?: number, units?: string }
// Uses a local LLM to extract courses, then COGO engine to repair and verify closure.
// trackDeedUsage: enforces free-tier daily limit (5 solves/day) before running the LLM.
router.post('/solve', trackDeedUsage, async (req, res) => {
  try {
    const { deedText, model, pobNorthing, pobEasting, units, isOpenEnded } = req.body;

    if (!deedText || typeof deedText !== 'string' || deedText.trim().length < 20) {
      return res.status(400).json({ error: 'deedText is required (minimum 20 characters).' });
    }

    const selectedModel = model || process.env.DEFAULT_LOCAL_MODEL || 'llama3.2';

    console.log(`[POST /api/deed/solve] model=${selectedModel}, textLength=${deedText.length}`);

    const result = await solveDeedText(deedText, selectedModel, {
      pobNorthing: parseFloat(pobNorthing) || 5000,
      pobEasting:  parseFloat(pobEasting)  || 5000,
      units:       units || 'Feet',
      isOpenEnded: isOpenEnded === true || isOpenEnded === 'true',
    });

    res.json(result);
  } catch (ex) {
    console.error('[POST /api/deed/solve] Error:', ex.message);

    // Specific user-friendly errors
    if (ex.message.includes('not found')) {
      return res.status(404).json({ error: ex.message, suggestion: 'Run: ollama pull <model-name>' });
    }
    if (ex.message.includes('not reachable') || ex.message.includes('ECONNREFUSED')) {
      return res.status(503).json({ error: 'Ollama is not running.', suggestion: 'Start Ollama with: ollama serve' });
    }

    res.status(500).json({ error: ex.message });
  }
});

// ── POST /api/deed/solve-text ─────────────────────────────────────────────────
// No LLM, no Ollama. Parses deed text with regex + full COGO repair.
// trackDeedUsage: still counts against the daily limit (uses the solve pipeline).
// Body: { deedText: string, pobNorthing?: number, pobEasting?: number, units?: string }
router.post('/solve-text', trackDeedUsage, (req, res) => {
  try {
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
  } catch (ex) {
    res.status(400).json({ error: ex.message });
  }
});

// ── POST /api/deed/solve-direct ───────────────────────────────────────────────
// Accepts pre-parsed courses (no LLM needed) and runs only the COGO repair engine.
// Useful for UI-driven manual correction or testing.
// Body: { courses: [...], pobNorthing, pobEasting, units }
router.post('/solve-direct', (req, res) => {
  try {
    const { courses, pobNorthing, pobEasting, units, isOpenEnded } = req.body;

    if (!courses || !Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({ error: 'courses array is required.' });
    }

    const pob = {
      northing: parseFloat(pobNorthing) || 5000,
      easting:  parseFloat(pobEasting)  || 5000,
    };

    // Run the full traverse computation including gap solver
    const result = traverseSvc.compute({
      pointOfBeginning: pob,
      courses: normalizeCourses(courses),
      units: units || 'Feet',
      isOpenEnded: isOpenEnded === true || isOpenEnded === 'true',
    });

    res.json({ status: 'computed', traverse: result, pob, units: units || 'Feet' });
  } catch (ex) {
    res.status(400).json({ error: ex.message });
  }
});

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
