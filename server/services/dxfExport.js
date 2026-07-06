import fs from 'fs';
import path from 'path';

class Drawing {
  static ACI = {
    RED: 1,
    YELLOW: 2,
    GREEN: 3,
    CYAN: 4,
    BLUE: 5,
    MAGENTA: 6,
    WHITE: 7
  };

  constructor() {
    this.layers = {};
    this.activeLayer = '0';
    this.entities = [];
    this.addLayer('0', 7);
  }

  addLayer(name, color, lineType = 'CONTINUOUS') {
    let colorVal = 7;
    if (typeof color === 'number') {
      colorVal = color;
    } else if (color && typeof color === 'string') {
      colorVal = Drawing.ACI[color.toUpperCase()] || 7;
    } else if (color && color.value !== undefined) {
      colorVal = color.value;
    }
    
    this.layers[name] = {
      color: colorVal,
      lineType: String(lineType || 'CONTINUOUS').toUpperCase() === 'DASHED' ? 'DASHED' : 'CONTINUOUS'
    };
    return this;
  }

  setActiveLayer(name) {
    this.activeLayer = name;
    if (!this.layers[name]) {
      this.addLayer(name, 7);
    }
    return this;
  }

  drawCircle(x, y, radius) {
    this.entities.push({
      type: 'CIRCLE',
      layer: this.activeLayer,
      x: parseFloat(x) || 0,
      y: parseFloat(y) || 0,
      r: parseFloat(radius) || 1
    });
    return this;
  }

  drawText(x, y, height, rotation, text) {
    this.entities.push({
      type: 'TEXT',
      layer: this.activeLayer,
      x: parseFloat(x) || 0,
      y: parseFloat(y) || 0,
      height: parseFloat(height) || 1,
      rotation: parseFloat(rotation) || 0,
      text: String(text || '')
    });
    return this;
  }

  drawLine(x1, y1, x2, y2) {
    this.entities.push({
      type: 'LINE',
      layer: this.activeLayer,
      x1: parseFloat(x1) || 0,
      y1: parseFloat(y1) || 0,
      x2: parseFloat(x2) || 0,
      y2: parseFloat(y2) || 0
    });
    return this;
  }

  drawPolyline(points, closed = false) {
    this.entities.push({
      type: 'POLYLINE',
      layer: this.activeLayer,
      points: points.map(pt => ({ x: parseFloat(pt[0]) || 0, y: parseFloat(pt[1]) || 0 })),
      closed: !!closed
    });
    return this;
  }

