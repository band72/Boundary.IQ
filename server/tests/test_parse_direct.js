// Clean test

// We want to test parseExtractionJson. Since it's not exported from deedTextSolver.js, 
// let's copy its implementation here to test it.
function parseExtractionJson(raw) {
  let text = raw.trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  // Robustly quote any unquoted property values
  try {
    // If cleanInvalidJsonValues is not exported, we can just parse it directly since raw is clean JSON
  } catch {}

  const root = JSON.parse(text);
  const segments = root.Segments || root.segments || root.courses || root.Courses || [];
  const pobRaw = root.POB || root.pob || root.PointOfBeginning || {};
  const pob = {
    northing: parseFloat(pobRaw.Northing ?? pobRaw.northing ?? 5000),
    easting:  parseFloat(pobRaw.Easting  ?? pobRaw.easting  ?? 5000),
  };

  const units = root.Units || root.units || 'Feet';
  const referencePointName = root.ReferencePointName || root.referencePointName || null;
  const rawCommSegments = root.CommencementSegments || root.commencementSegments || [];
  const commencementSegments = Array.isArray(rawCommSegments) ? rawCommSegments.map(s => {
    const type = (s.Type || s.type || 'Line');
    const bearing = s.Bearing ?? s.bearing ?? null;
    const distance = (s.Distance != null && !isNaN(parseFloat(s.Distance))) ? parseFloat(s.Distance) : null;
    const chordBearing = s.ChordBearing ?? s.chordBearing ?? null;
    const chordDistance = (s.ChordDistance != null && !isNaN(parseFloat(s.ChordDistance))) ? parseFloat(s.ChordDistance) : null;
    const radius = (s.Radius != null && !isNaN(parseFloat(s.Radius))) ? parseFloat(s.Radius) : null;
    const delta = s.Delta ?? s.delta ?? null;
    const arcLength = (s.ArcLength != null && !isNaN(parseFloat(s.ArcLength))) ? parseFloat(s.ArcLength) : null;
    const curveDirection = s.Direction ?? s.CurveDirection ?? s.curveDirection ?? null;
    return { type, bearing, distance, chordBearing, chordDistance, radius, delta, arcLength, curveDirection };
  }) : [];

  const courses = segments.map(s => {
    const type = (s.Type || s.type || 'Line');
    const bearing = s.Bearing ?? s.bearing ?? null;
    const distance = (s.Distance != null && !isNaN(parseFloat(s.Distance))) ? parseFloat(s.Distance) : null;
    const chordBearing = s.ChordBearing ?? s.chordBearing ?? null;
    const chordDistance = (s.ChordDistance != null && !isNaN(parseFloat(s.ChordDistance))) ? parseFloat(s.ChordDistance) : null;
    const radius = (s.Radius != null && !isNaN(parseFloat(s.Radius))) ? parseFloat(s.Radius) : null;
    const delta = s.Delta ?? s.delta ?? null;
    const arcLength = (s.ArcLength != null && !isNaN(parseFloat(s.ArcLength))) ? parseFloat(s.ArcLength) : null;
    const curveDirection = s.Direction ?? s.CurveDirection ?? s.curveDirection ?? null;

    let isUnknown = !!(s.IsUnknown ?? s.isUnknown ?? false);
    if (type.toLowerCase() === 'line') {
      isUnknown = isUnknown || !bearing || distance == null || distance === 0;
    } else {
      const hasChord = chordBearing && chordDistance != null && chordDistance !== 0;
      const hasParams = radius != null && delta != null;
      isUnknown = isUnknown || (!hasChord && !hasParams);
    }

    return {
      type,
      bearing,
      distance,
      isUnknown,
      chordBearing,
      chordDistance,
      radius,
      delta,
      arcLength,
      curveDirection,
    };
  });

  return { courses, pob, units, referencePointName, commencementSegments };
}

const rawResponse = `{
  "POB": { "Northing": 5000.00, "Easting": 5000.00 },
  "ReferencePointName": null,
  "CommencementSegments": [],
  "Units": "Feet",
  "Segments": [
    { "Type": "Line", "Bearing": "S54°40'00\\"W", "Distance": 458.10, "IsUnknown": false },
    {
      "Type": "Curve",
      "Radius": 424.73,
      "Delta": "93°62'00.00\\"",
      "ArcLength": 93.43,
      "CurveDirection": "Left",
      "ChordBearing": "S16°38'52\\"E",
      "ChordDistance": 93.43,
      "IsUnknown": false
    },
    { "Type": "Line", "Bearing": "S22°57'45\\"E", "Distance": 36.10, "IsUnknown": false },
    {
      "Type": "Curve",
      "Radius": 710.48,
      "Delta": "87°32'100.00\\"",
      "ArcLength": 87.28,
      "CurveDirection": "Left",
      "ChordBearing": "S63°30'55\\"W",
      "ChordDistance": 87.28,
      "IsUnknown": false
    },
    { "Type": "Line", "Bearing": "S64°40'00\\"W", "Distance": 51.39, "IsUnknown": false },
    { "Type": "Line", "Bearing": "S14°58'30\\"E", "Distance": 636.00, "IsUnknown": false },
    { "Type": "Line", "Bearing": "N52°46'44.44\\"E", "Distance": 602.68, "IsUnknown": false },
    { "Type": "Line", "Bearing": "N14°58'30\\"W", "Distance": 723.00, "IsUnknown": false }
  ]
}`;

console.log('Result:', JSON.stringify(parseExtractionJson(rawResponse), null, 2));
