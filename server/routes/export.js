import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  generateGeoJson,
  generateCombinedGeoJson,
  generateLandXml,
  generateCombinedLandXml
} from '../services/exportService.js';

const router = Router();
router.use(requireAuth);

router.post('/geojson', (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(400).send('Request body is required.');

    const stations = body.stations || body.Stations || [];
    const adjusted = body.adjusted || body.Adjusted || body.adjustedStations || body.AdjustedStations || [];
    const courses = body.courses || body.Courses || [];

    if (stations.length < 2 && adjusted.length < 2) {
      return res.status(400).send('At least 2 stations are required to generate GeoJSON.');
    }

    const meta = {
      parcel: body.parcel || body.Parcel || null,
      county: body.county || body.County || null,
      state: body.state || body.State || null,
      units: body.units || body.Units || 'Feet',
      areaAcres: body.areaAcres || body.AreaAcres || 0,
      perimeter: body.perimeter || body.Perimeter || 0,
      basisOfBearings: body.basisOfBearings || body.BasisOfBearings || null,
    };

    const geoJsonString = generateGeoJson(stations, adjusted, courses, meta);

    let safeFileName = 'boundary.geojson';
    if (meta.parcel) {
      safeFileName = meta.parcel.replace(/ /g, '_').replace(/\//g, '-') + '.geojson';
    }

    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
    res.send(geoJsonString);
  } catch (ex) {
    res.status(400).json({ error: `GeoJSON generation failed: ${ex.message}` });
  }
});

router.post('/geojson/combine', (req, res) => {
  try {
    const { parcels } = req.body;
    if (!parcels || !Array.isArray(parcels) || parcels.length === 0) {
      return res.status(400).send('An array of parcels is required.');
    }

    const geoJsonString = generateCombinedGeoJson(parcels);

    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Content-Disposition', 'attachment; filename="combined_parcels.geojson"');
    res.send(geoJsonString);
  } catch (ex) {
    res.status(400).json({ error: `Combined GeoJSON generation failed: ${ex.message}` });
  }
});

router.post('/landxml', (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(400).send('Request body is required.');

    const stations = body.stations || body.Stations || [];
    const adjusted = body.adjusted || body.Adjusted || body.adjustedStations || body.AdjustedStations || [];
    const courses = body.courses || body.Courses || [];

    if (stations.length < 2 && adjusted.length < 2) {
      return res.status(400).send('At least 2 stations are required to generate LandXML.');
    }

    const meta = {
      parcel: body.parcel || body.Parcel || null,
      county: body.county || body.County || null,
      state: body.state || body.State || null,
      units: body.units || body.Units || 'Feet',
      areaAcres: body.areaAcres || body.AreaAcres || 0,
      perimeter: body.perimeter || body.Perimeter || 0,
      basisOfBearings: body.basisOfBearings || body.BasisOfBearings || null,
    };

    const xmlString = generateLandXml(stations, adjusted, courses, meta);

    let safeFileName = 'boundary.xml';
    if (meta.parcel) {
      safeFileName = meta.parcel.replace(/ /g, '_').replace(/\//g, '-') + '.xml';
    }

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
    res.send(xmlString);
  } catch (ex) {
    res.status(400).json({ error: `LandXML generation failed: ${ex.message}` });
  }
});

router.post('/landxml/combine', (req, res) => {
  try {
    const { parcels } = req.body;
    if (!parcels || !Array.isArray(parcels) || parcels.length === 0) {
      return res.status(400).send('An array of parcels is required.');
    }

    const xmlString = generateCombinedLandXml(parcels);

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'attachment; filename="combined_parcels.xml"');
    res.send(xmlString);
  } catch (ex) {
    res.status(400).json({ error: `Combined LandXML generation failed: ${ex.message}` });
  }
});

export default router;
