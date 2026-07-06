// ── Legal Description Route ────────────────────────────────────────────────────
// Parses plain-text metes-and-bounds legal descriptions (from ALTA title
// commitments, deeds, or any typed/pasted text) without requiring a plat image.
//
// POST /api/legal/parse
//   Body: { text: string, pobN?: number, pobE?: number, units?: string }
//   Returns: { courses, traverse, qc, tracts }
//
// POST /api/legal/parse-file
//   Body: multipart/form-data with 'file' (PDF or TXT)
//   Returns: same as above
// ──────────────────────────────────────────────────────────────────────────────

import { Router }  from 'express';
import multer       from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { solveDeedText } from '../services/Scripting/deedTextSolver.js';
import * as traverseSvc from '../services/Scripting/traverse.js';
import { disambiguateQuadrants } from '../services/Scripting/quadrantDisambiguator.js';
import pdfParse from 'pdf-parse';

const router = Router();
router.use(requireAuth);

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

const QC_CLOSURE_MAX_FT = 5.0;

// ── Helper: run traverse + QC on a course set ─────────────────────────────────
function computeAndQC(courses, pobN, pobE, units, isOpenEnded) {
  if (!courses || courses.length === 0) return { traverse: null, qc: null };
  try {
    const traverse = traverseSvc.compute({
      pointOfBeginning: { northing: pobN, easting: pobE },
      courses,
      units: units || 'Feet',
      isOpenEnded: !!isOpenEnded,
    });
    const linearError = traverse.closure?.linearError ?? null;
    const hasSelfIntersection = traverse.hasSelfIntersection ?? false;
    const qc = {
      hasSelfIntersection,
      closureWarning: linearError !== null && linearError > QC_CLOSURE_MAX_FT,
      linearError,
    };
    return { traverse, qc };
  } catch (ex) {
    return { traverse: null, qc: null, traverseError: ex.message };
  }
}

// ── POST /api/legal/parse ─────────────────────────────────────────────────────
// Accepts raw metes-and-bounds text in JSON body.
router.post('/parse', async (req, res) => {
  try {
    const { text, pobN = 5000, pobE = 5000, units = 'Feet', model } = req.body ?? {};
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({ error: 'A legal description text of at least 20 characters is required.' });
    }

    console.log(`[LEGAL] Parsing legal description — ${text.length} chars`);

    // Run the deed text solver (LLM-based extraction + COGO repair)
    const solved = await solveDeedText(text.trim(), model || null, { pobN, pobE, units });

    const result = buildResponse(solved, pobN, pobE, units);
    res.json(result);
  } catch (ex) {
    console.error('[LEGAL] Parse error:', ex);
    res.status(500).json({ error: ex.message });
  }
});

// ── POST /api/legal/parse-file ────────────────────────────────────────────────
// Accepts a PDF or TXT file upload, converts to text, then parses.
router.post('/parse-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    const pobN  = parseFloat(req.body?.pobN)  || 5000;
    const pobE  = parseFloat(req.body?.pobE)  || 5000;
    const units = req.body?.units || 'Feet';
    const model = req.body?.model || null;

    const ext = (req.file.originalname || '').split('.').pop()?.toLowerCase();
    let text = '';

    if (ext === 'txt') {
      text = req.file.buffer.toString('utf8');
    } else if (ext === 'pdf') {
      try {
        const parsedPdf = await pdfParse(req.file.buffer);
        text = parsedPdf.text || '';
      } catch (convErr) {
        return res.status(422).json({ error: `PDF text extraction failed: ${convErr.message}` });
      }
    } else {
      return res.status(400).json({ error: 'Only PDF and TXT files are supported for legal description parsing.' });
    }

    if (!text || text.trim().length < 20) {
      return res.status(422).json({ error: 'Could not extract usable text from the uploaded file.' });
    }

    console.log(`[LEGAL] Parsing uploaded file — ${req.file.originalname}, ${text.length} chars`);

    const solved = await solveDeedText(text.trim(), model, { pobN, pobE, units });
    const result = buildResponse(solved, pobN, pobE, units);
    res.json(result);
  } catch (ex) {
    console.error('[LEGAL] Parse-file error:', ex);
    res.status(500).json({ error: ex.message });
  }
});

// ── Build response from solved deed ───────────────────────────────────────────
function buildResponse(solved, pobN, pobE, units) {
  // solved may contain single-tract or multi-tract structure
  const tracts = (solved.tracts || []);

  // For multi-tract: run QC on each tract
  const processedTracts = tracts.map(tract => {
    const { traverse, qc, traverseError } = computeAndQC(
      tract.courses || tract.segments || [],
      pobN, pobE, units,
      tract.isOpenEnded
    );
    return { ...tract, traverse, qc, traverseError };
  });

  // Primary tract (first one) for backward-compat response shape
  const primary = processedTracts[0] ?? {};

  return {
    text: solved.deedText ?? null,
    courses: primary.courses || primary.segments || solved.courses || [],
    traverse: primary.traverse ?? solved.traverse ?? null,
    qc: primary.qc ?? null,
    tracts: processedTracts,
    referencePointName: primary.referencePointName ?? solved.referencePointName ?? null,
    commencementSegments: primary.commencementSegments ?? solved.commencementSegments ?? [],
    isOpenEnded: primary.isOpenEnded ?? solved.isOpenEnded ?? false,
    rawExtraction: solved.extraction ?? null,
  };
}

export default router;
