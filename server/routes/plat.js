// ─── Plat Route ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import multer from 'multer';
import * as gemini from '../services/geminiVision.js';
import * as traverseSvc from '../services/Scripting/traverse.js';
import { disambiguateQuadrants } from '../services/Scripting/quadrantDisambiguator.js';
import { requireAuth } from '../middleware/auth.js';
import { userSettingsStore } from '../services/db/context.js';
const router = Router();
router.use(requireAuth);

const upload = multer({ limits: { fileSize: 51 * 1024 * 1024 } }); // 51MB

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);

function normalizeMime(file) {
  let mime = (file.mimetype || '').toLowerCase();
  if (mime.includes('text') || mime.includes('plain')) return 'text/plain';
  if (ALLOWED_MIME.has(mime)) return mime;
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain' };
  return map[ext] || mime;
}

// POST /api/plat/extract
router.post('/extract', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    if (req.file.size > 51 * 1024 * 1024)
      return res.status(400).json({ error: `File exceeds 51 MB limit (${(req.file.size / 1024 / 1024).toFixed(1)} MB).` });

    const mime = normalizeMime(req.file);
    console.log(`Plat extract — file: ${req.file.originalname}, size: ${(req.file.size / 1024).toFixed(0)} KB, mime: ${mime}`);

    const store = userSettingsStore.getStore();
    if (store) store.aiRequestType = 'plat-extraction';

    const result = await gemini.extractBoundary(req.file.buffer, mime);
    res.json(result);
  } catch (ex) {
    console.error('Plat extraction failed:', ex);
    res.status(500).json({ error: ex.message });
  }
});

// POST /api/plat/extract-and-compute
router.post('/extract-and-compute', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided.' });

    const mime = normalizeMime(req.file);
    const pobN = parseFloat(req.query.pobN) || 5000;
    const pobE = parseFloat(req.query.pobE) || 5000;
    const units = req.query.units || 'Feet';

    const store = userSettingsStore.getStore();
    if (store) store.aiRequestType = 'plat-extraction';

    const extracted = await gemini.extractBoundary(req.file.buffer, mime);

    // ── Quadrant Disambiguation ────────────────────────────────────────────────
    // Automatically detect and correct N/S E/W bearing flips before traversing.
    let disambig = { correctedCount: 0, corrections: [], courses: extracted.courses };
    if (extracted.courses.length > 0 && !extracted.isOpenEnded) {
      try {
        disambig = disambiguateQuadrants(extracted.courses, pobN, pobE);
        if (disambig.correctedCount > 0) {
          console.log(`[DISAMBIG] Auto-corrected ${disambig.correctedCount} bearing quadrant(s) in ${req.file.originalname}`);
          extracted.courses = disambig.courses;
        }
      } catch (de) {
        console.warn('[DISAMBIG] Quadrant disambiguator error (non-fatal):', de.message);
      }
    }

    let traverse = null, traverseError = null;
    if (extracted.courses.length > 0) {
      try {
        traverse = traverseSvc.compute({
          pointOfBeginning: { northing: pobN, easting: pobE },
          courses: extracted.courses,
          units,
          isOpenEnded: extracted.isOpenEnded,
        });
      } catch (tex) {
        traverseError = `Traverse computation failed: ${tex.message}`;
      }
    }

    // Compute traverses for all extracted parcels/lots
    if (extracted.parcels && Array.isArray(extracted.parcels)) {
      for (const p of extracted.parcels) {
        if (p.courses && p.courses.length > 0) {
          try {
            const trav = traverseSvc.compute({
              pointOfBeginning: { northing: pobN, easting: pobE },
              courses: p.courses,
              units,
              isOpenEnded: p.isOpenEnded,
              commencementSegments: p.commencementSegments || []
            });
            p.traverse = trav;
            p.stations = trav?.stations || [];
            p.adjustedStations = trav?.adjustedStations || [];
            p.perimeter = trav?.perimeter || 0;
            p.areaAcres = trav?.areaAcres || 0;
            p.closure = trav?.closure || null;
            p.status = 'PASS';
          } catch (tex) {
            p.traverseError = `Traverse computation failed: ${tex.message}`;
            p.status = 'FAIL';
          }
        }
      }
    }

    // ── QC Gate ────────────────────────────────────────────────────────────────
    // Always attach QC results so client can display status immediately.
    const QC_CLOSURE_MAX_FT = 5.0;
    const linearError  = traverse?.closure?.linearError  ?? null;
    const hasSelfIntersection = traverse?.hasSelfIntersection ?? false;
    const closureWarning      = linearError !== null && linearError > QC_CLOSURE_MAX_FT;

    const qc = {
      hasSelfIntersection,
      closureWarning,
      linearError,
      // Identify which courses are most likely candidates for the intersect bust
      suspectCourseIndex: hasSelfIntersection
        ? (traverse?.bustCourseIndex ?? null)
        : null,
    };

    if (hasSelfIntersection) {
      console.warn(`[QC GATE] Self-intersecting boundary detected — file: ${req.file.originalname}`);
    }
    if (closureWarning) {
      console.warn(`[QC GATE] Closure error ${linearError?.toFixed(3)} ft exceeds 5.0 ft threshold — file: ${req.file.originalname}`);
    }

    res.json({ extraction: extracted, traverse, traverseError, qc, disambig: {
      correctedCount: disambig.correctedCount,
      corrections: disambig.corrections,
    }});
  } catch (ex) {
    console.error('Extract-and-compute failed:', ex);
    res.status(500).json({ error: ex.message });
  }
});

export default router;
