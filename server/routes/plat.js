// ─── Plat Route ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import multer from 'multer';
import * as gemini from '../services/geminiVision.js';
import * as traverseSvc from '../services/traverse.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);

const upload = multer({ limits: { fileSize: 51 * 1024 * 1024 } }); // 51MB

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

function normalizeMime(file) {
  let mime = (file.mimetype || '').toLowerCase();
  if (ALLOWED_MIME.has(mime)) return mime;
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
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

    const extracted = await gemini.extractBoundary(req.file.buffer, mime);

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

    res.json({ extraction: extracted, traverse, traverseError });
  } catch (ex) {
    console.error('Extract-and-compute failed:', ex);
    res.status(500).json({ error: ex.message });
  }
});

export default router;