  toDxfString() {
    const lines = [];

    // ── HEADER SECTION ──────────────────────────────────────────────────────────
    lines.push('  0', 'SECTION');
    lines.push('  2', 'HEADER');
    lines.push('  9', '$ACADVER');
    lines.push('  1', 'AC1009'); // AutoCAD R12 (most compatible)
    lines.push('  9', '$INSUNITS');
    lines.push(' 70', '2'); // 2 = feet
    lines.push('  0', 'ENDSEC');

    // ── TABLES SECTION ──────────────────────────────────────────────────────────
    lines.push('  0', 'SECTION');
    lines.push('  2', 'TABLES');
    
    // LAYER TABLE
    lines.push('  0', 'TABLE');
    lines.push('  2', 'LAYER');
    lines.push(' 70', String(Object.keys(this.layers).length));
    
    for (const [name, lyr] of Object.entries(this.layers)) {
      lines.push('  0', 'LAYER');
      lines.push('  2', name.toUpperCase());
      lines.push(' 70', '0');
      lines.push(' 62', String(lyr.color));
      lines.push('  6', lyr.lineType);
    }
    
    lines.push('  0', 'ENDTAB');
    
    // LTYPE TABLE
    lines.push('  0', 'TABLE');
    lines.push('  2', 'LTYPE');
    lines.push(' 70', '2');
    
    // Continuous
    lines.push('  0', 'LTYPE');
    lines.push('  2', 'CONTINUOUS');
    lines.push(' 70', '64');
    lines.push('  3', 'Solid line');
    lines.push(' 72', '65');
    lines.push(' 73', '0');
    lines.push(' 40', '0.0');
    
    // Dashed
    lines.push('  0', 'LTYPE');
    lines.push('  2', 'DASHED');
    lines.push(' 70', '64');
    lines.push('  3', 'Dashed __ __ __ __ __ __ __ __ __ __ __ __ __ _');
    lines.push(' 72', '65');
    lines.push(' 73', '2');
    lines.push(' 40', '0.75');
    lines.push(' 49', '0.5');
    lines.push(' 49', '-0.25');
    
    lines.push('  0', 'ENDTAB');
    lines.push('  0', 'ENDSEC');

    // ── BLOCKS SECTION (empty but required for older AutoCAD compatibility) ───────
    lines.push('  0', 'SECTION');
    lines.push('  2', 'BLOCKS');
    lines.push('  0', 'ENDSEC');

    // ── ENTITIES SECTION ────────────────────────────────────────────────────────
    lines.push('  0', 'SECTION');
    lines.push('  2', 'ENTITIES');

    for (const ent of this.entities) {
      if (ent.type === 'CIRCLE') {
        lines.push('  0', 'CIRCLE');
        lines.push('  8', ent.layer.toUpperCase());
        lines.push(' 10', ent.x.toFixed(3));
        lines.push(' 20', ent.y.toFixed(3));
        lines.push(' 30', '0.000');
        lines.push(' 40', ent.r.toFixed(3));
      } else if (ent.type === 'TEXT') {
        lines.push('  0', 'TEXT');
        lines.push('  8', ent.layer.toUpperCase());
        lines.push(' 10', ent.x.toFixed(3));
        lines.push(' 20', ent.y.toFixed(3));
        lines.push(' 30', '0.000');
        lines.push(' 40', ent.height.toFixed(3));
        lines.push('  1', ent.text);
        if (Math.abs(ent.rotation) > 0.0001) {
          lines.push(' 50', ent.rotation.toFixed(3));
        }
      } else if (ent.type === 'LINE') {
        lines.push('  0', 'LINE');
        lines.push('  8', ent.layer.toUpperCase());
        lines.push(' 10', ent.x1.toFixed(3));
        lines.push(' 20', ent.y1.toFixed(3));
        lines.push(' 30', '0.000');
        lines.push(' 11', ent.x2.toFixed(3));
        lines.push(' 21', ent.y2.toFixed(3));
        lines.push(' 31', '0.000');
      } else if (ent.type === 'POLYLINE') {
        lines.push('  0', 'POLYLINE');
        lines.push('  8', ent.layer.toUpperCase());
        lines.push(' 66', '1');
        lines.push(' 70', ent.closed ? '1' : '0');
        lines.push(' 10', '0.000');
        lines.push(' 20', '0.000');
        lines.push(' 30', '0.000');

        for (const pt of ent.points) {
          lines.push('  0', 'VERTEX');
          lines.push('  8', ent.layer.toUpperCase());
          lines.push(' 10', pt.x.toFixed(3));
          lines.push(' 20', pt.y.toFixed(3));
          lines.push(' 30', '0.000');
        }
        lines.push('  0', 'SEQEND');
      }
    }

    lines.push('  0', 'ENDSEC');
    lines.push('  0', 'EOF');

    return lines.join('\n');
  }
}

// NCS Layer Names
const LAYER_BOUNDARY = 'C-PROP-LINE';     // Red, continuous
const LAYER_TEXT     = 'C-PROP-ANNO';     // Cyan, continuous
const LAYER_POINTS   = 'C-PROP-NODE';     // Green, continuous
const LAYER_ANNOT    = 'C-PROP-MISC';     // White, continuous
const LAYER_ERROR    = 'C-PROP-ERR-LINE'; // Red, dashed (for misclosure gap)
const LAYER_BUST     = 'C-PROP-BUST';     // Magenta, dashed (Fix #1 — OCR bust candidate)

export function safeText(str) {
  if (typeof str !== 'string') {
    if (str === null || str === undefined) return '';
    return String(str);
  }
  return str
    .replace(/[\r\n]+/g, ' ')
    .replace(/°/g, '%%d')
    .replace(/Δ/g, 'Delta=')
    .replace(/◄/g, '<-')
    .replace(/—/g, '-')
    .replace(/[^\x20-\x7E]/g, '');
}

export function getSafeCoord(val) {
  const num = parseFloat(val);
  return (Number.isNaN(num) || !Number.isFinite(num)) ? 0 : num;
}

/**
 * Generate a DXF string from traverse results.
 * @param {object[]} stations
 * @param {object[]} adjusted
 * @param {object[]} courses
 * @param {object} meta
 * @param {number|null} bustCourseIndex  Fix #1: 0-based index of the OCR bust candidate course, or null
 * @returns {string} DXF file content
 */
