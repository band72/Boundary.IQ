// ─── Traverse Route ─────────────────────────────────────────────────────────
import { Router } from 'express';
import * as traverseSvc from '../services/Scripting/traverse.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);

router.post('/compute', (req, res) => {
  try {
    const body = req.body;
    const request = {
      pointOfBeginning: {
        northing: body.pointOfBeginning?.northing ?? body.PointOfBeginning?.Northing ?? 5000,
        easting:  body.pointOfBeginning?.easting  ?? body.PointOfBeginning?.Easting  ?? 5000,
      },
      courses: normalizeCourses(body.courses ?? body.Courses ?? []),
      units: body.units ?? body.Units ?? 'Feet',
      isOpenEnded: body.isOpenEnded ?? body.IsOpenEnded ?? false,
    };
    const result = traverseSvc.compute(request);
    res.json(result);
  } catch (ex) {
    if (ex.message?.includes('requires')) {
      console.warn('Traverse validation error:', ex.message);
      return res.status(400).json({ error: ex.message });
    }
    console.error('Traverse compute error:', ex);
    res.status(500).json({ error: 'Internal computation error. ' + ex.message });
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
