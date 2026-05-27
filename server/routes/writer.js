// ─── Writer Route ───────────────────────────────────────────────────────────
import { Router } from 'express';
import * as legalWriter from '../services/legalWriter.js';
const router = Router();

router.post('/generate', (req, res) => {
  try {
    const body = req.body;
    const request = {
      courses: normalizeCourses(body.courses ?? body.Courses ?? []),
      pobNorthing: body.pobNorthing ?? body.PobNorthing ?? 5000,
      pobEasting: body.pobEasting ?? body.PobEasting ?? 5000,
      parcelDescription: body.parcelDescription ?? body.ParcelDescription ?? null,
      county: body.county ?? body.County ?? null,
      state: body.state ?? body.State ?? null,
      units: body.units ?? body.Units ?? 'feet',
      basisOfBearings: body.basisOfBearings ?? body.BasisOfBearings ?? null,
      bearingSystem: body.bearingSystem ?? body.BearingSystem ?? null,
      areaAcres: body.areaAcres ?? body.AreaAcres ?? null,
      perimeter: body.perimeter ?? body.Perimeter ?? null,
    };
    const text = legalWriter.write(request);
    res.json({ legalDescription: text, courseCount: request.courses.length });
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