export function generateDxf(stations, adjusted, courses, meta, bustCourseIndex = null) {
  // Prefer adjusted stations; fall back to raw
  const pts = (adjusted?.length >= 2)
    ? adjusted.map(r => ({ x: getSafeCoord(r.easting), y: getSafeCoord(r.northing) }))
    : (stations?.length >= 2 ? stations.map(r => ({ x: getSafeCoord(r.easting), y: getSafeCoord(r.northing) })) : null);

  if (!pts || pts.length < 2)
    throw new Error('Need at least 2 stations to generate DXF.');

  const d = new Drawing();

  // Bounding box calculation for dynamic scaling
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const maxRange = Math.max(rangeX, rangeY) || 1.0;

  // Dynamic Scale Coefficients (Surveyor Draft Aesthetics)
  const textScale = Math.max(maxRange * 0.015, 1.2);
  const nodeRadius = textScale * 0.25;
  const offsetDistance = textScale * 0.85;

  // Setup NCS-compliant layers
  d.addLayer(LAYER_BOUNDARY, Drawing.ACI.RED, 'CONTINUOUS');
  d.addLayer(LAYER_TEXT,     Drawing.ACI.CYAN, 'CONTINUOUS');
  d.addLayer(LAYER_POINTS,   Drawing.ACI.GREEN, 'CONTINUOUS');
  d.addLayer(LAYER_ANNOT,    Drawing.ACI.WHITE, 'CONTINUOUS');
  d.addLayer(LAYER_ERROR,    Drawing.ACI.RED, 'DASHED');
  d.addLayer(LAYER_BUST,     Drawing.ACI.MAGENTA, 'DASHED');  // Fix #1

  let lineCount = 0, curveCount = 0;

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const p1 = i < pts.length ? pts[i] : pts[pts.length - 1];
    const p2 = (i + 1) < pts.length ? pts[i + 1] : pts[0];

    // Compute unit progress and perpendicular vectors
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1e-9;

    // Perpendicular vector pushed left (outwards for clockwise traverse)
    const perpX = -dy / len * offsetDistance;
    const perpY = dx / len * offsetDistance;

    // Fix #1: Determine active boundary layer for this course
    const isBustCourse = bustCourseIndex != null && i === bustCourseIndex;
    const activeBoundaryLayer = isBustCourse ? LAYER_BUST : LAYER_BOUNDARY;

    // Corner pin marker
    const cornerLbl = i === 0 ? 'POB' : `PT-${i + 1}`;
    d.setActiveLayer(LAYER_POINTS);
    d.drawCircle(p1.x, p1.y, nodeRadius);
    // Offset corner point text slightly
    d.drawText(p1.x + nodeRadius * 1.5, p1.y + nodeRadius * 1.5, textScale * 0.9, 0, safeText(cornerLbl));

    if ((course.type || '').toLowerCase() !== 'curve') {
      // ── Line segment
      lineCount++;
      d.setActiveLayer(activeBoundaryLayer);
      const heavyWidth = textScale * 0.12;
      d.drawPolyline([[p1.x, p1.y], [p2.x, p2.y]], false, heavyWidth, heavyWidth);

      // Midpoint perpendicular offset for clean labeling
      const midX = (p1.x + p2.x) / 2 + perpX;
      const midY = (p1.y + p2.y) / 2 + perpY;

      const brg = course.bearing || '??';
      const dist = course.distance != null ? `${course.distance.toFixed(2)}'` : '?';
      const bustTag = isBustCourse ? ' ◄ OCR BUST?' : '';
      const lbl = `L${lineCount}  ${brg}  ${dist}${bustTag}`;

      // Align text parallel to line segment and ensure it is never upside down
      const azRad = Math.atan2(dx, dy);
      let angDeg = 90.0 - azRad * 180.0 / Math.PI;
      while (angDeg > 90) angDeg -= 180;
      while (angDeg < -90) angDeg += 180;

      d.setActiveLayer(LAYER_TEXT);
      d.drawText(midX, midY - (textScale * 0.4), textScale, angDeg, safeText(lbl));

      // Fix #1: Extra bust label on a second offset line for visibility
      if (isBustCourse) {
        d.setActiveLayer(LAYER_BUST);
        d.drawText(midX, midY + (textScale * 0.5), textScale * 0.9, angDeg, safeText('OCR BUST CANDIDATE'));
      }
    } else {
      // ── Arc segment
      curveCount++;
      const r = getSafeCoord(course.radius);
      let solved = false;

      if (r > 0.001) {
        try {
          const cx = (p1.x + p2.x) / 2;
          const cy = (p1.y + p2.y) / 2;
          const chord = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
          const halfChord = chord / 2;
          let dSq = r * r - halfChord * halfChord;
          if (dSq < 0) dSq = 0;
          const dd = Math.sqrt(dSq);

          const chordLen = chord > 1e-9 ? chord : 1e-9;
          const perpChordX = -(p2.y - p1.y) / chordLen;
          const perpChordY = (p2.x - p1.x) / chordLen;

          const curveLeft = (course.curveDirection || '').toLowerCase() === 'left';
          const sign = curveLeft ? 1 : -1;
          const centX = cx + sign * perpChordX * dd;
          const centY = cy + sign * perpChordY * dd;

          let startAng = Math.atan2(p1.y - centY, p1.x - centX) * 180 / Math.PI;
          let endAng = Math.atan2(p2.y - centY, p2.x - centX) * 180 / Math.PI;
          if (startAng < 0) startAng += 360;
          if (endAng < 0) endAng += 360;

          if (!curveLeft) { [startAng, endAng] = [endAng, startAng]; }

          d.setActiveLayer(activeBoundaryLayer);
          const heavyWidth = textScale * 0.12;
          const arcPoints = [];
          const numSteps = Math.max(16, Math.min(100, Math.ceil((r * Math.abs(endAng - startAng) * Math.PI / 180) / (textScale * 0.4))));
          let startRad = startAng * Math.PI / 180;
          let endRad = endAng * Math.PI / 180;
          let diffRad = endRad - startRad;
          if (diffRad < 0) diffRad += 2 * Math.PI;
          for (let step = 0; step <= numSteps; step++) {
            const currentRad = startRad + (diffRad * step / numSteps);
            arcPoints.push([centX + r * Math.cos(currentRad), centY + r * Math.sin(currentRad)]);
          }
          d.drawPolyline(arcPoints, false, heavyWidth, heavyWidth);

          // Curve label midpoints & aligned chord angle
          const midX = cx + perpX;
          const midY = cy + perpY;

          const delta = course.delta != null ? `Δ=${course.delta.toFixed(2)}°` : '';
          const arcL = course.arcLength != null ? `L=${course.arcLength.toFixed(2)}'` : '';
          const radS = `R=${r.toFixed(2)}'`;
          const chd = course.chordDistance != null ? `CH=${course.chordDistance.toFixed(2)}'` : '';
          const bustTag = isBustCourse ? ' ◄ BUST?' : '';
          const curveLbl = `C${curveCount}  ${delta}  ${arcL}  ${radS}  ${chd}${bustTag}`.trim();

          const chordAzRad = Math.atan2(dx, dy);
          let chordAngDeg = 90.0 - chordAzRad * 180.0 / Math.PI;
          while (chordAngDeg > 90) chordAngDeg -= 180;
          while (chordAngDeg < -90) chordAngDeg += 180;

          d.setActiveLayer(LAYER_TEXT);
          d.drawText(midX, midY - (textScale * 0.4), textScale * 0.9, chordAngDeg, safeText(curveLbl));
          solved = true;
        } catch { /* fall through to chord fallback */ }
      }

      if (!solved) {
        d.setActiveLayer(activeBoundaryLayer);
        const heavyWidth = textScale * 0.12;
        d.drawPolyline([[p1.x, p1.y], [p2.x, p2.y]], false, heavyWidth, heavyWidth);
        const midX = (p1.x + p2.x) / 2 + perpX;
        const midY = (p1.y + p2.y) / 2 + perpY;

        const chordAzRad = Math.atan2(dx, dy);
        let chordAngDeg = 90.0 - chordAzRad * 180.0 / Math.PI;
        while (chordAngDeg > 90) chordAngDeg -= 180;
        while (chordAngDeg < -90) chordAngDeg += 180;

        d.setActiveLayer(LAYER_TEXT);
        d.drawText(midX, midY - (textScale * 0.4), textScale * 0.9, chordAngDeg, safeText(`C${curveCount} [CHORD-APPROX]`));
      }
    }
  }

  // Draw visual error misclosure gap line
  const lastPt = pts[pts.length - 1];
  const firstPt = pts[0];
  const closeGap = Math.hypot(lastPt.y - firstPt.y, lastPt.x - firstPt.x);
  if (closeGap > 0.05) {
    d.setActiveLayer(LAYER_ERROR);
    d.drawLine(lastPt.x, lastPt.y, firstPt.x, firstPt.y);

    const errMidX = (lastPt.x + firstPt.x) / 2;
    const errMidY = (lastPt.y + firstPt.y) / 2;
    const errDx = firstPt.x - lastPt.x;
    const errDy = firstPt.y - lastPt.y;
    const errLen = Math.hypot(errDx, errDy) || 1e-9;
    const errPerpX = -errDy / errLen * offsetDistance;
    const errPerpY = errDx / errLen * offsetDistance;

    d.setActiveLayer(LAYER_TEXT);
    d.drawText(errMidX + errPerpX, errMidY + errPerpY, textScale * 0.85, 0, safeText(`MISCLOSURE GAP: ${closeGap.toFixed(4)}'`));

    // Fix #6: Arrowhead at the closure endpoint showing direction of travel to close
    const arrowTip = { x: firstPt.x, y: firstPt.y };
    const arrowLen = textScale * 1.8;
    const arrowHalfAngle = 20.0 * Math.PI / 180.0;
    // Reverse direction (toward lastPt from firstPt) for arrowhead wings
    const revAz = Math.atan2(-errDy, -errDx);
    d.setActiveLayer(LAYER_ERROR);
    d.drawLine(arrowTip.x, arrowTip.y,
      arrowTip.x + arrowLen * Math.cos(revAz + arrowHalfAngle),
      arrowTip.y + arrowLen * Math.sin(revAz + arrowHalfAngle));
    d.drawLine(arrowTip.x, arrowTip.y,
      arrowTip.x + arrowLen * Math.cos(revAz - arrowHalfAngle),
      arrowTip.y + arrowLen * Math.sin(revAz - arrowHalfAngle));
  }

  // Closing POB node circle
  d.setActiveLayer(LAYER_POINTS);
  d.drawCircle(pts[0].x, pts[0].y, nodeRadius * 1.5);

  // Annotations North Arrow
  d.setActiveLayer(LAYER_ANNOT);
  const naX = maxX + rangeX * 0.08 + (textScale * 5);
  const naY = maxY;
  const naLen = textScale * 6;
  d.drawLine(naX, naY - naLen, naX, naY + naLen);
  // Arrowheads
  d.drawLine(naX, naY + naLen, naX - (textScale * 1.2), naY + (textScale * 3.5));
  d.drawLine(naX, naY + naLen, naX + (textScale * 1.2), naY + (textScale * 3.5));
  d.drawText(naX - (textScale * 0.6), naY + naLen + (textScale * 1.5), textScale * 2.0, 0, safeText('N'));

  // Scale bar
  let sbLen = Math.round(maxRange / 4 / 10) * 10;
  if (Number.isNaN(sbLen) || !Number.isFinite(sbLen) || sbLen < 10) sbLen = 10;
  const sbX = minX;
  const sbY = minY - rangeY * 0.08 - (textScale * 5);
  d.drawLine(sbX, sbY, sbX + sbLen, sbY);
  d.drawLine(sbX, sbY, sbX, sbY + textScale * 1.2);
  d.drawLine(sbX + sbLen / 2, sbY, sbX + sbLen / 2, sbY + textScale * 1.2);
  d.drawLine(sbX + sbLen, sbY, sbX + sbLen, sbY + textScale * 1.2);
  d.drawText(sbX, sbY - (textScale * 1.8), textScale * 0.85, 0, safeText('0'));
  d.drawText(sbX + sbLen / 2, sbY - (textScale * 1.8), textScale * 0.85, 0, safeText(`${sbLen / 2}`));
  d.drawText(sbX + sbLen, sbY - (textScale * 1.8), textScale * 0.85, 0, safeText(`${sbLen} ${meta.units || 'Feet'}`));

  // NCS Surveyor Title block
  const tbX = maxX + rangeX * 0.08 + (textScale * 1.5);
  const tbY = minY;
  const ts = textScale * 1.1;
  const titleLines = [
    'BOUNDARY.IQ PLATFORM',
    `PARCEL: ${safeText(meta.parcel || 'SUBJECT PARCEL')}`,
    `COUNTY: ${safeText(meta.county || '-')}`,
    `STATE:  ${safeText(meta.state || '-')}`,
    `AREA:   ${(getSafeCoord(meta.areaAcres) || 0).toFixed(4)} AC`,
    `PERIM:  ${(getSafeCoord(meta.perimeter) || 0).toFixed(2)} FT`,
    `BASIS:  ${safeText(meta.basisOfBearings || 'DEED OF RECORD')}`,
    `DATE:   ${new Date().toISOString().slice(0, 10)}`,
    'MATH COMPILATION ONLY.',
    'NO FIELD SURVEY PERFORMED.',
  ];
  if (bustCourseIndex != null) {
    titleLines.push(`WARN: COURSE ${bustCourseIndex + 1} FLAGGED - OCR BUST CANDIDATE`);
  }
  for (let ti = 0; ti < titleLines.length; ti++) {
    d.drawText(tbX, tbY + ti * ts * 1.6, ts, 0, safeText(titleLines[ti]));
  }

  return d.toDxfString();
}

