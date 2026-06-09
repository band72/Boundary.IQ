// ─── DXF Route ──────────────────────────────────────────────────────────────
import { Router } from 'express';
import { generateDxf, generateCombinedDxf } from '../services/dxfExport.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);

router.post('/generate', (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(400).send('Request body is required.');

    const stations = (body.stations ?? body.Stations ?? []).map(s => ({
      easting: s.easting ?? s.Easting, northing: s.northing ?? s.Northing,
      depDN: s.depDN ?? s.DepDN ?? 0, depDE: s.depDE ?? s.DepDE ?? 0,
    }));
    const adjusted = (body.adjusted ?? body.Adjusted ?? body.adjustedStations ?? body.AdjustedStations ?? []).map(s => ({
      easting: s.easting ?? s.Easting, northing: s.northing ?? s.Northing,
    }));
    const courses = (body.courses ?? body.Courses ?? []).map(c => ({
      type: c.type ?? c.Type ?? 'Line',
      bearing: c.bearing ?? c.Bearing ?? null,
      distance: c.distance ?? c.Distance ?? null,
      delta: c.delta ?? c.Delta ?? null,
      radius: c.radius ?? c.Radius ?? null,
      arcLength: c.arcLength ?? c.ArcLength ?? null,
      curveDirection: c.curveDirection ?? c.CurveDirection ?? c.Direction ?? null,
      chordBearing: c.chordBearing ?? c.ChordBearing ?? null,
      chordDistance: c.chordDistance ?? c.ChordDistance ?? null,
    }));

    if (stations.length < 2 && adjusted.length < 2)
      return res.status(400).send('At least 2 stations are required to generate a DXF.');

    const meta = {
      parcel: body.parcel ?? body.Parcel ?? null,
      county: body.county ?? body.County ?? null,
      state: body.state ?? body.State ?? null,
      units: body.units ?? body.Units ?? 'Feet',
      areaAcres: body.areaAcres ?? body.AreaAcres ?? 0,
      perimeter: body.perimeter ?? body.Perimeter ?? 0,
      basisOfBearings: body.basisOfBearings ?? body.BasisOfBearings ?? null,
    };

    // Fix #1: Pass bustCourseIndex so the DXF generator can highlight the suspect course
    const bustCourseIndex = body.bustCourseIndex ?? body.BustCourseIndex ?? null;
    const dxfString = generateDxf(stations, adjusted, courses, meta, bustCourseIndex != null ? parseInt(bustCourseIndex) : null);

    let safeFileName = 'boundary_sketch.dxf';
    if (meta.parcel) safeFileName = meta.parcel.replace(/ /g, '_').replace(/\//g, '-') + '.dxf';

    res.setHeader('Content-Type', 'application/dxf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
    res.send(dxfString);
  } catch (ex) {
    res.status(400).json({ error: `DXF generation failed: ${ex.message}` });
  }
});

router.post('/combine', (req, res) => {
  try {
    const { parcels } = req.body;
    if (!parcels || !Array.isArray(parcels) || parcels.length === 0) {
      return res.status(400).send('An array of parcels is required.');
    }

    const processedParcels = parcels.map((parcel, idx) => {
      const stations = (parcel.stations ?? []).map(s => ({
        easting: s.easting ?? 0, northing: s.northing ?? 0,
        depDN: s.depDN ?? 0, depDE: s.depDE ?? 0,
      }));
      const adjusted = (parcel.adjusted ?? parcel.adjustedStations ?? []).map(s => ({
        easting: s.easting ?? 0, northing: s.northing ?? 0,
      }));
      const courses = (parcel.courses ?? []).map(c => ({
        type: c.type ?? 'Line',
        bearing: c.bearing ?? null,
        distance: c.distance ?? null,
        delta: c.delta ?? null,
        radius: c.radius ?? null,
        arcLength: c.arcLength ?? null,
        curveDirection: c.curveDirection ?? null,
        chordBearing: c.chordBearing ?? null,
        chordDistance: c.chordDistance ?? null,
      }));

      const meta = {
        parcelName: parcel.parcelName ?? parcel.fileName ?? `Parcel_${idx + 1}`,
        fileName: parcel.fileName ?? `Parcel_${idx + 1}`,
        county: parcel.county ?? null,
        state: parcel.state ?? null,
        units: parcel.units ?? 'Feet',
        areaAcres: parcel.areaAcres ?? 0,
        perimeter: parcel.perimeter ?? 0,
        basisOfBearings: parcel.basisOfBearings ?? null,
      };

      return {
        stations,
        adjustedStations: adjusted,
        courses,
        ...meta,
        referencePointName: parcel.referencePointName ?? null,
        referencePointNorthing: parcel.referencePointNorthing != null ? parseFloat(parcel.referencePointNorthing) : null,
        referencePointEasting: parcel.referencePointEasting != null ? parseFloat(parcel.referencePointEasting) : null,
        pobNorthing: parcel.pobNorthing != null ? parseFloat(parcel.pobNorthing) : null,
        pobEasting: parcel.pobEasting != null ? parseFloat(parcel.pobEasting) : null,
      };
    });

    const dxfString = generateCombinedDxf(processedParcels);

    res.setHeader('Content-Type', 'application/dxf');
    res.setHeader('Content-Disposition', 'attachment; filename="combined_parcels.dxf"');
    res.send(dxfString);
  } catch (ex) {
    res.status(400).json({ error: `Combined DXF generation failed: ${ex.message}` });
  }
});

export default router;