/**
 * Generate a combined DXF string containing multiple spatially-positioned parcels.
 * Each parcel is drawn relative to its own POB coordinates (which are spatially aligned).
 * Parcels are organized into distinct layers prefixed by their names.
 * @param {object[]} parcels - Array of parcel objects
 * @returns {string} Combined DXF file content
 */
export function generateCombinedDxf(parcels) {
  if (!parcels || parcels.length === 0)
    throw new Error('No parcels provided to combine.');

  const d = new Drawing();

  // Bounding box calculation for the overall group of parcels
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let totalPerimeter = 0;
  let totalArea = 0;
  let hasValidPt = false;

  for (const parcel of parcels) {
    const stations = parcel.adjustedStations || parcel.stations || [];
    const pts = stations.map(s => ({ x: getSafeCoord(s.easting), y: getSafeCoord(s.northing) }));
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      hasValidPt = true;
    }
    totalPerimeter += getSafeCoord(parcel.perimeter) || 0;
    totalArea += getSafeCoord(parcel.areaAcres) || 0;
  }

  if (!hasValidPt)
    throw new Error('No valid station coordinates found in any parcel.');

  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const maxRange = Math.max(rangeX, rangeY) || 1.0;

  // Group Dynamic Scale Coefficients
  const textScale = Math.max(maxRange * 0.015, 1.2);
  const nodeRadius = textScale * 0.25;
  const offsetDistance = textScale * 0.85;

  // Standard group annotation layer
  d.addLayer(LAYER_ANNOT, Drawing.ACI.WHITE, 'CONTINUOUS');

  // Cycle through distinct ACI color indexes for clean boundary visual separation
  const colors = [
    Drawing.ACI.RED,
    Drawing.ACI.YELLOW,
    Drawing.ACI.GREEN,
    Drawing.ACI.CYAN,
    Drawing.ACI.BLUE,
    Drawing.ACI.MAGENTA,
  ];

  parcels.forEach((parcel, parcelIdx) => {
    // Generate clean safe name for layer naming
    const rawName = parcel.parcelName || parcel.fileName || `PARCEL_${parcelIdx + 1}`;
    const safeName = rawName.replace(/[^a-zA-Z0-9_\-]/g, '_').toUpperCase();

    // Define unique layer names for this parcel
    const layerBoundary = `C-PROP-LINE-${safeName}`;
    const layerText = `C-PROP-ANNO-${safeName}`;
    const layerPoints = `C-PROP-NODE-${safeName}`;
    const layerError = `C-PROP-ERR-${safeName}`;

    // Select color for this parcel boundary (cycle through colors)
    const boundaryColor = colors[parcelIdx % colors.length];

    d.addLayer(layerBoundary, boundaryColor, 'CONTINUOUS');
    d.addLayer(layerText, Drawing.ACI.CYAN, 'CONTINUOUS');
    d.addLayer(layerPoints, Drawing.ACI.GREEN, 'CONTINUOUS');
    d.addLayer(layerError, Drawing.ACI.RED, 'DASHED');

    const stations = parcel.adjustedStations || parcel.stations || [];
    const pts = stations.map(s => ({ x: getSafeCoord(s.easting), y: getSafeCoord(s.northing) }));
    const courses = parcel.courses || [];

    if (pts.length < 2) return;

    let lineCount = 0, curveCount = 0;

    for (let i = 0; i < courses.length; i++) {
      const course = courses[i];
      const p1 = i < pts.length ? pts[i] : pts[pts.length - 1];
      const p2 = (i + 1) < pts.length ? pts[i + 1] : pts[0];

      // Unit and perp vectors for annotation offset
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1e-9;
      const perpX = -dy / len * offsetDistance;
      const perpY = dx / len * offsetDistance;

      // Draw corner point marker
      const cornerLbl = i === 0 ? `POB-${safeName}` : `PT-${i + 1}-${safeName}`;
      d.setActiveLayer(layerPoints);
      d.drawCircle(p1.x, p1.y, nodeRadius);
      d.drawText(p1.x + nodeRadius * 1.5, p1.y + nodeRadius * 1.5, textScale * 0.8, 0, safeText(cornerLbl));

      if ((course.type || '').toLowerCase() !== 'curve') {
        // Draw line
        lineCount++;
        d.setActiveLayer(layerBoundary);
        const heavyWidth = textScale * 0.12;
        d.drawPolyline([[p1.x, p1.y], [p2.x, p2.y]], false, heavyWidth, heavyWidth);

        const midX = (p1.x + p2.x) / 2 + perpX;
        const midY = (p1.y + p2.y) / 2 + perpY;

        const brg = course.bearing || '??';
        const dist = course.distance != null ? `${course.distance.toFixed(2)}'` : '?';
        const lbl = `L${lineCount}  ${brg}  ${dist}`;

        // Text rotation alignment
        const azRad = Math.atan2(dx, dy);
        let angDeg = 90.0 - azRad * 180.0 / Math.PI;
        while (angDeg > 90) angDeg -= 180;
        while (angDeg < -90) angDeg += 180;

        d.setActiveLayer(layerText);
        d.drawText(midX, midY - (textScale * 0.4), textScale, angDeg, safeText(lbl));
      } else {
        // Draw curve
        curveCount++;
        const r = getSafeCoord(course.radius);
        let solved = false;

        if (r > 0.001) {
          try {
            const cx = (p1.x + p2.x) / 2;
            const cy = (p1.y + p2.y) / 2;
            const chord = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
            const halfChord = chord / 2;
            let dSq = r * r - halfChord * halfChord;
            if (dSq < 0) dSq = 0;
            const dd = Math.sqrt(dSq);

            const chordLen = chord > 1e-9 ? chord : 1e-9;
            const perpChordX = -(p2.y - p1.y) / chordLen;
            const perpChordY = (p2.x - p1.x) / chordLen;

            const curveLeft = (course.curveDirection || '').toLowerCase() === 'left';
            const sign = curveLeft ? 1 : -1;
            const centX = cx + sign * perpChordX * dd;
            const centY = cy + sign * perpChordY * dd;

            let startAng = Math.atan2(p1.y - centY, p1.x - centX) * 180 / Math.PI;
            let endAng = Math.atan2(p2.y - centY, p2.x - centX) * 180 / Math.PI;
            if (startAng < 0) startAng += 360;
            if (endAng < 0) endAng += 360;

            if (!curveLeft) { [startAng, endAng] = [endAng, startAng]; }

            d.setActiveLayer(layerBoundary);
            const heavyWidth = textScale * 0.12;
            const arcPoints = [];
            const numSteps = Math.max(16, Math.min(100, Math.ceil((r * Math.abs(endAng - startAng) * Math.PI / 180) / (textScale * 0.4))));
            let startRad = startAng * Math.PI / 180;
            let endRad = endAng * Math.PI / 180;
            let diffRad = endRad - startRad;
            if (diffRad < 0) diffRad += 2 * Math.PI;
            for (let step = 0; step <= numSteps; step++) {
              const currentRad = startRad + (diffRad * step / numSteps);
              arcPoints.push([centX + r * Math.cos(currentRad), centY + r * Math.sin(currentRad)]);
            }
            d.drawPolyline(arcPoints, false, heavyWidth, heavyWidth);

            const midX = cx + perpX;
            const midY = cy + perpY;

            const delta = course.delta != null ? `Δ=${course.delta.toFixed(2)}°` : '';
            const arcL = course.arcLength != null ? `L=${course.arcLength.toFixed(2)}'` : '';
            const radS = `R=${r.toFixed(2)}'`;
            const chd = course.chordDistance != null ? `CH=${course.chordDistance.toFixed(2)}'` : '';
            const curveLbl = `C${curveCount}  ${delta}  ${arcL}  ${radS}  ${chd}`.trim();

            const chordAzRad = Math.atan2(dx, dy);
            let chordAngDeg = 90.0 - chordAzRad * 180.0 / Math.PI;
            while (chordAngDeg > 90) chordAngDeg -= 180;
            while (chordAngDeg < -90) chordAngDeg += 180;

            d.setActiveLayer(layerText);
            d.drawText(midX, midY - (textScale * 0.4), textScale * 0.9, chordAngDeg, safeText(curveLbl));
            solved = true;
          } catch { /* fallback to chord */ }
        }

        if (!solved) {
          d.setActiveLayer(layerBoundary);
          const heavyWidth = textScale * 0.12;
          d.drawPolyline([[p1.x, p1.y], [p2.x, p2.y]], false, heavyWidth, heavyWidth);
          const midX = (p1.x + p2.x) / 2 + perpX;
          const midY = (p1.y + p2.y) / 2 + perpY;

          const chordAzRad = Math.atan2(dx, dy);
          let chordAngDeg = 90.0 - chordAzRad * 180.0 / Math.PI;
          while (chordAngDeg > 90) chordAngDeg -= 180;
          while (chordAngDeg < -90) chordAngDeg += 180;

          d.setActiveLayer(layerText);
          d.drawText(midX, midY - (textScale * 0.4), textScale * 0.9, chordAngDeg, safeText(`C${curveCount} [CHORD-APPROX]`));
        }
      }
    }

    // Draw visual error misclosure gap line per parcel
    const lastPt = pts[pts.length - 1];
    const firstPt = pts[0];
    const closeGap = Math.hypot(lastPt.y - firstPt.y, lastPt.x - firstPt.x);
    if (closeGap > 0.05) {
      d.setActiveLayer(layerError);
      d.drawLine(lastPt.x, lastPt.y, firstPt.x, firstPt.y);

      const errMidX = (lastPt.x + firstPt.x) / 2;
      const errMidY = (lastPt.y + firstPt.y) / 2;
      const errDx = firstPt.x - lastPt.x;
      const errDy = firstPt.y - lastPt.y;
      const errLen = Math.hypot(errDx, errDy) || 1e-9;
      const errPerpX = -errDy / errLen * offsetDistance;
      const errPerpY = errDx / errLen * offsetDistance;

      d.setActiveLayer(layerText);
      d.drawText(errMidX + errPerpX, errMidY + errPerpY, textScale * 0.75, 0, safeText(`${safeName} GAP: ${closeGap.toFixed(4)}'`));
    }

    // Closing POB node circle
    d.setActiveLayer(layerPoints);
    d.drawCircle(pts[0].x, pts[0].y, nodeRadius * 1.5);
  });

  // Annotations North Arrow
  d.setActiveLayer(LAYER_ANNOT);
  const naX = maxX + rangeX * 0.08 + (textScale * 5);
  const naY = maxY;
  const naLen = textScale * 6;
  d.drawLine(naX, naY - naLen, naX, naY + naLen);
  d.drawLine(naX, naY + naLen, naX - (textScale * 1.2), naY + (textScale * 3.5));
  d.drawLine(naX, naY + naLen, naX + (textScale * 1.2), naY + (textScale * 3.5));
  d.drawText(naX - (textScale * 0.6), naY + naLen + (textScale * 1.5), textScale * 2.0, 0, safeText('N'));

  // Scale bar
  let sbLen = Math.round(maxRange / 4 / 10) * 10;
  if (Number.isNaN(sbLen) || !Number.isFinite(sbLen) || sbLen < 10) sbLen = 10;
  const sbX = minX;
  const sbY = minY - rangeY * 0.08 - (textScale * 5);
  d.drawLine(sbX, sbY, sbX + sbLen, sbY);
  d.drawLine(sbX, sbY, sbX, sbY + textScale * 1.2);
  d.drawLine(sbX + sbLen / 2, sbY, sbX + sbLen / 2, sbY + textScale * 1.2);
  d.drawLine(sbX + sbLen, sbY, sbX + sbLen, sbY + textScale * 1.2);
  d.drawText(sbX, sbY - (textScale * 1.8), textScale * 0.85, 0, safeText('0'));
  d.drawText(sbX + sbLen / 2, sbY - (textScale * 1.8), textScale * 0.85, 0, safeText(`${sbLen / 2}`));
  d.drawText(sbX + sbLen, sbY - (textScale * 1.8), textScale * 0.85, 0, safeText(`${sbLen} Feet`));

  // Combined Surveyor Title block
  const tbX = maxX + rangeX * 0.08 + (textScale * 1.5);
  const tbY = minY;
  const ts = textScale * 1.1;
  const titleLines = [
    'BOUNDARY.IQ PLATFORM',
    'SPATIALLY ALIGNED BLUEPRINT',
    `TOTAL PARCELS: ${parcels.length}`,
    `TOTAL AREA:    ${(getSafeCoord(totalArea) || 0).toFixed(4)} AC`,
    `REF MONUMENT:  ${safeText(parcels[0].referencePointName || 'SHARED LOCAL REF')}`,
    `DATE:          ${new Date().toISOString().slice(0, 10)}`,
    'MATH COMPILATION ONLY.',
    'NO FIELD SURVEY PERFORMED.',
  ];
  for (let ti = 0; ti < titleLines.length; ti++) {
    d.drawText(tbX, tbY + ti * ts * 1.6, ts, 0, safeText(titleLines[ti]));
  }

  return d.toDxfString();
}

/**
 * Helper to auto-save .dxf, _COGO.txt, and _Points.csv files alongside the source file.
 */
export function saveToSourceDir(dxfString, sourceFilePath, stations, courses, meta, hasSelfIntersection, linearError) {
  if (!sourceFilePath) return null;
  try {
    const resolvedPath = path.resolve(sourceFilePath);
    const sourceDir = path.dirname(resolvedPath);
    if (!fs.existsSync(sourceDir)) {
      return null;
    }
    const baseName = path.parse(resolvedPath).name;

    // 1. Write DXF
    const dxfPath = path.join(sourceDir, `${baseName}__B_dxf.dxf`);
    fs.writeFileSync(dxfPath, dxfString, 'utf8');

    // 2. Write COGO Script
    const cogoLines = [
      "// ================================================================",
      `// COGO SCRIPT — ${meta.parcel || baseName}`,
      `// Boundary verified: SelfIntersect=${hasSelfIntersection}, LinearError=${linearError !== null ? linearError.toFixed(4) : '0.000'} ft`,
      "// Generated by BoundaryIQ AI Agent",
      "// ================================================================",
      "",
      "// BEGIN BOUNDARY TRAVERSE",
      "// Point of Beginning: Northing=5000.000, Easting=5000.000",
      "",
    ];

    courses.forEach((c, i) => {
      if ((c.type || '').toLowerCase() === 'line') {
        cogoLines.push(`// Course ${i + 1} — Line`);
        cogoLines.push(`LINE bearing="${c.bearing || ''}" distance=${c.distance || 0}`);
      } else {
        cogoLines.push(`// Course ${i + 1} — Curve (${c.curveDirection || 'Right'})`);
        cogoLines.push(`CURVE radius=${c.radius || 0} arcLength=${c.arcLength || 0} delta="${c.delta || ''}" direction="${c.curveDirection || 'Right'}" chordBearing="${c.chordBearing || ''}" chordDist=${c.chordDistance || 0}`);
      }
      cogoLines.push("");
    });
    cogoLines.push("// END BOUNDARY TRAVERSE");
    cogoLines.push("// Return to Point of Beginning");

    const cogoPath = path.join(sourceDir, `${baseName}_COGO.txt`);
    fs.writeFileSync(cogoPath, cogoLines.join("\n"), "utf8");

    // 3. Write points list
    if (stations && stations.length > 0) {
      const ptLines = ["PT,Northing,Easting"];
      stations.forEach((s, i) => {
        ptLines.push(`${i},${s.northing.toFixed(3)},${s.easting.toFixed(3)}`);
      });
      const ptsPath = path.join(sourceDir, `${baseName}_Points.csv`);
      fs.writeFileSync(ptsPath, ptLines.join("\n"), "utf8");
    }

    console.log(`[OUTPUT MIRROR] Auto-saved files to source directory: ${sourceDir}`);
    return { dxfPath, cogoPath };
  } catch (err) {
    console.error('[OUTPUT MIRROR] Failed to save to source directory:', err.message);
    return null;
  }
}
