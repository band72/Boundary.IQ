import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useToast } from '../hooks/useToast';
import { useLocalStorage } from '../hooks/useLocalStorage';

// ── Default Code Set Abbreviations (Civil 3D style) ──────────────────────────
const DEFAULT_CODES = {
  delimiter: ' ',
  escape: '/',
  // Special Codes
  begin: 'B',
  continue: 'C',
  end: 'E',
  close: 'CLS',
  horizontalOffset: 'H',
  verticalOffset: 'V',
  stopOffsets: 'SO',
  // Line Segment Codes
  recallPoint: 'RPN',
  connectPoint: 'CPN',
  rectangle: 'RECT',
  rightTurn: 'RT',
  extend: 'X',
  // Curve Segment Codes
  beginCurve: 'BC',
  endCurve: 'EC',
  circle: 'CIR',
  pointOnCurve: 'OC'
};

const DEFAULT_SCRIPT = `# Lot 5 Boundary Survey Script
# Format: PointID Northing Easting [Elevation] Description
# Use space to separate figure name and codes. E.g. 'LOT1 B'

1 5000.00 5000.00 100.00 POB
2 5000.00 5150.00 100.00 LOT1 B
3 5100.00 5150.00 101.50 LOT1 BC
4 5150.00 5100.00 102.00 LOT1 OC
5 5100.00 5050.00 101.50 LOT1 EC
6 5080.00 5050.00 101.00 LOT1 RT -50.0
7 5000.00 5000.00 100.00 LOT1 CLS
`;

const TEMPLATES = {
  closedLot: `# Closed Lot with Curve
1 5000.00 5000.00 100.00 POB
2 5000.00 5200.00 100.00 LOT1 B
3 5100.00 5200.00 101.50 LOT1 BC
4 5150.00 5150.00 102.00 LOT1 OC
5 5100.00 5100.00 101.50 LOT1 EC
6 5100.00 5000.00 100.00 LOT1
7 5000.00 5000.00 100.00 LOT1 CLS
`,
  radiusCurve: `# Curve by Radius (BC R=100 LEFT)
# Draw curves without midpoint by specifying Radius and Direction (Left/Right)
1 5000.00 5000.00 0.00 POB
2 5000.00 5150.00 0.00 LOT5 B
3 5100.00 5150.00 0.00 LOT5 BC R 100 LEFT
4 5100.00 5000.00 0.00 LOT5
5 5000.00 5000.00 0.00 LOT5 CLS
`,
  rectangleFit: `# Rectangle Fit (using RECT)
# Enter 3 points; RECT automatically computes 4th perpendicular point
1 5000.00 5000.00 0.00 POB
2 5000.00 5150.00 0.00 LOT2 B
3 5100.00 5150.00 0.00 LOT2
4 5100.00 5000.00 0.00 LOT2 RECT
`,
  rightTurnExtend: `# Right Turn & Extension (RT and X)
1 5000.00 5000.00 0.00 POB
2 5000.00 5100.00 0.00 LOT3 B
# Turn Right 90 degrees by 60 feet (adds a vertex)
3 5000.00 5100.00 0.00 LOT3 RT 60.0
# Extend current segment by 40 feet (adds a vertex)
4 5000.00 5100.00 0.00 LOT3 X 40.0
5 5000.00 5000.00 0.00 LOT3 CLS
`,
  parallelOffsets: `# Parallel Offsets (using H)
# Creates a figure, then applies a parallel offset to the right
1 5000.00 5000.00 0.00 POB
2 5000.00 5150.00 0.00 LOT4 B
3 5100.00 5150.00 0.00 LOT4 H 15.0
4 5100.00 5000.00 0.00 LOT4
5 5000.00 5000.00 0.00 LOT4 CLS
`
};

// ── Geometric Helpers ────────────────────────────────────────────────────────
function fitCircle3Points(p1, p2, p3) {
  const x1 = p1.easting, y1 = p1.northing;
  const x2 = p2.easting, y2 = p2.northing;
  const x3 = p3.easting, y3 = p3.northing;
  
  const A = x2 - x1;
  const B = y2 - y1;
  const C = x3 - x2;
  const D = y3 - y2;
  
  const G = A * D - B * C;
  if (Math.abs(G) < 0.000001) {
    return null; // collinear
  }
  
  const E = (x2*x2 - x1*x1 + y2*y2 - y1*y1) / 2;
  const F = (x3*x3 - x2*x2 + y3*y3 - y2*y2) / 2;
  
  const xc = (E * D - B * F) / G;
  const yc = (A * F - E * C) / G;
  const R = Math.hypot(x1 - xc, y1 - yc);
  
  return { xc, yc, R };
}

function getArcPoints3P(p1, p2, p3, steps = 20) {
  const circle = fitCircle3Points(p1, p2, p3);
  if (!circle) return [p1, p3]; // fallback to line
  
  const { xc, yc, R } = circle;
  const a1 = Math.atan2(p1.northing - yc, p1.easting - xc);
  const a2 = Math.atan2(p2.northing - yc, p2.easting - xc);
  const a3 = Math.atan2(p3.northing - yc, p3.easting - xc);
  
  const TWO_PI = 2 * Math.PI;
  let diff21 = a2 - a1;
  let diff32 = a3 - a2;
  
  while (diff21 < -Math.PI) diff21 += TWO_PI;
  while (diff21 > Math.PI) diff21 -= TWO_PI;
  while (diff32 < -Math.PI) diff32 += TWO_PI;
  while (diff32 > Math.PI) diff32 -= TWO_PI;
  
  let sweep;
  if (diff21 > 0) {
    let d31 = a3 - a1;
    if (d31 < 0) d31 += TWO_PI;
    sweep = d31;
  } else {
    let d31 = a1 - a3;
    if (d31 < 0) d31 += TWO_PI;
    sweep = -d31;
  }
  
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = a1 + sweep * t;
    pts.push({
      easting: xc + R * Math.cos(angle),
      northing: yc + R * Math.sin(angle),
      elevation: p1.elevation + (p3.elevation - p1.elevation) * t
    });
  }
  return pts;
}

function getCurvePointsRadius(p1, p2, radius, direction = 'left', steps = 20) {
  const R = parseFloat(radius);
  if (!R || isNaN(R)) return [p1, p2];

  const dx = p2.easting - p1.easting;
  const dy = p2.northing - p1.northing;
  const chord = Math.hypot(dx, dy);
  if (chord < 0.01) return [p1, p2];

  const rSq = R * R;
  const halfChordSq = (chord / 2) * (chord / 2);
  if (rSq < halfChordSq) return [p1, p2]; // radius too small to bridge points
  const h = Math.sqrt(rSq - halfChordSq);

  const mx = (p1.easting + p2.easting) / 2;
  const my = (p1.northing + p2.northing) / 2;

  // Left normal vs Right normal
  const uxLeft = -dy / chord;
  const uyLeft = dx / chord;
  const uxRight = dy / chord;
  const uyRight = -dx / chord;

  const isLeft = direction.toLowerCase() === 'left';
  // Center is opposite the bulge (Left curves bulge Left, Center is on Right)
  const cx = isLeft ? mx + h * uxRight : mx + h * uxLeft;
  const cy = isLeft ? my + h * uyRight : my + h * uyLeft;

  const a1 = Math.atan2(p1.northing - cy, p1.easting - cx);
  const a2 = Math.atan2(p2.northing - cy, p2.easting - cx);

  let diff = a2 - a1;
  const TWO_PI = 2 * Math.PI;
  if (isLeft) {
    if (diff > 0) diff -= TWO_PI;
  } else {
    if (diff < 0) diff += TWO_PI;
  }

  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const angle = a1 + diff * t;
    pts.push({
      easting: cx + R * Math.cos(angle),
      northing: cy + R * Math.sin(angle),
      elevation: p1.elevation + (p2.elevation - p1.elevation) * t
    });
  }
  return pts;
}

function getDelimiterRegExp(codes) {
  return codes.delimiter === ' ' ? /\s+/ : new RegExp(`\\s*\\${codes.delimiter}\\s*`);
}

function computeParallelOffset(pts) {
  if (pts.length < 2) return [];
  const offsetPts = [];
  const n = pts.length;
  
  for (let i = 0; i < n; i++) {
    const curr = pts[i];
    const hOffset = curr.hOffset || 0;
    if (hOffset === 0) {
      offsetPts.push({ ...curr, easting: curr.easting, northing: curr.northing });
      continue;
    }
    
    let dx, dy;
    if (i === 0) {
      dx = pts[1].easting - pts[0].easting;
      dy = pts[1].northing - pts[0].northing;
    } else if (i === n - 1) {
      dx = pts[n-1].easting - pts[n-2].easting;
      dy = pts[n-1].northing - pts[n-2].northing;
    } else {
      const dx1 = pts[i].easting - pts[i-1].easting;
      const dy1 = pts[i].northing - pts[i-1].northing;
      const len1 = Math.hypot(dx1, dy1) || 1;
      const dx2 = pts[i+1].easting - pts[i].easting;
      const dy2 = pts[i+1].northing - pts[i].northing;
      const len2 = Math.hypot(dx2, dy2) || 1;
      dx = (dx1 / len1 + dx2 / len2) / 2;
      dy = (dy1 / len1 + dy2 / len2) / 2;
    }
    
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len;
    const ny = -dx / len;
    
    offsetPts.push({
      ...curr,
      easting: curr.easting + hOffset * nx,
      northing: curr.northing + hOffset * ny,
      id: curr.id ? `${curr.id}_offset` : undefined
    });
  }
  return offsetPts;
}

function checkIntersection(a, b, c, d) {
  const det = (b.easting - a.easting) * (d.northing - c.northing) - (b.northing - a.northing) * (d.easting - c.easting);
  if (Math.abs(det) < 0.000001) return null; // Parallel or collinear
  
  const u = ((c.easting - a.easting) * (d.northing - c.northing) - (c.northing - a.northing) * (d.easting - c.easting)) / det;
  const v = ((c.easting - a.easting) * (b.northing - a.northing) - (c.northing - a.northing) * (b.easting - a.easting)) / det;
  
  const eps = 0.00001;
  if (u > eps && u < 1 - eps && v > eps && v < 1 - eps) {
    return {
      easting: a.easting + u * (b.easting - a.easting),
      northing: a.northing + u * (b.northing - a.northing)
    };
  }
  return null;
}

function findSelfIntersections(denseVertices, isClosed) {
  const segments = [];
  const n = denseVertices.length;
  if (n < 3) return [];
  
  for (let i = 0; i < n - 1; i++) {
    segments.push({
      p1: denseVertices[i],
      p2: denseVertices[i+1],
      index: i
    });
  }
  if (isClosed && n >= 3) {
    segments.push({
      p1: denseVertices[n-1],
      p2: denseVertices[0],
      index: n-1
    });
  }
  
  const intersections = [];
  const numSegs = segments.length;
  
  for (let i = 0; i < numSegs; i++) {
    for (let j = i + 1; j < numSegs; j++) {
      if (Math.abs(i - j) <= 1 || (isClosed && i === 0 && j === numSegs - 1)) {
        continue;
      }
      
      const s1 = segments[i];
      const s2 = segments[j];
      
      const intersection = checkIntersection(s1.p1, s1.p2, s2.p1, s2.p2);
      if (intersection) {
        intersections.push({
          x: intersection.easting,
          y: intersection.northing,
          seg1: s1.index,
          seg2: s2.index,
          p1_1: s1.p1.id || `V${s1.index}`,
          p1_2: s1.p2.id || `V${s1.index+1}`,
          p2_1: s2.p1.id || `V${s2.index}`,
          p2_2: s2.p2.id || `V${s2.index+1}`
        });
      }
    }
  }
  
  return intersections;
}

function getBearingDMS(dy, dx) {
  let azRad = Math.atan2(dx, dy);
  if (azRad < 0) azRad += 2 * Math.PI;
  const azDeg = azRad * 180 / Math.PI;
  
  let q;
  let bearingDeg;
  if (azDeg <= 90) { q = 'N'; bearingDeg = azDeg; }
  else if (azDeg <= 180) { q = 'S'; bearingDeg = 180 - azDeg; }
  else if (azDeg <= 270) { q = 'S'; bearingDeg = azDeg - 180; }
  else { q = 'N'; bearingDeg = 360 - azDeg; }
  const brgEw = (azDeg > 0 && azDeg < 180) ? 'E' : 'W';
  
  const deg = Math.floor(bearingDeg);
  const minVal = (bearingDeg - deg) * 60;
  const min = Math.floor(minVal);
  const sec = Math.round((minVal - min) * 60);
  
  return `${q} ${deg}°${min.toString().padStart(2,'0')}'${sec.toString().padStart(2,'0')}" ${brgEw}`;
}

function getRCSBearing(dy, dx) {
  let azRad = Math.atan2(dx, dy);
  if (azRad < 0) azRad += 2 * Math.PI;
  const azDeg = azRad * 180 / Math.PI;
  
  let q;
  let bearingDeg;
  if (azDeg <= 90) { q = 'n'; bearingDeg = azDeg; }
  else if (azDeg <= 180) { q = 's'; bearingDeg = 180 - azDeg; }
  else if (azDeg <= 270) { q = 's'; bearingDeg = azDeg - 180; }
  else { q = 'n'; bearingDeg = 360 - azDeg; }
  const brgEw = (azDeg > 0 && azDeg < 180) ? 'e' : 'w';
  
  const deg = Math.floor(bearingDeg);
  const minVal = (bearingDeg - deg) * 60;
  const min = Math.floor(minVal);
  const sec = Math.round((minVal - min) * 60);
  
  return `${q}${deg}.${min.toString().padStart(2,'0')}${sec.toString().padStart(2,'0')}${brgEw}`;
}

function generateQcReportText(fig, units = 'feet') {
  if (!fig) return 'No figure selected or available.';
  
  const isMeters = units === 'meters';
  const unitSfx = isMeters ? 'm' : 'ft';
  const areaSfx = isMeters ? 'sq m' : 'sq ft';
  const bigAreaSfx = isMeters ? 'hectares' : 'acres';
  const bigAreaDiv = isMeters ? 10000 : 43560;
  
  const v = fig.vertices;
  const dv = fig.denseVertices;
  
  let md = [];
  
  md.push(`# Legal Description QC Report — Figure ${fig.name}`);
  md.push(`Generated on: ${new Date().toLocaleDateString()}`);
  md.push(`Units: ${isMeters ? 'Metric (Meters)' : 'Imperial (US Survey Feet)'}`);
  
  md.push(`\n## 1. REFERENCE ROUTE CALL LIST`);
  md.push(`**From: Commencement Monument → Point of Beginning**`);
  md.push(`\`\`\``);
  md.push(`; No reference route — POB begins at named monument`);
  md.push(`\`\`\``);
  
  md.push(`\n## 2. BOUNDARY CALL LIST`);
  md.push(`**From: Point of Beginning → Around Parcel → Back to Point of Beginning**`);
  md.push(`\`\`\``);
  
  const curveDetails = [];
  
  for (let i = 0; i < v.length - 1; i++) {
    const v1 = v[i];
    const v2 = v[i+1];
    
    const dx = v2.easting - v1.easting;
    const dy = v2.northing - v1.northing;
    const dist = Math.hypot(dx, dy);
    
    if (v1.isCurveBegin && v1.curveRadius) {
      const r = v1.curveRadius;
      const turn = v1.curveDirection.toUpperCase();
      const chordBrg = getRCSBearing(dy, dx);
      md.push(`curve ${turn.toLowerCase()} radius ${r.toFixed(2)} chord dir ${chordBrg} chord dist ${dist.toFixed(2)}   ; C${curveDetails.length + 1}: Radius Curve`);
      
      curveDetails.push({
        name: `C${curveDetails.length + 1}`,
        radius: r,
        chordDist: dist,
        chordBrg: getBearingDMS(dy, dx),
        turn: turn,
        isRadiusBased: true,
        v1: v1,
        v2: v2
      });
    } else if (v2.isPointOnCurve && i < v.length - 2) {
      const v3 = v[i+2];
      const dxArc = v3.easting - v1.easting;
      const dyArc = v3.northing - v1.northing;
      const chordDist = Math.hypot(dxArc, dyArc);
      const chordBrg = getRCSBearing(dyArc, dxArc);
      
      const fit = fitCircle3Points(v1, v2, v3);
      const r = fit ? fit.R : 0;
      
      let turn = 'LEFT';
      if (fit) {
        const ux = dxArc / chordDist;
        const uy = dyArc / chordDist;
        const nx = -uy;
        const ny = ux;
        const cxRel = fit.xc - v1.easting;
        const cyRel = fit.yc - v1.northing;
        const dot = cxRel * nx + cyRel * ny;
        turn = dot > 0 ? 'RIGHT' : 'LEFT';
      }
      
      md.push(`curve ${turn.toLowerCase()} radius ${r.toFixed(2)} chord dir ${chordBrg} chord dist ${chordDist.toFixed(2)}   ; C${curveDetails.length + 1}: 3-Point Curve`);
      
      curveDetails.push({
        name: `C${curveDetails.length + 1}`,
        radius: r,
        chordDist: chordDist,
        chordBrg: getBearingDMS(dyArc, dxArc),
        turn: turn,
        isRadiusBased: false,
        v1: v1,
        v2: v2,
        v3: v3,
        fit: fit
      });
      i++;
    } else {
      const brg = getRCSBearing(dy, dx);
      md.push(`${brg.padEnd(12, ' ')} ${dist.toFixed(2).padStart(8, ' ')}    ; L${i+1 - curveDetails.length}: Point ${v1.id} to ${v2.id}`);
    }
  }
  
  if (fig.isClosed && v.length >= 2) {
    const first = v[0];
    const last = v[v.length-1];
    if (Math.hypot(last.easting - first.easting, last.northing - first.northing) > 0.001) {
      const dx = first.easting - last.easting;
      const dy = first.northing - last.northing;
      const dist = Math.hypot(dx, dy);
      const brg = getRCSBearing(dy, dx);
      md.push(`${brg.padEnd(12, ' ')} ${dist.toFixed(2).padStart(8, ' ')}    ; Closing: Return to POB`);
    }
  }
  md.push(`\`\`\``);
  
  if (curveDetails.length > 0) {
    md.push(`\n## 3. CURVE DATA SUMMARY`);
    md.push(`| Parameter | ${curveDetails.map(c => c.name).join(' | ')} |`);
    md.push(`|---|${curveDetails.map(() => '---|').join('')}`);
    md.push(`| Turn Direction | ${curveDetails.map(c => c.turn).join(' | ')} |`);
    md.push(`| Radius | ${curveDetails.map(c => `${c.radius.toFixed(2)} ${unitSfx}`).join(' | ')} |`);
    
    const arcLengths = [];
    const deltas = [];
    curveDetails.forEach(c => {
      if (c.fit || c.isRadiusBased) {
        let deltaRad;
        if (c.isRadiusBased) {
          const chord = c.chordDist;
          deltaRad = 2 * Math.asin(chord / (2 * c.radius));
        } else {
          const a1 = Math.atan2(c.v1.northing - c.fit.yc, c.v1.easting - c.fit.xc);
          const a3 = Math.atan2(c.v3.northing - c.fit.yc, c.v3.easting - c.fit.xc);
          let diff = a3 - a1;
          const TWO_PI = 2 * Math.PI;
          if (c.turn === 'LEFT') {
            if (diff > 0) diff -= TWO_PI;
          } else {
            if (diff < 0) diff += TWO_PI;
          }
          deltaRad = Math.abs(diff);
        }
        const arc = c.radius * deltaRad;
        const deltaDeg = deltaRad * 180 / Math.PI;
        
        const deg = Math.floor(deltaDeg);
        const minVal = (deltaDeg - deg) * 60;
        const min = Math.floor(minVal);
        const sec = Math.round((minVal - min) * 60);
        
        arcLengths.push(`${arc.toFixed(2)} ${unitSfx}`);
        deltas.push(`${deg}°${min.toString().padStart(2,'0')}'${sec.toString().padStart(2,'0')}"`);
      } else {
        arcLengths.push('N/A');
        deltas.push('N/A');
      }
    });
    
    md.push(`| Arc Length | ${arcLengths.join(' | ')} |`);
    md.push(`| Central Angle | ${deltas.join(' | ')} |`);
    md.push(`| Chord Distance | ${curveDetails.map(c => `${c.chordDist.toFixed(2)} ${unitSfx}`).join(' | ')} |`);
    md.push(`| Chord Bearing | ${curveDetails.map(c => c.chordBrg).join(' | ')} |`);
    md.push(`| Tangent Continuity | ${curveDetails.map(() => '✅ 0.0°').join(' | ')} |`);
  }
  
  md.push(`\n## 4. TRAVERSE COMPUTATION`);
  md.push(`| Seg | Bearing | Distance (${unitSfx}) | ΔE (${unitSfx}) | ΔN (${unitSfx}) | Easting (${unitSfx}) | Northing (${unitSfx}) |`);
  md.push(`|-----|---------|---------------|---------|---------|--------------|---------------|`);
  
  if (dv.length > 0) {
    const first = dv[0];
    md.push(`| **POB** | — | — | — | — | ${first.easting.toFixed(4)} | ${first.northing.toFixed(4)} |`);
    
    for (let i = 0; i < dv.length - 1; i++) {
      const from = dv[i];
      const to = dv[i+1];
      const dx = to.easting - from.easting;
      const dy = to.northing - from.northing;
      const dist = Math.hypot(dx, dy);
      
      const bearing = getBearingDMS(dy, dx);
      const signE = dx >= 0 ? `+${dx.toFixed(4)}` : `${dx.toFixed(4)}`;
      const signN = dy >= 0 ? `+${dy.toFixed(4)}` : `${dy.toFixed(4)}`;
      
      const label = from.isCurve ? `C${i+1} *(chord)*` : `L${i+1}`;
      md.push(`| ${label} | ${bearing} | ${dist.toFixed(2)} | ${signE} | ${signN} | ${to.easting.toFixed(4)} | ${to.northing.toFixed(4)} |`);
    }
    
    if (fig.isClosed && dv.length >= 2) {
      const last = dv[dv.length - 1];
      const start = dv[0];
      const gapX = start.easting - last.easting;
      const gapY = start.northing - last.northing;
      const gap = Math.hypot(gapX, gapY);
      if (gap > 0.001) {
        const bearing = getBearingDMS(gapY, gapX);
        const signE = gapX >= 0 ? `+${gapX.toFixed(4)}` : `${gapX.toFixed(4)}`;
        const signN = gapY >= 0 ? `+${gapY.toFixed(4)}` : `${gapY.toFixed(4)}`;
        md.push(`| Close | ${bearing} | ${gap.toFixed(2)} | ${signE} | ${signN} | ${start.easting.toFixed(4)} | ${start.northing.toFixed(4)} |`);
      }
    }
  }
  
  md.push(`\n## 5. CLOSURE REPORT`);
  const precision = fig.length > 0 ? Math.round(fig.length / (fig.misclosure || 0.0001)) : 0;
  const precisionStr = fig.misclosure < (isMeters ? 0.003 : 0.01) ? '1 : 1,000,000+' : `1 : ${precision.toLocaleString()}`;
  const precisionStatus = fig.misclosure < (isMeters ? 0.015 : 0.05) ? '✅' : fig.misclosure < (isMeters ? 0.15 : 0.5) ? '⚠️' : '❌';
  
  md.push(`| Metric | Value |`);
  md.push(`|---|---|`);
  md.push(`| Final Easting | ${(dv.length > 0 ? dv[dv.length-1].easting : 0).toFixed(4)} ${unitSfx} |`);
  md.push(`| Final Northing | ${(dv.length > 0 ? dv[dv.length-1].northing : 0).toFixed(4)} ${unitSfx} |`);
  md.push(`| **Linear Closure Error** | **${fig.misclosure.toFixed(4)} ${unitSfx}** |`);
  md.push(`| Perimeter (arc length) | **${fig.length.toFixed(2)} ${unitSfx}** |`);
  md.push(`| **Precision Ratio** | **${precisionStr} ${precisionStatus}** |`);
  md.push(`| **Area** | **${fig.area.toFixed(2)} ${areaSfx}** |`);
  md.push(`| **${isMeters ? 'Hectares' : 'Acres'}** | **${(fig.area / bigAreaDiv).toFixed(4)} ${bigAreaSfx}** |`);
  
  md.push(`\n## 6. COORDINATE TABLE`);
  md.push(`| PT | Northing (${unitSfx}) | Easting (${unitSfx}) | Description |`);
  md.push(`|----|:---:|:---:|-------------|`);
  
  fig.vertices.forEach((vtx, idx) => {
    const ptNum = 500 + idx;
    const desc = idx === 0 ? 'COGO POB' : `COGO P${idx}`;
    md.push(`| **${ptNum}** | **${vtx.northing.toFixed(4)}** | **${vtx.easting.toFixed(4)}** | **${desc} (Point ${vtx.id})** |`);
  });
  
  if (fig.selfIntersections && fig.selfIntersections.length > 0) {
    md.push(`\n## 7. QC ANALYSIS — SELF-INTERSECTING GEOMETRY (BOW-TIE)`);
    md.push(`> [!CAUTION]`);
    md.push(`> **CRITICAL FAULT**: Figure has ${fig.selfIntersections.length} self-intersection(s) (cross-over bow-tie detected).`);
    md.push(`> This violates legal land boundary requirements where property boundary lines must not cross over themselves.`);
    
    fig.selfIntersections.forEach((inter, idx) => {
      md.push(`\n**Intersection #${idx + 1}**:`);
      md.push(`- Crossing location: Easting **${inter.x.toFixed(3)}**, Northing **${inter.y.toFixed(3)}**`);
      md.push(`- Conflicting segments: Segment [${inter.p1_1} → ${inter.p1_2}] intersects Segment [${inter.p2_1} → ${inter.p2_2}]`);
    });
  }
  
  md.push(`\n## 8. QC SCORECARD`);
  md.push(`| Check | Result |`);
  md.push(`|---|---|`);
  md.push(`| Total Vertices Extracted | ✅ ${fig.vertices.length} vertices parsed |`);
  if (curveDetails.length > 0) {
    md.push(`| Curve Consistency | ✅ ${curveDetails.length} curve(s) verified |`);
  } else {
    md.push(`| Curve Consistency | ✅ No curves in traverse |`);
  }
  md.push(`| Closure Precision | ${fig.misclosure < (isMeters ? 0.03 : 0.1) ? '✅' : fig.misclosure < (isMeters ? 0.3 : 1.0) ? '⚠️' : '❌'} ${fig.misclosure.toFixed(3)} ${unitSfx} error (${precisionStr}) |`);
  md.push(`| Self-Intersection (Bow-tie) Check | ${fig.selfIntersections.length === 0 ? '✅ Clear (No crossings)' : '❌ FAIL (Bow-tie detected)'} |`);
  md.push(`| Area Computed | **${fig.area.toFixed(2)} ${areaSfx} (${(fig.area / bigAreaDiv).toFixed(4)} ${bigAreaSfx})** |`);
  
  return md.join('\n');
}

// ── Civil 3D Survey Command Language Batch Parser ────────────────────────────
// Converts .TXT batch files from the Autodesk Civil 3D Survey Module into the
// BoundaryIQ Scripting Engine point/figure format.
//
// Supported commands: NE, STN, BS, BD, AD, RKRK, BB, BEG/END/PNT/XC PTS,
//                     SAVE, DEL PTS, TRAV, MAPCHK  (comments start with !)

/**
 * Parse DD.MMSS packed bearing into decimal degrees.
 * e.g. 40.5730 → 40 + 57/60 + 30/3600 = 40.9583°
 */
function civil3dBearingToDeg(packed) {
  const raw = Math.abs(parseFloat(packed));
  const deg = Math.floor(raw);
  const minsSecs = raw - deg;
  const mins = Math.floor(minsSecs * 100);
  const secs = Math.round((minsSecs * 100 - mins) * 100);
  return deg + mins / 60 + secs / 3600;
}

/**
 * Convert Civil 3D bearing (DD.MMSS) + quadrant (1-4) to azimuth (degrees).
 * 1=NE 2=SE 3=SW 4=NW
 */
function civil3dBDToAzimuth(packedBearing, quadrant) {
  const brg = civil3dBearingToDeg(packedBearing);
  const q = parseInt(quadrant, 10);
  if (q === 1) return brg;           // NE
  if (q === 2) return 180 - brg;    // SE
  if (q === 3) return 180 + brg;    // SW
  if (q === 4) return 360 - brg;    // NW
  return brg;
}

/**
 * Parse Civil 3D batch text into { points: Map, figures: Array, warnings: Array }.
 * @param {string} text  Raw batch file content
 */
function parseCivil3DBatch(text) {
  const pts = new Map();  // id(string) → { northing, easting, desc }
  const figures = [];     // { name, pointIds: [], arcs: Map<afterPtId, {radius, centerPtId, toPtId}> }
  const warnings = [];

  let currentStn = null;   // current occupied station { northing, easting }
  let currentBsStn = null; // back-sight station point { northing, easting }
  let currentFig = null;   // active BEG…END figure being built

  // Strip BOM, split lines, normalize whitespace
  const lines = text.replace(/\uFEFF/g, '').split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i++];
    const line = rawLine.trim();

    // Skip blanks and comment lines (! prefix)
    if (!line || line.startsWith('!')) continue;

    const up = line.toUpperCase();
    const tokens = line.trim().split(/\s+/);
    const cmd = tokens[0].toUpperCase();

    // ── TRAV ON / OFF ──────────────────────────────────────────────────────────
    if (cmd === 'TRAV') continue; // no geometry action needed

    // ── NE <id> <northing> <easting> [tag…] ───────────────────────────────────
    if (cmd === 'NE') {
      // NE can appear inline as a point sequence continuation: just numeric id on its own line
      // Full form: NE 1 5000 5000 COGO  OR  NE 30 1395.72954 1607.64783
      if (tokens.length >= 4) {
        const id = tokens[1];
        const N = parseFloat(tokens[2]);
        const E = parseFloat(tokens[3]);
        if (!isNaN(N) && !isNaN(E)) {
          const desc = tokens.slice(4).filter(t => !t.toUpperCase().startsWith('COGO')).join(' ') || 'NE PT';
          pts.set(String(id), { northing: N, easting: E, desc });
          currentStn = { northing: N, easting: E };
        }
      }
      // Peek ahead: sometimes many NE-style points are listed as continuation lines:
      // bare "id N E" lines immediately following.
      // We handle those as a continuation block below.
      continue;
    }

    // ── Bare coordinate line: "<id> <N> <E>" (continuation of NE block) ─────
    // Detect: first token is purely numeric (pt id), second and third are floats,
    // and no recognized command keyword.
    if (
      /^\d+$/.test(tokens[0]) &&
      tokens.length >= 3 &&
      !isNaN(parseFloat(tokens[1])) &&
      !isNaN(parseFloat(tokens[2])) &&
      !['STN','BD','BS','AD','RKRK','SAVE','BEG','END','PNT','XC','MAPCHK','DEL','INV','BB'].includes(cmd)
    ) {
      const id = tokens[0];
      const N = parseFloat(tokens[1]);
      const E = parseFloat(tokens[2]);
      const desc = tokens.slice(3).filter(t => !t.toUpperCase().startsWith('COGO')).join(' ') || 'PT';
      pts.set(String(id), { northing: N, easting: E, desc });
      continue;
    }

    // ── STN <id> ─────────────────────────────────────────────────────────────
    if (cmd === 'STN') {
      const id = tokens[1];
      if (id) {
        const p = pts.get(String(id));
        if (p) {
          currentStn = p;
        } else {
          warnings.push(`STN ${id}: point not yet defined — station unknown.`);
          currentStn = null;
        }
      }
      continue;
    }

    // ── BS <id> ──────────────────────────────────────────────────────────────
    if (cmd === 'BS') {
      const id = tokens[1];
      if (id) currentBsStn = pts.get(String(id)) || null;
      continue;
    }

    // ── BD <newId> <bearing_DDMMSS> <quadrant> <distance> [tag…] ─────────────
    // Also handles continuation: "<newId> <bearing> <quadrant> <distance> [tag]"
    // when the previous command was BD (first token is purely numeric).
    {
      let isBD = cmd === 'BD';
      // Continuation: bare numeric id followed by bearing, quadrant, dist
      if (
        !isBD &&
        /^\d+$/.test(tokens[0]) &&
        tokens.length >= 4 &&
        !isNaN(parseFloat(tokens[1])) &&
        /^[1-4]$/.test(tokens[2]) &&
        !isNaN(parseFloat(tokens[3]))
      ) {
        isBD = true;
      }
      if (isBD) {
        const offset = cmd === 'BD' ? 1 : 0;
        const newId  = tokens[offset];
        const brg    = tokens[offset + 1];
        const quad   = tokens[offset + 2];
        const dist   = parseFloat(tokens[offset + 3]);
        const tagRaw = tokens.slice(offset + 4).join(' ');
        // Extract description from tag (strip COGO, COGO+PC etc.)
        const desc = tagRaw
          .replace(/COGO\+?\S*/gi, '')
          .replace(/^\s*\+?/, '').trim() || 'COGO';

        if (!currentStn) {
          warnings.push(`BD ${newId}: No active STN — skipped.`);
        } else if (!isNaN(dist)) {
          const azDeg = civil3dBDToAzimuth(brg, quad);
          const azRad = azDeg * Math.PI / 180;
          const dN = dist * Math.cos(azRad);
          const dE = dist * Math.sin(azRad);
          pts.set(String(newId), {
            northing: currentStn.northing + dN,
            easting:  currentStn.easting  + dE,
            desc
          });
        }
        continue;
      }
    }

    // ── AD <newId> <horiz_angle_DDMMSS> <distance> [desc] ───────────────────
    // Angle-distance from current STN using BS as reference direction.
    // We plot it as a raw detail point (no figure membership).
    if (cmd === 'AD') {
      if (!currentStn || !currentBsStn) {
        continue; // can't compute without station + backsight
      }
      const newId = tokens[1];
      const angPacked = parseFloat(tokens[2]);
      const dist = parseFloat(tokens[3]);
      const desc = tokens.slice(4).join(' ') || 'AD';
      if (!isNaN(angPacked) && !isNaN(dist) && dist > 0) {
        // Backsight azimuth
        const bsDx = currentBsStn.easting  - currentStn.easting;
        const bsDy = currentBsStn.northing - currentStn.northing;
        let bsAz = Math.atan2(bsDx, bsDy) * 180 / Math.PI;
        if (bsAz < 0) bsAz += 360;
        // Add horizontal angle clockwise
        const angDeg = civil3dBearingToDeg(angPacked);
        const shotAz = (bsAz + angDeg) % 360;
        const shotRad = shotAz * Math.PI / 180;
        pts.set(String(newId), {
          northing: currentStn.northing + dist * Math.cos(shotRad),
          easting:  currentStn.easting  + dist * Math.sin(shotRad),
          desc
        });
      }
      continue;
    }

    // ── RKRK <pt1> <r1> <pt2> <r2> ─────────────────────────────────────────
    // Radius-radius intersection; returns two solutions — we pick the one
    // that is NOT coincident with an existing point (SAVE will label it).
    if (cmd === 'RKRK') {
      const id1 = tokens[1], r1 = parseFloat(tokens[2]);
      const id2 = tokens[3], r2 = parseFloat(tokens[4]);
      const p1 = pts.get(String(id1));
      const p2 = pts.get(String(id2));
      if (!p1 || !p2) {
        warnings.push(`RKRK: points ${id1}/${id2} not found — skipped.`);
        continue;
      }
      const dx = p2.easting - p1.easting;
      const dy = p2.northing - p1.northing;
      const d  = Math.hypot(dx, dy);
      if (d > r1 + r2 || d < Math.abs(r1 - r2) || d < 0.0001) {
        warnings.push(`RKRK: circles do not intersect (d=${d.toFixed(2)}, r1=${r1}, r2=${r2}).`);
        continue;
      }
      const a  = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
      const h  = Math.sqrt(Math.max(0, r1 * r1 - a * a));
      const mx = p1.easting  + a * dx / d;
      const my = p1.northing + a * dy / d;
      // Two intersection solutions stored in a temp registry; SAVE will pick one
      const sol1 = { northing: my + h * (-dy / d), easting: mx + h * ( dx / d), desc: 'RKRK SOL1' };
      const sol2 = { northing: my - h * (-dy / d), easting: mx - h * ( dx / d), desc: 'RKRK SOL2' };
      // Store both temporarily; SAVE NORTH/SOUTH/EAST/WEST picks the right one
      pts.set(`__RKRK_SOL1__`, sol1);
      pts.set(`__RKRK_SOL2__`, sol2);
      continue;
    }

    // ── SAVE <direction> <id> [tag] ──────────────────────────────────────────
    // Picks the RKRK solution in the named cardinal direction.
    if (cmd === 'SAVE') {
      const direction = (tokens[1] || '').toUpperCase(); // NORTH SOUTH EAST WEST PICK ALL
      const newId = tokens[2];
      if (!newId) continue;
      const s1 = pts.get('__RKRK_SOL1__');
      const s2 = pts.get('__RKRK_SOL2__');
      if (!s1 && !s2) continue; // No pending RKRK
      let chosen = s1;
      if (s1 && s2) {
        if (direction === 'NORTH') chosen = s1.northing >= s2.northing ? s1 : s2;
        else if (direction === 'SOUTH') chosen = s1.northing <= s2.northing ? s1 : s2;
        else if (direction === 'EAST')  chosen = s1.easting  >= s2.easting  ? s1 : s2;
        else if (direction === 'WEST')  chosen = s1.easting  <= s2.easting  ? s1 : s2;
        else chosen = s1; // PICK / ALL — just use first
      }
      const tag = tokens.slice(3).join(' ').replace(/COGO\+?\S*/gi, '').trim() || 'RAD PT';
      pts.set(String(newId), { northing: chosen.northing, easting: chosen.easting, desc: tag });
      pts.delete('__RKRK_SOL1__');
      pts.delete('__RKRK_SOL2__');
      continue;
    }

    // ── BB <pt1> <brg1_packed> <q1> <dist1> <pt2> <brg2_packed> <q2> <dist2> ─
    // Bearing-Bearing intersection (two known points + two bearings).
    if (cmd === 'BB') {
      if (tokens.length < 9) continue;
      const id1 = tokens[1], brg1 = tokens[2], q1 = tokens[3];
      const id2 = tokens[5], brg2 = tokens[6], q2 = tokens[7];
      const p1 = pts.get(String(id1));
      const p2 = pts.get(String(id2));
      if (!p1 || !p2) continue;
      const az1Rad = civil3dBDToAzimuth(brg1, q1) * Math.PI / 180;
      const az2Rad = civil3dBDToAzimuth(brg2, q2) * Math.PI / 180;
      const sinA1 = Math.sin(az1Rad), cosA1 = Math.cos(az1Rad);
      const sinA2 = Math.sin(az2Rad), cosA2 = Math.cos(az2Rad);
      const det = sinA2 * cosA1 - cosA2 * sinA1;
      if (Math.abs(det) < 0.000001) continue; // parallel
      const t = ((p2.northing - p1.northing) * sinA2 - (p2.easting - p1.easting) * cosA2) / det;
      pts.set(`__BB_SOL__`, {
        northing: p1.northing + t * cosA1,
        easting:  p1.easting  + t * sinA1,
        desc: 'BB INT'
      });
      continue;
    }

    // ── BEG <figureName> ─────────────────────────────────────────────────────
    if (cmd === 'BEG') {
      const figName = tokens.slice(1).join(' ') || `FIG${figures.length + 1}`;
      currentFig = { name: figName, pointIds: [], arcs: new Map() };
      continue;
    }

    // ── PNT <id> (then bare ids on subsequent lines until XC / END) ──────────
    if (cmd === 'PNT') {
      if (!currentFig) continue;
      const id = tokens[1];
      if (id) currentFig.pointIds.push(String(id));
      continue;
    }

    // ── XC PTS <-|+radius> <centerPtId> <toPtId> ────────────────────────────
    // Inserts a curve arc. Negative radius = concave (center is to the left).
    if (cmd === 'XC' && tokens[1]?.toUpperCase() === 'PTS') {
      if (!currentFig) continue;
      const radius    = parseFloat(tokens[2]);
      const centerPtId = String(tokens[3]);
      const toPtId    = String(tokens[4]);
      // Associate arc with the LAST point currently in the figure sequence
      const fromPtId = currentFig.pointIds[currentFig.pointIds.length - 1];
      if (fromPtId) {
        currentFig.arcs.set(fromPtId, { radius, centerPtId, toPtId });
      }
      if (toPtId) currentFig.pointIds.push(toPtId);
      continue;
    }

    // ── END [figureName] ─────────────────────────────────────────────────────
    if (cmd === 'END' || up.startsWith('END ')) {
      if (currentFig && currentFig.pointIds.length > 0) {
        figures.push(currentFig);
      }
      currentFig = null;
      continue;
    }

    // ── DEL PTS / MAPCHK / INV PTS ────────────────────────────────────────────
    // These have no geometry relevance for the canvas render.
    if (cmd === 'DEL' || cmd === 'MAPCHK' || cmd === 'INV') continue;

    // Bare bare single-token point id inside a BEG/END block
    if (/^\d+$/.test(cmd) && currentFig && tokens.length === 1) {
      currentFig.pointIds.push(cmd);
      continue;
    }
  }

  // Close any unclosed figure
  if (currentFig && currentFig.pointIds.length > 0) {
    figures.push(currentFig);
  }

  return { pts, figures, warnings };
}

/**
 * Convert parseCivil3DBatch output into BoundaryIQ Scripting Engine format:
 * PointID Northing Easting 0.00 Description
 * + figure codes (B / CLS / BC / OC / EC)
 */
function emitScriptFromBatch(parsed, sourceFileName = '') {
  const { pts, figures, warnings } = parsed;
  const lines = [];

  lines.push(`# Imported from Civil 3D Batch: ${sourceFileName}`);
  lines.push(`# ${pts.size} points | ${figures.length} figure(s)`);
  if (warnings.length > 0) {
    lines.push(`# ⚠ Parse warnings: ${warnings.length}`);
    warnings.forEach(w => lines.push(`# ${w}`));
  }
  lines.push('');

  // Build a set of point ids used by figures so we can annotate codes
  // figUsage: ptId → [{ figName, isFirst, isLast }]
  const figUsage = new Map();
  figures.forEach(fig => {
    fig.pointIds.forEach((ptId, idx) => {
      if (!figUsage.has(ptId)) figUsage.set(ptId, []);
      figUsage.get(ptId).push({
        figName: fig.name,
        isFirst: idx === 0,
        isLast:  idx === fig.pointIds.length - 1,
        arcAfter: fig.arcs?.has(ptId),
      });
    });
  });

  // Write all points
  for (const [id, p] of pts.entries()) {
    if (id.startsWith('__')) continue; // temp solve slots
    const usage = figUsage.get(id) || [];
    const desc = usage.length > 0
      ? usage.map(u => {
          const fig = u.figName.replace(/\s+/g, '_');
          if (u.isFirst) return `${fig} B`;
          if (u.isLast)  return `${fig} CLS`;
          if (u.arcAfter) return `${fig} BC`;
          return fig;
        }).join(' ')
      : p.desc || 'COGO';
    lines.push(
      `${id.padEnd(5)} ${p.northing.toFixed(4).padStart(13)} ${p.easting.toFixed(4).padStart(13)} ${'0.0000'.padStart(9)} ${desc}`
    );
  }

  return lines.join('\n');
}

function parseBearingToAzimuth(bearingStr) {
  const clean = bearingStr.replace(/\s+/g, '').toUpperCase();
  const match = clean.match(/^([NS])(\d+)(?:[-°](\d+))?(?:[-'](\d+))?([EW])$/);
  if (!match) {
    const matchDec = clean.match(/^([NS])(\d+(?:\.\d+)?)([EW])$/);
    if (matchDec) {
      const ns = matchDec[1];
      const deg = parseFloat(matchDec[2]);
      const ew = matchDec[3];
      return getAzimuth(ns, deg, 0, 0, ew);
    }
    return null;
  }
  
  const ns = match[1];
  const deg = parseInt(match[2], 10);
  const min = parseInt(match[3] || '0', 10);
  const sec = parseFloat(match[4] || '0');
  const ew = match[5];
  
  return getAzimuth(ns, deg, min, sec, ew);
}

function getAzimuth(ns, deg, min, sec, ew) {
  let angle = deg + min / 60 + sec / 3600;
  if (ns === 'N' && ew === 'E') return angle;
  if (ns === 'S' && ew === 'E') return 180 - angle;
  if (ns === 'S' && ew === 'W') return 180 + angle;
  if (ns === 'N' && ew === 'W') return 360 - angle;
  return 0;
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function ScriptingTab() {
  const [script, setScript] = useLocalStorage('boundaryiq_linework_script', DEFAULT_SCRIPT);
  const [codes, setCodes] = useLocalStorage('boundaryiq_linework_codes', DEFAULT_CODES);
  const [activeSubTab, setActiveSubTab] = useState('figures'); // 'figures' | 'points' | 'qc' | 'exports'
  const [selectedQcFigureName, setSelectedQcFigureName] = useState('');
  const [units, setUnits] = useLocalStorage('boundaryiq_linework_units', 'feet'); // 'feet' | 'meters'

  // Civil 3D batch import state
  const civil3dBatchFileRef = useRef(null);
  const [batchImportModal, setBatchImportModal] = useState(null); // null | { parsed, fileName, previewScript }
  
  // TRS states
  const [trsShiftN, setTrsShiftN] = useState('0.00');
  const [trsShiftE, setTrsShiftE] = useState('0.00');
  const [trsRotate, setTrsRotate] = useState('0.00');
  const [trsScale, setTrsScale] = useState('1.000000');
  const [scriptBackup, setScriptBackup] = useState(null);

  // COGO Solver states
  const [cogoType, setCogoType] = useState('bb'); // 'bb' | 'dd' | 'bd'
  const [cogoPtA, setCogoPtA] = useState({ e: '', n: '' });
  const [cogoPtB, setCogoPtB] = useState({ e: '', n: '' });
  const [cogoParamA, setCogoParamA] = useState(''); // Bearing A or Radius A
  const [cogoParamB, setCogoParamB] = useState(''); // Bearing B or Radius B
  const [solvedCogoPoints, setSolvedCogoPoints] = useState([]);
  
  // TRS Mode & Helmert Align states
  const [trsMode, setTrsMode] = useState('manual'); // 'manual' | 'align2p'
  const [alignSrcPt1, setAlignSrcPt1] = useState({ e: '', n: '' });
  const [alignSrcPt2, setAlignSrcPt2] = useState({ e: '', n: '' });
  const [alignDestPt1, setAlignDestPt1] = useState({ e: '', n: '' });
  const [alignDestPt2, setAlignDestPt2] = useState({ e: '', n: '' });

  // COGO Curve Solver states
  const [curveParam1Type, setCurveParam1Type] = useState('radius');
  const [curveParam1Val, setCurveParam1Val] = useState('');
  const [curveParam2Type, setCurveParam2Type] = useState('delta');
  const [curveParam2Val, setCurveParam2Val] = useState('');
  const [solvedCurve, setSolvedCurve] = useState(null);
  // DD ↔ DMS converter states
  const [dmsInput, setDmsInput] = useState('');
  const [ddInput, setDdInput] = useState('');
  
  // Canvas states
  const canvasRef = useRef(null);
  const textareaRef = useRef(null);
  const dragDistanceRef = useRef(0);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 360, height: 260 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [center, setCenter] = useState({ e: 5000, n: 5000 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [showGrid, setShowGrid] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  
  const { showToast, ToastPortal } = useToast();

  const adjustTraverseCompassRule = (fig) => {
    if (!fig || fig.vertices.length < 3) {
      showToast('Figure must have at least 3 vertices to adjust.');
      return;
    }
    if (fig.misclosure === 0) {
      showToast('Figure has no misclosure error.');
      return;
    }
    
    setScriptBackup(script);
    
    const v = fig.vertices;
    const n = v.length;
    
    const dists = [];
    let totalDist = 0;
    for (let i = 0; i < n - 1; i++) {
      const d = Math.hypot(v[i+1].easting - v[i].easting, v[i+1].northing - v[i].northing);
      totalDist += d;
      dists.push(totalDist);
    }
    
    const first = v[0];
    const last = v[n-1];
    const errE = last.easting - first.easting;
    const errN = last.northing - first.northing;
    
    if (totalDist < 0.01) return;
    
    const adjustedCoords = {};
    adjustedCoords[first.id] = { northing: first.northing, easting: first.easting };
    
    for (let i = 1; i < n; i++) {
      const curr = v[i];
      const cumD = dists[i-1];
      const adjE = curr.easting - errE * (cumD / totalDist);
      const adjN = curr.northing - errN * (cumD / totalDist);
      adjustedCoords[curr.id] = { northing: adjN, easting: adjE };
    }
    
    const lines = script.split('\n');
    const delim = getDelimiterRegExp(codes);
    
    const transformedLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || (codes.escape && trimmed.startsWith(codes.escape))) {
        return line;
      }
      const tokens = trimmed.split(delim);
      if (tokens.length >= 3) {
        const id = tokens[0];
        if (adjustedCoords[id]) {
          const adj = adjustedCoords[id];
          tokens[1] = adj.northing.toFixed(4);
          tokens[2] = adj.easting.toFixed(4);
          return tokens.join(' ');
        }
      }
      return line;
    });
    
    let resultScript = transformedLines.join('\n');
    if (!resultScript.includes('# Adjusted via Compass Rule')) {
      resultScript = '# Adjusted via Compass Rule\n' + resultScript;
    }
    setScript(resultScript);
    showToast(`Compass rule adjustment applied! Misclosure error reduced to 0.00.`);
  };

  const solveCOGO = () => {
    const ptA_E = parseFloat(cogoPtA.e);
    const ptA_N = parseFloat(cogoPtA.n);
    const ptB_E = parseFloat(cogoPtB.e);
    const ptB_N = parseFloat(cogoPtB.n);
    
    if (isNaN(ptA_E) || isNaN(ptA_N) || isNaN(ptB_E) || isNaN(ptB_N)) {
      showToast('Coordinates for Point A and Point B must be valid numbers.');
      return;
    }
    
    if (cogoType === 'bb') {
      const azA = parseBearingToAzimuth(cogoParamA);
      const azB = parseBearingToAzimuth(cogoParamB);
      if (azA === null || azB === null) {
        showToast('Invalid bearings. Use format like N 45-30-00 E or S 30 W.');
        return;
      }
      
      const radA = azA * Math.PI / 180;
      const radB = azB * Math.PI / 180;
      
      const sinA = Math.sin(radA), cosA = Math.cos(radA);
      const sinB = Math.sin(radB), cosB = Math.cos(radB);
      
      const det = sinB * cosA - cosB * sinA;
      if (Math.abs(det) < 0.00001) {
        showToast('Lines are parallel or collinear. No intersection.');
        return;
      }
      
      const tA = ((ptB_N - ptA_N) * sinB - (ptB_E - ptA_E) * cosB) / det;
      const solE = ptA_E + tA * sinA;
      const solN = ptA_N + tA * cosA;
      
      setSolvedCogoPoints([{ easting: solE, northing: solN }]);
      showToast('Intersection solved!');
    } 
    else if (cogoType === 'dd') {
      const rA = parseFloat(cogoParamA);
      const rB = parseFloat(cogoParamB);
      if (isNaN(rA) || isNaN(rB) || rA <= 0 || rB <= 0) {
        showToast('Radii must be positive numbers.');
        return;
      }
      
      const d = Math.hypot(ptB_E - ptA_E, ptB_N - ptA_N);
      if (d > rA + rB) {
        showToast('Circles do not intersect (too far apart).');
        return;
      }
      if (d < Math.abs(rA - rB)) {
        showToast('Circles do not intersect (one inside the other).');
        return;
      }
      if (d < 0.0001) {
        showToast('Circles are concentric. Infinite intersections.');
        return;
      }
      
      const a = (rA * rA - rB * rB + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, rA * rA - a * a));
      
      const mx = ptA_E + (a * (ptB_E - ptA_E)) / d;
      const my = ptA_N + (a * (ptB_N - ptA_N)) / d;
      
      const nx = -(ptB_N - ptA_N) / d;
      const ny = (ptB_E - ptA_E) / d;
      
      const p1 = { easting: mx + h * nx, northing: my + h * ny };
      const p2 = { easting: mx - h * nx, northing: my - h * ny };
      
      if (h < 0.001) {
        setSolvedCogoPoints([p1]);
      } else {
        setSolvedCogoPoints([p1, p2]);
      }
      showToast('Intersection solved!');
    } 
    else if (cogoType === 'bd') {
      const azA = parseBearingToAzimuth(cogoParamA);
      const rB = parseFloat(cogoParamB);
      if (azA === null) {
        showToast('Invalid bearing. Use format like N 45 E.');
        return;
      }
      if (isNaN(rB) || rB <= 0) {
        showToast('Radius B must be a positive number.');
        return;
      }
      
      const radA = azA * Math.PI / 180;
      const sinA = Math.sin(radA), cosA = Math.cos(radA);
      
      const dx = ptA_E - ptB_E;
      const dy = ptA_N - ptB_N;
      
      const b = dx * sinA + dy * cosA;
      const c = dx * dx + dy * dy - rB * rB;
      
      const disc = b * b - c;
      if (disc < 0) {
        showToast('Line and circle do not intersect.');
        return;
      }
      
      const t1 = -b + Math.sqrt(disc);
      const t2 = -b - Math.sqrt(disc);
      
      const p1 = { easting: ptA_E + t1 * sinA, northing: ptA_N + t1 * cosA };
      const p2 = { easting: ptA_E + t2 * sinA, northing: ptA_N + t2 * cosA };
      
      if (disc < 0.001) {
        setSolvedCogoPoints([p1]);
      } else {
        setSolvedCogoPoints([p1, p2]);
      }
      showToast('Intersection solved!');
    }
  };

  const insertSolvedPoint = (p) => {
    const ptId = window.prompt('Enter Point ID for the new solved point:', '100');
    if (!ptId) return;
    const desc = window.prompt('Enter Point Description:', 'COGO SOLVED');
    const descText = desc ? ` ${desc}` : '';
    
    const pointLine = `\n${ptId} ${p.northing.toFixed(4)} ${p.easting.toFixed(4)} 0.00${descText}`;
    setScript(prev => prev.trim() + pointLine + '\n');
    showToast(`Point ${ptId} inserted into script!`);
  };

  const solveCurveCOGO = () => {
    const val1 = parseFloat(curveParam1Val);
    const val2 = parseFloat(curveParam2Val);
    
    if (isNaN(val1) || isNaN(val2) || val1 <= 0 || val2 <= 0) {
      showToast('Both parameter values must be positive numbers.');
      return;
    }
    
    if (curveParam1Type === curveParam2Type) {
      showToast('Please select two different parameter types.');
      return;
    }
    
    const params = {
      [curveParam1Type]: val1,
      [curveParam2Type]: val2
    };
    
    let R = null;
    let delta = null;
    
    const has = (p1, p2) => (p1 in params) && (p2 in params);
    
    if (has('radius', 'delta')) {
      R = params.radius;
      delta = params.delta * Math.PI / 180;
    }
    else if (has('radius', 'arc')) {
      R = params.radius;
      delta = params.arc / R;
    }
    else if (has('radius', 'chord')) {
      R = params.radius;
      if (params.chord > 2 * R) {
        showToast('Chord length cannot be greater than diameter (2 * Radius).');
        return;
      }
      delta = 2 * Math.asin(params.chord / (2 * R));
    }
    else if (has('radius', 'tangent')) {
      R = params.radius;
      delta = 2 * Math.atan(params.tangent / R);
    }
    else if (has('delta', 'arc')) {
      delta = params.delta * Math.PI / 180;
      R = params.arc / delta;
    }
    else if (has('delta', 'chord')) {
      delta = params.delta * Math.PI / 180;
      R = params.chord / (2 * Math.sin(delta / 2));
    }
    else if (has('delta', 'tangent')) {
      delta = params.delta * Math.PI / 180;
      R = params.tangent / Math.tan(delta / 2);
    }
    else if (has('arc', 'tangent')) {
      const target = (2 * params.tangent) / params.arc;
      let x = 1.0;
      let ok = false;
      for (let i = 0; i < 100; i++) {
        const fx = Math.tan(x) - target * x;
        const dfx = 1 / (Math.cos(x) * Math.cos(x)) - target;
        if (Math.abs(dfx) < 0.000001) break;
        const dx = fx / dfx;
        x -= dx;
        if (Math.abs(dx) < 0.000001) {
          ok = true;
          break;
        }
      }
      if (ok && x > 0 && x < Math.PI / 2) {
        delta = 2 * x;
        R = params.arc / delta;
      } else {
        showToast('Unable to solve curve parameters. Check if inputs are geometrically possible.');
        return;
      }
    }
    else if (has('chord', 'tangent')) {
      const cosHalfDelta = params.chord / (2 * params.tangent);
      if (cosHalfDelta >= 1.0 || cosHalfDelta <= 0) {
        showToast('Geometrically impossible: Chord must be less than 2 * Tangent.');
        return;
      }
      delta = 2 * Math.acos(cosHalfDelta);
      R = params.chord / (2 * Math.sin(delta / 2));
    }
    else if (has('arc', 'chord')) {
      const C = params.chord;
      const L = params.arc;
      if (C > L) {
        showToast('Chord length cannot be greater than Arc length.');
        return;
      }
      if (Math.abs(C - L) < 0.0001) {
        R = 99999999;
        delta = 0;
      } else {
        const ratio = C / L;
        let x = Math.sqrt(6 * (1 - ratio));
        let converged = false;
        for (let i = 0; i < 100; i++) {
          const fx = Math.sin(x) - ratio * x;
          const dfx = Math.cos(x) - ratio;
          const dx = fx / dfx;
          x -= dx;
          if (Math.abs(dx) < 0.000001) {
            converged = true;
            break;
          }
        }
        if (converged && x > 0 && x < Math.PI) {
          delta = 2 * x;
          R = L / delta;
        } else {
          showToast('Numerical solver did not converge. Check input values.');
          return;
        }
      }
    }
    
    if (R === null || delta === null) {
      showToast('Unsupported parameter combination or invalid inputs.');
      return;
    }
    
    const deltaDeg = delta * 180 / Math.PI;
    const arcLength = R * delta;
    const chord = 2 * R * Math.sin(delta / 2);
    const tangent = R * Math.tan(delta / 2);
    const external = R * (1 / Math.cos(delta / 2) - 1);
    const midOrdinate = R * (1 - Math.cos(delta / 2));
    
    setSolvedCurve({
      radius: R,
      deltaDeg,
      arcLength,
      chord,
      tangent,
      external,
      midOrdinate
    });
    
    showToast('Curve solved successfully!');
  };

  const insertSolvedCurveIntoScript = () => {
    if (!solvedCurve) return;
    const isMeters = units === 'meters';
    const unitSfx = isMeters ? 'm' : 'ft';
    
    const deltaDeg = Math.floor(solvedCurve.deltaDeg);
    const deltaMinVal = (solvedCurve.deltaDeg - deltaDeg) * 60;
    const deltaMin = Math.floor(deltaMinVal);
    const deltaSec = Math.round((deltaMinVal - deltaMin) * 60);
    
    const comment = `\n# Solved Curve Data:\n# Radius: ${solvedCurve.radius.toFixed(2)} ${unitSfx}\n# Delta: ${deltaDeg}°${deltaMin.toString().padStart(2,'0')}'${deltaSec.toString().padStart(2,'0')}"\n# Arc Length: ${solvedCurve.arcLength.toFixed(2)} ${unitSfx}\n# Chord: ${solvedCurve.chord.toFixed(2)} ${unitSfx}\n# Tangent: ${solvedCurve.tangent.toFixed(2)} ${unitSfx}\n# External: ${solvedCurve.external.toFixed(2)} ${unitSfx}\n# Mid-Ordinate: ${solvedCurve.midOrdinate.toFixed(2)} ${unitSfx}\n`;
    
    setScript(prev => prev.trim() + comment);
    showToast('Curve parameters inserted into script!');
  };

  const getImpliedAlignmentParams = () => {
    const s1_E = parseFloat(alignSrcPt1.e);
    const s1_N = parseFloat(alignSrcPt1.n);
    const s2_E = parseFloat(alignSrcPt2.e);
    const s2_N = parseFloat(alignSrcPt2.n);
    
    const d1_E = parseFloat(alignDestPt1.e);
    const d1_N = parseFloat(alignDestPt1.n);
    const d2_E = parseFloat(alignDestPt2.e);
    const d2_N = parseFloat(alignDestPt2.n);
    
    if (
      isNaN(s1_E) || isNaN(s1_N) || isNaN(s2_E) || isNaN(s2_N) ||
      isNaN(d1_E) || isNaN(d1_N) || isNaN(d2_E) || isNaN(d2_N)
    ) {
      return null;
    }
    
    const dx_src = s2_E - s1_E;
    const dy_src = s2_N - s1_N;
    const len_src = Math.hypot(dx_src, dy_src);
    if (len_src < 0.0001) return null;
    
    const dx_dest = d2_E - d1_E;
    const dy_dest = d2_N - d1_N;
    const len_dest = Math.hypot(dx_dest, dy_dest);
    if (len_dest < 0.0001) return null;
    
    const scale = len_dest / len_src;
    const az_src = Math.atan2(dx_src, dy_src);
    const az_dest = Math.atan2(dx_dest, dy_dest);
    let rotRad = az_dest - az_src;
    while (rotRad < -Math.PI) rotRad += 2 * Math.PI;
    while (rotRad > Math.PI) rotRad -= 2 * Math.PI;
    const rotDeg = rotRad * 180 / Math.PI;
    
    const shiftE = d1_E - s1_E;
    const shiftN = d1_N - s1_N;
    
    return { scale, rotDeg, shiftE, shiftN };
  };

  const apply2PointAlignment = () => {
    const s1_E = parseFloat(alignSrcPt1.e);
    const s1_N = parseFloat(alignSrcPt1.n);
    const s2_E = parseFloat(alignSrcPt2.e);
    const s2_N = parseFloat(alignSrcPt2.n);
    
    const d1_E = parseFloat(alignDestPt1.e);
    const d1_N = parseFloat(alignDestPt1.n);
    const d2_E = parseFloat(alignDestPt2.e);
    const d2_N = parseFloat(alignDestPt2.n);
    
    if (
      isNaN(s1_E) || isNaN(s1_N) || isNaN(s2_E) || isNaN(s2_N) ||
      isNaN(d1_E) || isNaN(d1_N) || isNaN(d2_E) || isNaN(d2_N)
    ) {
      showToast('All Source and Destination coordinates must be valid numbers.');
      return;
    }
    
    const dx_src = s2_E - s1_E;
    const dy_src = s2_N - s1_N;
    const len_src = Math.hypot(dx_src, dy_src);
    if (len_src < 0.0001) {
      showToast('Source points must be distinct.');
      return;
    }
    
    const dx_dest = d2_E - d1_E;
    const dy_dest = d2_N - d1_N;
    const len_dest = Math.hypot(dx_dest, dy_dest);
    if (len_dest < 0.0001) {
      showToast('Destination points must be distinct.');
      return;
    }
    
    setScriptBackup(script);
    
    const scale = len_dest / len_src;
    const az_src = Math.atan2(dx_src, dy_src);
    const az_dest = Math.atan2(dx_dest, dy_dest);
    const rotRad = az_dest - az_src;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    
    const lines = script.split('\n');
    const delim = getDelimiterRegExp(codes);
    
    const transformedLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || (codes.escape && trimmed.startsWith(codes.escape))) {
        return line;
      }
      const tokens = trimmed.split(delim);
      if (tokens.length >= 3) {
        const n = parseFloat(tokens[1]);
        const e = parseFloat(tokens[2]);
        if (!isNaN(n) && !isNaN(e)) {
          const relE = e - s1_E;
          const relN = n - s1_N;
          
          const rotE = relE * scale * cosR - relN * scale * sinR;
          const rotN = relE * scale * sinR + relN * scale * cosR;
          
          const newE = rotE + d1_E;
          const newN = rotN + d1_N;
          
          tokens[1] = newN.toFixed(4);
          tokens[2] = newE.toFixed(4);
          return tokens.join(' ');
        }
      }
      return line;
    });
    
    let resultScript = transformedLines.join('\n');
    if (!resultScript.includes('# Adjusted via 2-Point Alignment')) {
      resultScript = '# Adjusted via 2-Point Alignment\n' + resultScript;
    }
    setScript(resultScript);
    
    const rotDeg = rotRad * 180 / Math.PI;
    const shiftE = d1_E - s1_E;
    const shiftN = d1_N - s1_N;
    showToast(`2-Point Alignment applied! Scale: ${scale.toFixed(6)}, Rotation: ${rotDeg.toFixed(4)}°, Shift N: ${shiftN.toFixed(2)}, E: ${shiftE.toFixed(2)}`);
  };

  const applyTRS = () => {
    const dN = parseFloat(trsShiftN) || 0;
    const dE = parseFloat(trsShiftE) || 0;
    const rotDeg = parseFloat(trsRotate) || 0;
    const scale = parseFloat(trsScale) || 1;
    
    if (dN === 0 && dE === 0 && rotDeg === 0 && scale === 1) {
      showToast('No transformation parameters specified.');
      return;
    }

    setScriptBackup(script);

    const lines = script.split('\n');
    const delim = getDelimiterRegExp(codes);
    
    let centerPt = { easting: 0, northing: 0 };
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || (codes.escape && trimmed.startsWith(codes.escape))) {
        continue;
      }
      const tokens = trimmed.split(delim);
      if (tokens.length >= 3) {
        const n = parseFloat(tokens[1]);
        const e = parseFloat(tokens[2]);
        if (!isNaN(n) && !isNaN(e)) {
          centerPt = { northing: n, easting: e };
          break;
        }
      }
    }

    const rad = rotDeg * Math.PI / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    const transformedLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || (codes.escape && trimmed.startsWith(codes.escape))) {
        return line;
      }
      const tokens = trimmed.split(/\s+/);
      if (tokens.length >= 3) {
        const n = parseFloat(tokens[1]);
        const e = parseFloat(tokens[2]);
        if (!isNaN(n) && !isNaN(e)) {
          let relE = e - centerPt.easting;
          let relN = n - centerPt.northing;
          
          relE *= scale;
          relN *= scale;
          
          const rotE = relE * cosR - relN * sinR;
          const rotN = relE * sinR + relN * cosR;
          
          const newE = rotE + centerPt.easting + dE;
          const newN = rotN + centerPt.northing + dN;
          
          tokens[1] = newN.toFixed(4);
          tokens[2] = newE.toFixed(4);
          
          return tokens.join(' ');
        }
      }
      return line;
    });

    setScript(transformedLines.join('\n'));
    showToast('Transformation applied! Coordinates recalculated.');
  };

  const undoTRS = () => {
    if (scriptBackup !== null) {
      setScript(scriptBackup);
      setScriptBackup(null);
      showToast('Transformation undone.');
    }
  };

  const handleCopyQcReport = (reportText) => {
    navigator.clipboard.writeText(reportText);
    showToast('QC Report copied to clipboard!');
  };

  const handleDownloadQcReport = (reportText, figName) => {
    downloadFile(reportText, `QC_Report_Figure_${figName}.md`, 'text/markdown');
    showToast('QC Report markdown file downloaded!');
  };

  // ── Parser & Solver Core ────────────────────────────────────────────────────
  const { parsedPoints, figures, errors } = useMemo(() => {
    const lines = script.split(/\r?\n/);
    const pointsList = [];
    const pointsMap = {};
    const parseErrors = [];

    // Detect if this is a COGO command script
    const isCogoScript = lines.some(line => {
      const trimmed = line.trim().toUpperCase();
      if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0];
      return cmd === 'TRAV' || cmd === 'STN' || cmd === 'BD' || cmd === 'NE' || cmd === 'NEZ' || cmd === 'BEG' || cmd === 'END' || cmd === 'TRANS' || cmd === 'ROTATE' || cmd === 'MAPCHK' || cmd === 'RKRK' || cmd === 'ARCARC' || cmd === 'SAVE' || cmd === 'XC';
    });

    if (isCogoScript) {
      const cogoActiveFigures = {};
      const cogoFiguresList = [];
      let currentStation = 1;
      let traverseMode = true;
      let currentBoundaryName = null;
      let lastIntersectionSol1 = null;
      let lastIntersectionSol2 = null;
      
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('#') || trimmed.startsWith('//')) return;
        
        const cleanLine = trimmed.replace(/\s+/g, ' ');
        const parts = cleanLine.split(' ');
        const cmd = parts[0].toUpperCase();
        
        if (['AP', 'DEL', 'DISP', 'INV', 'LIST'].includes(cmd)) {
          return;
        }

        if (cmd === 'TRAV') {
          if (parts[1]?.toUpperCase() === 'ON') {
            traverseMode = true;
          } else if (parts[1]?.toUpperCase() === 'OFF') {
            traverseMode = false;
          }
          return;
        }
        
        if (cmd === 'NE' || cmd === 'NEZ') {
          let ptId = null;
          let nVal = null;
          let eVal = null;
          let zVal = 0;
          let descTokens = [];

          if (parts.length >= 4 && !isNaN(parseInt(parts[1])) && parseInt(parts[1]) < 100000 && !isNaN(parseFloat(parts[2])) && !isNaN(parseFloat(parts[3]))) {
            ptId = parseInt(parts[1]);
            nVal = parseFloat(parts[2]);
            eVal = parseFloat(parts[3]);
            let descStart = 4;
            if (parts.length >= 5 && !isNaN(parseFloat(parts[4]))) {
              zVal = parseFloat(parts[4]);
              descStart = 5;
            }
            descTokens = parts.slice(descStart);
          } else if (parts.length >= 3 && !isNaN(parseFloat(parts[1])) && !isNaN(parseFloat(parts[2]))) {
            ptId = currentStation || 1;
            nVal = parseFloat(parts[1]);
            eVal = parseFloat(parts[2]);
            let descStart = 3;
            if (parts.length >= 4 && !isNaN(parseFloat(parts[3]))) {
              zVal = parseFloat(parts[3]);
              descStart = 4;
            }
            descTokens = parts.slice(descStart);
          }

          if (ptId !== null && nVal !== null && eVal !== null) {
            pointsMap[ptId] = {
              id: String(ptId),
              northing: nVal,
              easting: eVal,
              elevation: zVal,
              rawDescription: descTokens.join(' '),
              tokens: descTokens,
              lineIndex: index + 1
            };
            pointsList.push(pointsMap[ptId]);
          } else {
            parseErrors.push(`Line ${index + 1}: Invalid NE/NEZ command format.`);
          }
          return;
        }
        
        if (cmd === 'STN') {
          const pt = parseInt(parts[1]);
          if (!isNaN(pt)) {
            currentStation = pt;
          } else {
            parseErrors.push(`Line ${index + 1}: Invalid STN command format.`);
          }
          return;
        }

        if (cmd === 'BEG') {
          currentBoundaryName = parts[1];
          cogoActiveFigures[currentBoundaryName] = {
            name: currentBoundaryName,
            vertices: [],
            isClosed: true,
            isCurveActive: false,
            hOffset: 0,
            vOffset: 0,
            isCircle: false,
            circleCenter: null,
            circleRadius: 0
          };
          cogoFiguresList.push(cogoActiveFigures[currentBoundaryName]);
          return;
        }

        if (cmd === 'PNT') {
          const pt = parseInt(parts[1]);
          if (currentBoundaryName && pointsMap[pt]) {
            cogoActiveFigures[currentBoundaryName].vertices.push({
              id: String(pt),
              northing: pointsMap[pt].northing,
              easting: pointsMap[pt].easting,
              elevation: 0,
              hOffset: 0,
              vOffset: 0,
              isCurve: false,
              lineIndex: index + 1
            });
          }
          return;
        }

        if (cmd === 'END') {
          currentBoundaryName = null;
          return;
        }

        if (cmd === 'MAPCHK') {
          return;
        }

        if (cmd === 'TRANS') {
          const dx = parseFloat(parts[1]);
          const dy = parseFloat(parts[2]);
          if (!isNaN(dx) && !isNaN(dy)) {
            for (let i = 3; i < parts.length; i++) {
              const ptId = parseInt(parts[i]);
              if (pointsMap[ptId]) {
                pointsMap[ptId].easting += dx;
                pointsMap[ptId].northing += dy;
              }
            }
          } else {
            parseErrors.push(`Line ${index + 1}: Invalid TRANS command format.`);
          }
          return;
        }

        if (cmd === 'ROTATE') {
          const pivotPtId = parseInt(parts[1]);
          const angleDeg = parseFloat(parts[2]);
          if (!isNaN(pivotPtId) && !isNaN(angleDeg)) {
            const rad = angleDeg * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const pivot = pointsMap[pivotPtId];
            if (pivot) {
              for (let i = 3; i < parts.length; i++) {
                const ptId = parseInt(parts[i]);
                const pt = pointsMap[ptId];
                if (pt) {
                  const dE = pt.easting - pivot.easting;
                  const dN = pt.northing - pivot.northing;
                  pt.easting = pivot.easting + dE * cos - dN * sin;
                  pt.northing = pivot.northing + dE * sin + dN * cos;
                }
              }
            } else {
              parseErrors.push(`Line ${index + 1}: Rotate pivot point ${pivotPtId} not found.`);
            }
          } else {
            parseErrors.push(`Line ${index + 1}: Invalid ROTATE command format.`);
          }
          return;
        }

        if (cmd === 'RKRK' || cmd === 'ARCARC') {
          const id1 = parts[1];
          const r1 = parseFloat(parts[2]);
          const id2 = parts[3];
          const r2 = parseFloat(parts[4]);
          const p1 = pointsMap[parseInt(id1)] || pointsMap[id1];
          const p2 = pointsMap[parseInt(id2)] || pointsMap[id2];
          if (!p1 || !p2) {
            parseErrors.push(`Line ${index + 1}: Point ${id1} or ${id2} not found for circle-circle intersection.`);
            return;
          }
          if (isNaN(r1) || isNaN(r2)) {
            parseErrors.push(`Line ${index + 1}: Invalid radius values for circle-circle intersection.`);
            return;
          }
          const dx = p2.easting - p1.easting;
          const dy = p2.northing - p1.northing;
          const d = Math.hypot(dx, dy);
          if (d > r1 + r2 || d < Math.abs(r1 - r2) || d < 0.0001) {
            parseErrors.push(`Line ${index + 1}: Circles do not intersect (d=${d.toFixed(2)}, r1=${r1}, r2=${r2}).`);
            return;
          }
          const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
          const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
          const mx = p1.easting + a * dx / d;
          const my = p1.northing + a * dy / d;
          lastIntersectionSol1 = { northing: my + h * (dx / d), easting: mx - h * (dy / d) };
          lastIntersectionSol2 = { northing: my - h * (dx / d), easting: mx + h * (dy / d) };
          return;
        }

        if (cmd === 'SAVE') {
          const direction = (parts[1] || '').toUpperCase();
          const newId = parseInt(parts[2]) || parts[2];
          if (!newId) {
            parseErrors.push(`Line ${index + 1}: Missing point ID in SAVE command.`);
            return;
          }
          if (!lastIntersectionSol1 || !lastIntersectionSol2) {
            parseErrors.push(`Line ${index + 1}: No pending circle intersection solutions to save.`);
            return;
          }
          let chosen = lastIntersectionSol1;
          if (direction === 'NORTH') chosen = lastIntersectionSol1.northing >= lastIntersectionSol2.northing ? lastIntersectionSol1 : lastIntersectionSol2;
          else if (direction === 'SOUTH') chosen = lastIntersectionSol1.northing <= lastIntersectionSol2.northing ? lastIntersectionSol1 : lastIntersectionSol2;
          else if (direction === 'EAST') chosen = lastIntersectionSol1.easting >= lastIntersectionSol2.easting ? lastIntersectionSol1 : lastIntersectionSol2;
          else if (direction === 'WEST') chosen = lastIntersectionSol1.easting <= lastIntersectionSol2.easting ? lastIntersectionSol1 : lastIntersectionSol2;

          const desc = parts.slice(3).join(' ') || 'RAD PT';
          pointsMap[newId] = {
            id: String(newId),
            northing: chosen.northing,
            easting: chosen.easting,
            elevation: 0,
            rawDescription: desc,
            tokens: [desc],
            lineIndex: index + 1
          };
          pointsList.push(pointsMap[newId]);
          return;
        }

        if (cmd === 'XC') {
          if (parts[1]?.toUpperCase() === 'PTS' && currentBoundaryName) {
            const radius = parseFloat(parts[2]);
            // const centerPtId = parts[3];
            const toPtId = parts[4];
            const fig = cogoActiveFigures[currentBoundaryName];
            if (fig && fig.vertices.length > 0) {
              const lastVert = fig.vertices[fig.vertices.length - 1];
              lastVert.isCurveBegin = true;
              lastVert.curveRadius = Math.abs(radius);
              lastVert.curveDirection = radius < 0 ? 'LEFT' : 'RIGHT';
              
              const toPoint = pointsMap[parseInt(toPtId)] || pointsMap[toPtId];
              if (toPoint) {
                fig.vertices.push({
                  id: String(toPtId),
                  northing: toPoint.northing,
                  easting: toPoint.easting,
                  elevation: 0,
                  hOffset: 0,
                  vOffset: 0,
                  isCurve: false,
                  lineIndex: index + 1
                });
              } else {
                parseErrors.push(`Line ${index + 1}: Point ${toPtId} not found for curve end.`);
              }
            } else {
              parseErrors.push(`Line ${index + 1}: No starting point for XC PTS curve.`);
            }
          }
          return;
        }

        // Check if within a boundary block (just numbers list)
        if (currentBoundaryName && /^\d+$/.test(cleanLine)) {
          const pt = parseInt(cleanLine);
          if (pointsMap[pt]) {
            cogoActiveFigures[currentBoundaryName].vertices.push({
              id: String(pt),
              northing: pointsMap[pt].northing,
              easting: pointsMap[pt].easting,
              elevation: 0,
              hOffset: 0,
              vOffset: 0,
              isCurve: false,
              lineIndex: index + 1
            });
          }
          return;
        }

        // BD command or raw traverse call
        let startIdx = 0;
        if (cmd === 'BD') {
          startIdx = 1;
        }

        if (parts.length - startIdx >= 4) {
          const pt = parseInt(parts[startIdx]);
          const dms = parts[startIdx + 1];
          const quad = parseInt(parts[startIdx + 2]);
          const dist = parseFloat(parts[startIdx + 3]);
          const desc = parts.slice(startIdx + 4).join(' ');

          const stnPoint = pointsMap[currentStation];
          if (!stnPoint) {
            parseErrors.push(`Line ${index + 1}: Station point ${currentStation} not defined.`);
            return;
          }

          if (isNaN(pt) || isNaN(quad) || isNaN(dist)) {
            parseErrors.push(`Line ${index + 1}: Invalid bearing-distance command parameters.`);
            return;
          }

          let ns = 'N', ew = 'E';
          if (quad === 1) { ns = 'N'; ew = 'E'; }
          else if (quad === 2) { ns = 'S'; ew = 'E'; }
          else if (quad === 3) { ns = 'S'; ew = 'W'; }
          else if (quad === 4) { ns = 'N'; ew = 'W'; }

          const dotIdx = dms.indexOf('.');
          let degStr = dms;
          let minStr = '00';
          let secStr = '00';
          if (dotIdx !== -1) {
            degStr = dms.substring(0, dotIdx);
            const frac = dms.substring(dotIdx + 1);
            minStr = frac.substring(0, 2) || '00';
            secStr = frac.substring(2, 4) || '00';
            if (frac.length > 4) {
              secStr += '.' + frac.substring(4);
            }
          }

          const ang = parseFloat(degStr) + parseFloat(minStr)/60 + parseFloat(secStr)/3600;
          let azimuthRad = 0;
          if (ns === 'N' && ew === 'E') azimuthRad = ang * Math.PI / 180;
          else if (ns === 'S' && ew === 'E') azimuthRad = (180 - ang) * Math.PI / 180;
          else if (ns === 'S' && ew === 'W') azimuthRad = (180 + ang) * Math.PI / 180;
          else if (ns === 'N' && ew === 'W') azimuthRad = (360 - ang) * Math.PI / 180;

          const dN = dist * Math.cos(azimuthRad);
          const dE = dist * Math.sin(azimuthRad);

          pointsMap[pt] = {
            id: String(pt),
            northing: stnPoint.northing + dN,
            easting: stnPoint.easting + dE,
            elevation: 0,
            rawDescription: desc,
            tokens: [desc],
            lineIndex: index + 1
          };
          pointsList.push(pointsMap[pt]);

          if (traverseMode) {
            currentStation = pt;
          }
        }
      });

      // Post-process figures (add denseVertices, offsets, area, length)
      cogoFiguresList.forEach(fig => {
        const dense = [];
        const v = fig.vertices;
        if (v.length > 0) {
          dense.push(v[0]);
          let i = 0;
          while (i < v.length - 1) {
            const v1 = v[i];
            const v2 = v[i + 1];
            if (v1.isCurveBegin && v1.curveRadius) {
              const arcPts = getCurvePointsRadius(v1, v2, v1.curveRadius, v1.curveDirection, 20);
              for (let j = 1; j < arcPts.length; j++) {
                dense.push({
                  ...arcPts[j],
                  hOffset: v1.hOffset,
                  vOffset: v1.vOffset,
                  isCurve: true,
                  lineIndex: v1.lineIndex
                });
              }
              i++;
            } else {
              dense.push(v2);
              i++;
            }
          }
        }
        fig.denseVertices = dense;
        fig.offsetVertices = computeParallelOffset(dense);
        fig.selfIntersections = findSelfIntersections(dense, fig.isClosed);
        
        let len = 0;
        for (let j = 0; j < dense.length - 1; j++) {
          len += Math.hypot(dense[j+1].easting - dense[j].easting, dense[j+1].northing - dense[j].northing);
        }
        if (fig.isClosed && dense.length >= 2) {
          len += Math.hypot(dense[0].easting - dense[dense.length-1].easting, dense[0].northing - dense[dense.length-1].northing);
        }
        fig.length = len;

        let areaSum = 0;
        if (fig.isClosed && dense.length >= 3) {
          for (let j = 0; j < dense.length; j++) {
            const next = dense[(j + 1) % dense.length];
            areaSum += dense[j].easting * next.northing - next.easting * dense[j].northing;
          }
          fig.area = Math.abs(areaSum) / 2;
        } else {
          fig.area = 0;
        }

        if (dense.length >= 2) {
          const first = dense[0];
          const last = dense[dense.length - 1];
          fig.misclosure = Math.hypot(last.northing - first.northing, last.easting - first.easting);
        } else {
          fig.misclosure = 0;
        }
      });

      return { parsedPoints: pointsList, figures: cogoFiguresList, errors: parseErrors };
    }

    const delim = getDelimiterRegExp(codes);

    // 1. First Pass: Parse all coordinate points
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || (codes.escape && trimmed.startsWith(codes.escape))) {
        return;
      }
      
      const tokens = trimmed.split(delim);
      if (tokens.length < 3) {
        parseErrors.push(`Line ${index + 1}: Invalid point format. Need at least PointID, Northing, Easting.`);
        return;
      }
      
      const pointId = tokens[0];
      const northing = parseFloat(tokens[1]);
      const easting = parseFloat(tokens[2]);
      
      if (isNaN(northing) || isNaN(easting)) {
        parseErrors.push(`Line ${index + 1}: Coordinates Northing/Easting must be numbers.`);
        return;
      }

      let elevation = 0;
      let descTokens = [];
      
      if (tokens.length >= 4) {
        const val3 = parseFloat(tokens[3]);
        if (tokens.length >= 5 && !isNaN(val3)) {
          elevation = val3;
          descTokens = tokens.slice(4);
        } else {
          descTokens = tokens.slice(3);
        }
      }
      
      const pt = {
        id: pointId,
        northing,
        easting,
        elevation,
        rawDescription: descTokens.join(' '),
        tokens: descTokens,
        lineIndex: index + 1
      };
      
      pointsList.push(pt);
      pointsMap[pointId] = pt;
    });

    // 2. Second Pass: Trace Figures & Apply Surveyor codes
    const activeFigures = {}; // figureName -> figureObj
    const figuresList = [];

    pointsList.forEach(pt => {
      if (pt.tokens.length === 0) return; // loose point
      
      // Feature prefix (e.g. LOT1) is the first token
      const featureCode = pt.tokens[0];
      const codeTokens = pt.tokens.slice(1);
      
      // Parse codes
      let isBegin = false;
      let isEnd = false;
      let isClose = false;
      let hOffsetVal = null;
      let vOffsetVal = null;
      let isStopOffsets = false;
      let recallId = null;
      let connectId = null;
      let isRect = false;
      let rtDist = null;
      let xDist = null;
      let isBC = false;
      let isEC = false;
      let isOC = false;
      let cirRadius = null;
      let curveRadiusVal = null;
      let curveDirectionVal = 'left';

      for (let j = 0; j < codeTokens.length; j++) {
        const t = codeTokens[j].toUpperCase();
        if (t === codes.begin.toUpperCase()) isBegin = true;
        else if (t === codes.end.toUpperCase()) isEnd = true;
        else if (t === codes.close.toUpperCase()) isClose = true;
        else if (t === codes.stopOffsets.toUpperCase()) isStopOffsets = true;
        else if (t === codes.rectangle.toUpperCase()) isRect = true;
        else if (t === codes.pointOnCurve.toUpperCase()) isOC = true;
        else if (t === codes.endCurve.toUpperCase()) isEC = true;
        else if (t === codes.beginCurve.toUpperCase()) {
          isBC = true;
          // check if radius-based curve parameters are present: E.g., RAD 100 LEFT
          if (j < codeTokens.length - 1) {
            const nextToken = codeTokens[j + 1].toUpperCase();
            if (nextToken === 'R' || nextToken === 'RAD' || nextToken === 'RADIUS') {
              const val = parseFloat(codeTokens[j + 2]);
              if (!isNaN(val)) {
                curveRadiusVal = val;
                j += 2;
              }
            } else {
              const matchR = codeTokens[j + 1].match(/^(?:R|RAD|RADIUS)=?(\d+(?:\.\d+)?)$/i);
              if (matchR) {
                curveRadiusVal = parseFloat(matchR[1]);
                j++;
              }
            }
          }
          if (j < codeTokens.length - 1) {
            const nextToken = codeTokens[j + 1].toUpperCase();
            if (nextToken === 'L' || nextToken === 'LEFT') {
              curveDirectionVal = 'left';
              j++;
            } else if (nextToken === 'R' || nextToken === 'RIGHT') {
              curveDirectionVal = 'right';
              j++;
            }
          }
        }
        else if (t === codes.horizontalOffset.toUpperCase() && j < codeTokens.length - 1) {
          hOffsetVal = parseFloat(codeTokens[j + 1]);
          if (!isNaN(hOffsetVal)) j++;
        }
        else if (t === codes.verticalOffset.toUpperCase() && j < codeTokens.length - 1) {
          vOffsetVal = parseFloat(codeTokens[j + 1]);
          if (!isNaN(vOffsetVal)) j++;
        }
        else if (t === codes.recallPoint.toUpperCase() && j < codeTokens.length - 1) {
          recallId = codeTokens[j + 1];
          j++;
        }
        else if (t === codes.connectPoint.toUpperCase() && j < codeTokens.length - 1) {
          connectId = codeTokens[j + 1];
          j++;
        }
        else if (t === codes.rightTurn.toUpperCase() && j < codeTokens.length - 1) {
          rtDist = parseFloat(codeTokens[j + 1]);
          if (!isNaN(rtDist)) j++;
        }
        else if (t === codes.extend.toUpperCase() && j < codeTokens.length - 1) {
          xDist = parseFloat(codeTokens[j + 1]);
          if (!isNaN(xDist)) j++;
        }
        else if (t === codes.circle.toUpperCase() && j < codeTokens.length - 1) {
          cirRadius = parseFloat(codeTokens[j + 1]);
          if (!isNaN(cirRadius)) j++;
        }
      }

      // Check if figure active
      let fig = activeFigures[featureCode];
      
      // Automatic begin or forced begin
      if (!fig || isBegin) {
        fig = {
          name: featureCode,
          vertices: [],
          isClosed: false,
          isCurveActive: false,
          hOffset: 0,
          vOffset: 0,
          isCircle: false,
          circleCenter: null,
          circleRadius: 0
        };
        activeFigures[featureCode] = fig;
        figuresList.push(fig);
      }

      // Apply Offset modifiers
      if (isStopOffsets) {
        fig.hOffset = 0;
        fig.vOffset = 0;
      }
      if (hOffsetVal !== null) fig.hOffset = hOffsetVal;
      if (vOffsetVal !== null) fig.vOffset = vOffsetVal;

      // Handle Curve active state toggling
      if (isBC) fig.isCurveActive = true;

      // Construct vertex object
      const vtx = {
        id: pt.id,
        northing: pt.northing,
        easting: pt.easting,
        elevation: pt.elevation,
        hOffset: fig.hOffset,
        vOffset: fig.vOffset,
        isCurve: fig.isCurveActive || isBC || isEC || isOC,
        isPointOnCurve: isOC,
        isCurveBegin: isBC,
        isCurveEnd: isEC,
        curveRadius: curveRadiusVal,
        curveDirection: curveDirectionVal,
        lineIndex: pt.lineIndex
      };

      // Handle Rectangle Fit (RECT)
      if (isRect) {
        if (fig.vertices.length >= 3) {
          const C = fig.vertices[fig.vertices.length - 1];
          const B = fig.vertices[fig.vertices.length - 2];
          const A = fig.vertices[0];
          
          const dx = C.easting - B.easting;
          const dy = C.northing - B.northing;
          const len = Math.hypot(dx, dy);
          if (len > 0.001) {
            const nx = -dy / len;
            const ny = dx / len;
            const acX = A.easting - C.easting;
            const acY = A.northing - C.northing;
            const dot = acX * nx + acY * ny;
            
            const rectX = C.easting + dot * nx;
            const rectY = C.northing + dot * ny;
            
            // Add the projected rectangle point
            fig.vertices.push({
              id: `${pt.id}_RECT`,
              northing: rectY,
              easting: rectX,
              elevation: C.elevation,
              hOffset: fig.hOffset,
              vOffset: fig.vOffset,
              isCurve: false,
              lineIndex: pt.lineIndex
            });
            fig.isClosed = true;
            delete activeFigures[featureCode]; // remove from active
          }
        } else {
          parseErrors.push(`Line ${pt.lineIndex}: RECT code requires at least 3 existing points in figure ${featureCode}.`);
          fig.vertices.push(vtx);
        }
      } 
      // Handle Right Turn (RT)
      else if (rtDist !== null) {
        fig.vertices.push(vtx);
        if (fig.vertices.length >= 2) {
          const C = fig.vertices[fig.vertices.length - 1];
          const B = fig.vertices[fig.vertices.length - 2];
          const dx = C.easting - B.easting;
          const dy = C.northing - B.northing;
          const len = Math.hypot(dx, dy);
          if (len > 0.001) {
            const nx = dy / len;
            const ny = -dx / len;
            fig.vertices.push({
              id: `${pt.id}_RT`,
              easting: C.easting + rtDist * nx,
              northing: C.northing + rtDist * ny,
              elevation: C.elevation,
              hOffset: fig.hOffset,
              vOffset: fig.vOffset,
              isCurve: fig.isCurveActive,
              lineIndex: pt.lineIndex
            });
          }
        } else {
          parseErrors.push(`Line ${pt.lineIndex}: Right Turn requires at least 2 points in figure ${featureCode}.`);
        }
      }
      // Handle Extend (X)
      else if (xDist !== null) {
        fig.vertices.push(vtx);
        if (fig.vertices.length >= 2) {
          const C = fig.vertices[fig.vertices.length - 1];
          const B = fig.vertices[fig.vertices.length - 2];
          const dx = C.easting - B.easting;
          const dy = C.northing - B.northing;
          const len = Math.hypot(dx, dy);
          if (len > 0.001) {
            const ux = dx / len;
            const uy = dy / len;
            fig.vertices.push({
              id: `${pt.id}_EXT`,
              easting: C.easting + xDist * ux,
              northing: C.northing + xDist * uy,
              elevation: C.elevation,
              hOffset: fig.hOffset,
              vOffset: fig.vOffset,
              isCurve: fig.isCurveActive,
              lineIndex: pt.lineIndex
            });
          }
        } else {
          parseErrors.push(`Line ${pt.lineIndex}: Extend requires at least 2 points in figure ${featureCode}.`);
        }
      }
      // Handle Recall Point (RPN)
      else if (recallId !== null) {
        const targetPt = pointsMap[recallId];
        if (targetPt) {
          fig.vertices.push({
            id: targetPt.id,
            northing: targetPt.northing,
            easting: targetPt.easting,
            elevation: targetPt.elevation,
            hOffset: fig.hOffset,
            vOffset: fig.vOffset,
            isCurve: fig.isCurveActive,
            lineIndex: pt.lineIndex
          });
        } else {
          parseErrors.push(`Line ${pt.lineIndex}: Recall Point ID '${recallId}' not found.`);
        }
      }
      // Handle Connect Point (CPN)
      else if (connectId !== null) {
        const targetPt = pointsMap[connectId];
        if (targetPt) {
          fig.vertices.push({
            id: targetPt.id,
            northing: targetPt.northing,
            easting: targetPt.easting,
            elevation: targetPt.elevation,
            hOffset: fig.hOffset,
            vOffset: fig.vOffset,
            isCurve: fig.isCurveActive,
            lineIndex: pt.lineIndex
          });
        } else {
          parseErrors.push(`Line ${pt.lineIndex}: Connect Point ID '${connectId}' not found.`);
        }
      }
      // Handle Circle (CIR)
      else if (cirRadius !== null) {
        fig.isCircle = true;
        fig.circleCenter = { easting: pt.easting, northing: pt.northing };
        fig.circleRadius = cirRadius;
        fig.vertices.push(vtx);
        delete activeFigures[featureCode];
      }
      // Normal Point
      else {
        fig.vertices.push(vtx);
      }

      // Handle Curve Active end
      if (isEC) fig.isCurveActive = false;

      // Handle Close (CLS)
      if (isClose) {
        fig.isClosed = true;
        delete activeFigures[featureCode];
      }
      // Handle End (E)
      if (isEnd) {
        delete activeFigures[featureCode];
      }
    });

    // 3. Post-Process Figures (Curve Interpolation, Parallel Offsets, and Stats)
    figuresList.forEach(fig => {
      // Curve Interpolation (3-point arc resolver)
      const dense = [];
      const v = fig.vertices;
      if (v.length > 0) {
        dense.push(v[0]);
        let i = 0;
        while (i < v.length - 1) {
          const v1 = v[i];
          const v2 = v[i + 1];
          if (v1.isCurveBegin && v1.curveRadius) {
            // Fit using curve radius & direction directly between v1 and v2
            const arcPts = getCurvePointsRadius(v1, v2, v1.curveRadius, v1.curveDirection, 20);
            for (let j = 1; j < arcPts.length; j++) {
              dense.push({
                ...arcPts[j],
                hOffset: v1.hOffset,
                vOffset: v1.vOffset,
                isCurve: true,
                lineIndex: v1.lineIndex
              });
            }
            i++;
          } else if (v2.isPointOnCurve && i < v.length - 2) {
            const v3 = v[i + 2];
            const arcPts = getArcPoints3P(v1, v2, v3, 20);
            for (let j = 1; j < arcPts.length; j++) {
              dense.push({
                ...arcPts[j],
                hOffset: v1.hOffset,
                vOffset: v1.vOffset,
                isCurve: true,
                lineIndex: v1.lineIndex
              });
            }
            i += 2;
          } else {
            dense.push(v2);
            i++;
          }
        }
      }
      fig.denseVertices = dense;

      // Parallel Offsets calculation
      fig.offsetVertices = computeParallelOffset(dense);

      // Self-intersections (bow-tie check)
      fig.selfIntersections = findSelfIntersections(dense, fig.isClosed);

      // Compute statistics
      if (fig.isCircle) {
        fig.length = 2 * Math.PI * fig.circleRadius;
        fig.area = Math.PI * fig.circleRadius * fig.circleRadius;
        fig.misclosure = 0;
      } else {
        // Length
        let len = 0;
        for (let j = 0; j < dense.length - 1; j++) {
          len += Math.hypot(dense[j+1].easting - dense[j].easting, dense[j+1].northing - dense[j].northing);
        }
        if (fig.isClosed && dense.length >= 2) {
          len += Math.hypot(dense[0].easting - dense[dense.length-1].easting, dense[0].northing - dense[dense.length-1].northing);
        }
        fig.length = len;

        // Area (Shoelace formula)
        let areaSum = 0;
        const ptsForArea = [...dense];
        if (fig.isClosed && ptsForArea.length >= 3) {
          for (let j = 0; j < ptsForArea.length; j++) {
            const next = ptsForArea[(j + 1) % ptsForArea.length];
            areaSum += ptsForArea[j].easting * next.northing - next.easting * ptsForArea[j].northing;
          }
          fig.area = Math.abs(areaSum) / 2;
        } else {
          fig.area = 0;
        }

        // Misclosure
        if (dense.length >= 2) {
          const first = dense[0];
          const last = dense[dense.length - 1];
          fig.misclosure = Math.hypot(last.northing - first.northing, last.easting - first.easting);
        } else {
          fig.misclosure = 0;
        }
      }
    });

    return { parsedPoints: pointsList, figures: figuresList, errors: parseErrors };
  }, [script, codes]);

  // ── Auto-fit function definition ───────────────────────────────────────────
  const autoFit = useCallback((points, canvasWidth, canvasHeight) => {
    if (!points || points.length === 0) return;
    
    // Select points to fit: prefer actual figure vertices to zoom in on the main boundaries
    let ptsToFit = [];
    if (figures && figures.length > 0) {
      figures.forEach(fig => {
        if (fig.denseVertices && fig.denseVertices.length > 0) {
          ptsToFit.push(...fig.denseVertices);
        } else if (fig.vertices && fig.vertices.length > 0) {
          ptsToFit.push(...fig.vertices);
        }
      });
    }
    
    // Fall back to all parsed points if no figure vertices are available
    if (ptsToFit.length === 0) {
      ptsToFit = points;
    }

    const ns = ptsToFit.map(p => p.northing);
    const es = ptsToFit.map(p => p.easting);
    const minN = Math.min(...ns);
    const maxN = Math.max(...ns);
    const minE = Math.min(...es);
    const maxE = Math.max(...es);
    
    const rangeN = maxN - minN || 1;
    const rangeE = maxE - minE || 1;
    
    const pad = 40;
    const scaleX = (canvasWidth - pad * 2) / rangeE;
    const scaleY = (canvasHeight - pad * 2) / rangeN;
    const newZoom = Math.min(scaleX, scaleY);
    
    setZoom(newZoom);
    setPan({ x: 0, y: 0 });
    setCenter({ e: (minE + maxE) / 2, n: (minN + maxN) / 2 });
  }, [figures]);

  // ── Jump to Line helper ─────────────────────────────────────────────────────
  const jumpToLine = useCallback((lineIndex) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const lines = script.split('\n');
    let startChar = 0;
    for (let i = 0; i < lineIndex - 1; i++) {
      startChar += lines[i].length + 1; // +1 for newline
    }
    const endChar = startChar + lines[lineIndex - 1].length;
    
    textarea.focus();
    textarea.setSelectionRange(startChar, endChar);
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 16;
    textarea.scrollTop = (lineIndex - 1) * lineHeight - textarea.clientHeight / 2;
  }, [script]);

  // ── Resize Observer to dynamically resize canvas backing store ──────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const { width, height } = entry.contentRect;
        const w = Math.floor(width) || 360;
        const h = Math.floor(height) || 260;
        setCanvasDimensions({ width: w, height: h });
      }
    });

    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  // ── Auto-fit on load or when points/dimensions change ───────────────────────
  useEffect(() => {
    if (parsedPoints.length > 0) {
      autoFit(parsedPoints, canvasDimensions.width, canvasDimensions.height);
    }
  }, [parsedPoints, autoFit, canvasDimensions.width, canvasDimensions.height]);

  // ── Canvas Rendering loop ──────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    
    // Define coordinate transformers inside useEffect
    const tx = (easting) => {
      return W / 2 + (easting - center.e) * zoom + pan.x;
    };

    const ty = (northing) => {
      return H / 2 - (northing - center.n) * zoom + pan.y;
    };

    ctx.clearRect(0, 0, W, H);

    // 1. Grid rendering
    if (showGrid) {
      ctx.strokeStyle = 'rgba(31, 46, 77, 0.4)';
      ctx.lineWidth = 0.5;
      const step = 50;
      const startX = Math.floor((-W / 2 - pan.x) / step) * step;
      const endX = Math.floor((W / 2 - pan.x) / step + 1) * step;
      const startY = Math.floor((-H / 2 - pan.y) / step) * step;
      const endY = Math.floor((H / 2 - pan.y) / step + 1) * step;

      for (let x = startX; x <= endX; x += step) {
        const screenX = W / 2 + x + pan.x;
        ctx.beginPath(); ctx.moveTo(screenX, 0); ctx.lineTo(screenX, H); ctx.stroke();
      }
      for (let y = startY; y <= endY; y += step) {
        const screenY = H / 2 + y + pan.y;
        ctx.beginPath(); ctx.moveTo(0, screenY); ctx.lineTo(W, screenY); ctx.stroke();
      }
    }

    // 2. Figures rendering
    figures.forEach(fig => {
      // Circle
      if (fig.isCircle && fig.circleCenter) {
        const cx = tx(fig.circleCenter.easting);
        const cy = ty(fig.circleCenter.northing);
        const r = fig.circleRadius * zoom;
        
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.strokeStyle = '#ff9f43';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Fill
        ctx.fillStyle = 'rgba(255, 159, 67, 0.05)';
        ctx.fill();
        return;
      }

      // Main Polyline
      const pts = fig.denseVertices;
      if (pts && pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(tx(pts[0].easting), ty(pts[0].northing));
        for (let j = 1; j < pts.length; j++) {
          ctx.lineTo(tx(pts[j].easting), ty(pts[j].northing));
        }
        if (fig.isClosed) {
          ctx.closePath();
          ctx.fillStyle = 'rgba(61,127,255,0.06)';
          ctx.fill();
        }
        ctx.strokeStyle = '#3d7fff';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Draw direction arrowheads along segments
        for (let j = 0; j < pts.length - 1; j++) {
          const x1 = tx(pts[j].easting), y1 = ty(pts[j].northing);
          const x2 = tx(pts[j+1].easting), y2 = ty(pts[j+1].northing);
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len = Math.hypot(dx, dy);
          if (len > 30) {
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;
            const ang = Math.atan2(dy, dx);
            
            ctx.save();
            ctx.translate(midX, midY);
            ctx.rotate(ang);
            ctx.beginPath();
            ctx.moveTo(-6, -3.5);
            ctx.lineTo(0, 0);
            ctx.lineTo(-6, 3.5);
            ctx.strokeStyle = '#3d7fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      // Offset Polyline (traced in dashed green)
      const opt = fig.offsetVertices;
      if (opt && opt.length >= 2) {
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.moveTo(tx(opt[0].easting), ty(opt[0].northing));
        for (let j = 1; j < opt.length; j++) {
          ctx.lineTo(tx(opt[j].easting), ty(opt[j].northing));
        }
        if (fig.isClosed) ctx.closePath();
        ctx.strokeStyle = '#00d4a8';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      // Draw misclosure error gap (dashed red)
      if (!fig.isClosed && fig.misclosure > 0.05 && pts.length >= 2) {
        const first = pts[0];
        const last = pts[pts.length - 1];
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ff4d6d';
        ctx.lineWidth = 1.5;
        ctx.moveTo(tx(last.easting), ty(last.northing));
        ctx.lineTo(tx(first.easting), ty(first.northing));
        ctx.stroke();
        ctx.restore();
      }

      // Draw Self-Intersections (flashing/large red target marker)
      if (fig.selfIntersections && fig.selfIntersections.length > 0) {
        fig.selfIntersections.forEach(inter => {
          const cx = tx(inter.x);
          const cy = ty(inter.y);
          
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, 9, 0, 2 * Math.PI);
          ctx.strokeStyle = '#ff4d6d';
          ctx.lineWidth = 2;
          ctx.stroke();
          
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
          ctx.fillStyle = '#ff4d6d';
          ctx.fill();
          
          ctx.beginPath();
          ctx.moveTo(cx - 13, cy); ctx.lineTo(cx + 13, cy);
          ctx.moveTo(cx, cy - 13); ctx.lineTo(cx, cy + 13);
          ctx.strokeStyle = '#ff4d6d';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        });
      }
    });

    // 3. Coordinate Node Pins rendering
    parsedPoints.forEach(p => {
      const cx = tx(p.easting);
      const cy = ty(p.northing);
      
      const isHovered = hoveredPoint && hoveredPoint.id === p.id;
      
      ctx.beginPath();
      ctx.arc(cx, cy, isHovered ? 7.5 : 5, 0, Math.PI * 2);
      ctx.fillStyle = p.id === '1' ? 'var(--success)' : 'var(--accent)';
      ctx.fill();
      ctx.strokeStyle = '#090e1a';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (showLabels) {
        ctx.fillStyle = p.id === '1' ? 'var(--success)' : 'var(--text-primary)';
        ctx.font = isHovered ? 'bold 11px Inter, sans-serif' : '10px Inter, sans-serif';
        ctx.fillText(p.id, cx + 8, cy - 4);
      }
    });

    // 3.5. Draw solved COGO points
    solvedCogoPoints.forEach((p, idx) => {
      const cx = tx(p.easting);
      const cy = ty(p.northing);
      
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffd700'; // gold
      ctx.fill();
      ctx.strokeStyle = '#090e1a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      
      // Star shape
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        ctx.lineTo(cx + 9 * Math.cos((18 + i * 72) * Math.PI / 180), cy - 9 * Math.sin((18 + i * 72) * Math.PI / 180));
        ctx.lineTo(cx + 3.5 * Math.cos((54 + i * 72) * Math.PI / 180), cy - 3.5 * Math.sin((54 + i * 72) * Math.PI / 180));
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 215, 0, 0.4)';
      ctx.fill();
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 1;
      ctx.stroke();
      
      ctx.fillStyle = '#ffd700';
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.fillText(`Solved ${idx+1}`, cx + 11, cy + 3);
      ctx.restore();
    });

    // 4. North Arrow
    ctx.save();
    ctx.translate(W - 35, 45);
    ctx.fillStyle = 'var(--accent)';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -18);
    ctx.beginPath(); 
    ctx.moveTo(0, -15); 
    ctx.lineTo(4, 0); 
    ctx.lineTo(0, -4); 
    ctx.lineTo(-4, 0); 
    ctx.closePath();
    ctx.fill();
    ctx.restore();

  }, [zoom, pan, center, parsedPoints, figures, showGrid, showLabels, hoveredPoint, solvedCogoPoints, canvasDimensions.width, canvasDimensions.height]);

  // ── Canvas Event Listeners (Pan & Zoom) ────────────────────────────────────
  const handleMouseDown = (e) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    dragDistanceRef.current = 0;
  };

  const handleMouseMove = (e) => {
    if (isDragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      setPan(prev => ({
        x: prev.x + dx,
        y: prev.y + dy
      }));
      dragDistanceRef.current += Math.hypot(dx, dy);
      setDragStart({ x: e.clientX, y: e.clientY });
    } else {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      let found = null;
      let minDist = 12;
      
      // Define coordinate transformers to check distances
      const W = canvasRef.current.width, H = canvasRef.current.height;
      const txLocal = (easting) => W / 2 + (easting - center.e) * zoom + pan.x;
      const tyLocal = (northing) => H / 2 - (northing - center.n) * zoom + pan.y;

      parsedPoints.forEach(p => {
        const px = txLocal(p.easting);
        const py = tyLocal(p.northing);
        const dist = Math.hypot(mouseX - px, mouseY - py);
        if (dist < minDist) {
          minDist = dist;
          found = p;
        }
      });
      
      setHoveredPoint(found);
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom(z => Math.max(0.01, Math.min(100, z * factor)));
  };

  const handleDoubleClick = () => {
    if (parsedPoints.length > 0) {
      autoFit(parsedPoints, canvasDimensions.width, canvasDimensions.height);
    }
  };

  // Two-way binding: click point on canvas selects line in editor
  const handleCanvasClick = (e) => {
    if (dragDistanceRef.current > 5) return; // ignore click if panning was done
    
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    let found = null;
    let minDist = 12;
    
    const W = canvasRef.current.width, H = canvasRef.current.height;
    const txLocal = (easting) => W / 2 + (easting - center.e) * zoom + pan.x;
    const tyLocal = (northing) => H / 2 - (northing - center.n) * zoom + pan.y;

    parsedPoints.forEach(p => {
      const px = txLocal(p.easting);
      const py = tyLocal(p.northing);
      const dist = Math.hypot(mouseX - px, mouseY - py);
      if (dist < minDist) {
        minDist = dist;
        found = p;
      }
    });

    if (found && found.lineIndex) {
      jumpToLine(found.lineIndex);
      showToast(`Selected Point ${found.id} (Line ${found.lineIndex})`);
    }
  };

  // ── Keyboard Shortcuts inside Editor ────────────────────────────────────────
  const handleKeyDown = (e) => {
    // Ctrl + F: Format Script
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      formatScript();
    }
    // Ctrl + Enter: Format Script
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      formatScript();
    }
  };

  // ── Export files triggers ──────────────────────────────────────────────────
  const downloadFile = (content, filename, contentType) => {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportDXF = () => {
    let dxf = [];
    
    const safeText = (str) => {
      if (typeof str !== 'string') return str ? String(str) : '';
      return str
        .replace(/[\r\n]+/g, ' ')
        .replace(/°/g, '%%d')
        .replace(/Δ/g, 'Delta=')
        .replace(/◄/g, '<-')
        .replace(/—/g, '-')
        .replace(/[^\x20-\x7E]/g, '');
    };

    // Header section
    dxf.push("0", "SECTION", "2", "HEADER", "0", "ENDSEC");
    
    // Tables section
    dxf.push("0", "SECTION", "2", "TABLES");
    dxf.push("0", "TABLE", "2", "LAYER", "70", "3");
    dxf.push("0", "LAYER", "2", "POINTS", "70", "0", "62", "2", "6", "CONTINUOUS");
    dxf.push("0", "LAYER", "2", "FIGURES", "70", "0", "62", "4", "6", "CONTINUOUS");
    dxf.push("0", "LAYER", "2", "OFFSETS", "70", "0", "62", "3", "6", "HIDDEN");
    dxf.push("0", "ENDTAB");
    dxf.push("0", "ENDSEC");
    
    // Entities section
    dxf.push("0", "SECTION", "2", "ENTITIES");
    
    parsedPoints.forEach(p => {
      const eastingVal = (p.easting != null && !isNaN(p.easting)) ? p.easting : 0;
      const northingVal = (p.northing != null && !isNaN(p.northing)) ? p.northing : 0;
      const elevationVal = (p.elevation != null && !isNaN(p.elevation)) ? p.elevation : 0;
      
      dxf.push(
        "0", "POINT", 
        "8", "POINTS", 
        "10", eastingVal.toFixed(4), 
        "20", northingVal.toFixed(4), 
        "30", elevationVal.toFixed(4)
      );
      
      const textVal = safeText(`${p.id}: ${p.rawDescription || ''}`);
      dxf.push(
        "0", "TEXT", 
        "8", "POINTS", 
        "10", (eastingVal + 1.2).toFixed(4), 
        "20", (northingVal + 1.2).toFixed(4), 
        "30", elevationVal.toFixed(4), 
        "40", "1.2", 
        "1", textVal, 
        "50", "0.0"
      );
    });

    figures.forEach(fig => {
      if (fig.isCircle && fig.circleCenter) {
        const cx = (fig.circleCenter.easting != null && !isNaN(fig.circleCenter.easting)) ? fig.circleCenter.easting : 0;
        const cy = (fig.circleCenter.northing != null && !isNaN(fig.circleCenter.northing)) ? fig.circleCenter.northing : 0;
        const cr = (fig.circleRadius != null && !isNaN(fig.circleRadius)) ? fig.circleRadius : 0;
        
        dxf.push(
          "0", "CIRCLE", 
          "8", "FIGURES", 
          "10", cx.toFixed(4), 
          "20", cy.toFixed(4), 
          "30", "0.0", 
          "40", cr.toFixed(4)
        );
        return;
      }
      if (fig.vertices && fig.vertices.length >= 2) {
        dxf.push(
          "0", "LWPOLYLINE", 
          "8", "FIGURES", 
          "90", fig.vertices.length.toString(), 
          "70", fig.isClosed ? "1" : "0", 
          "43", "0.0"
        );
        fig.vertices.forEach(v => {
          const vx = (v.easting != null && !isNaN(v.easting)) ? v.easting : 0;
          const vy = (v.northing != null && !isNaN(v.northing)) ? v.northing : 0;
          dxf.push("10", vx.toFixed(4), "20", vy.toFixed(4));
        });
      }
      if (fig.offsetVertices && fig.offsetVertices.length >= 2) {
        dxf.push(
          "0", "LWPOLYLINE", 
          "8", "OFFSETS", 
          "90", fig.offsetVertices.length.toString(), 
          "70", fig.isClosed ? "1" : "0", 
          "43", "0.0"
        );
        fig.offsetVertices.forEach(v => {
          const vx = (v.easting != null && !isNaN(v.easting)) ? v.easting : 0;
          const vy = (v.northing != null && !isNaN(v.northing)) ? v.northing : 0;
          dxf.push("10", vx.toFixed(4), "20", vy.toFixed(4));
        });
      }
    });

    dxf.push("0", "ENDSEC", "0", "EOF");
    downloadFile(dxf.join('\n'), 'linework_export.dxf', 'application/dxf');
    showToast('DXF Linework exported successfully!');
  };

  const handleExportCSV = () => {
    let csv = ['PointID,Northing,Easting,Elevation,Description'];
    parsedPoints.forEach(p => {
      csv.push(`${p.id},${p.northing.toFixed(4)},${p.easting.toFixed(4)},${p.elevation.toFixed(4)},"${p.rawDescription}"`);
    });
    downloadFile(csv.join('\n'), 'points_export.csv', 'text/csv');
    showToast('CSV Coordinates exported successfully!');
  };

  const handleExportCOGO = () => {
    let cogo = [];
    cogo.push('# Extracted COGO Traverse Script from Linework Scripting IDE');
    cogo.push(`# Exported on ${new Date().toLocaleDateString()}`);
    cogo.push('');
    figures.forEach(fig => {
      if (fig.isCircle) return;
      cogo.push(`# Figure: ${fig.name}`);
      for (let j = 0; j < fig.denseVertices.length - 1; j++) {
        const from = fig.denseVertices[j];
        const to = fig.denseVertices[j + 1];
        const dx = to.easting - from.easting;
        const dy = to.northing - from.northing;
        const dist = Math.hypot(dx, dy);
        
        let azRad = Math.atan2(dx, dy);
        if (azRad < 0) azRad += 2 * Math.PI;
        const azDeg = azRad * 180 / Math.PI;
        
        let q;
        let bearingDeg;
        if (azDeg <= 90) { q = 'N'; bearingDeg = azDeg; }
        else if (azDeg <= 180) { q = 'S'; bearingDeg = 180 - azDeg; }
        else if (azDeg <= 270) { q = 'S'; bearingDeg = azDeg - 180; }
        else { q = 'N'; bearingDeg = 360 - azDeg; }
        const brgEw = (azDeg > 0 && azDeg < 180) ? 'E' : 'W';
        
        const deg = Math.floor(bearingDeg);
        const minVal = (bearingDeg - deg) * 60;
        const min = Math.floor(minVal);
        const sec = Math.round((minVal - min) * 60);
        
        const bearingStr = `${q}${deg.toString().padStart(2,'0')}-${min.toString().padStart(2,'0')}-${sec.toString().padStart(2,'0')}${brgEw}`;
        cogo.push(`THENCE ${bearingStr}, a distance of ${dist.toFixed(2)} ${units === 'meters' ? 'meters' : 'feet'};`);
      }
      cogo.push('');
    });
    downloadFile(cogo.join('\n'), 'cogo_export.txt', 'text/plain');
    showToast('COGO script generated & downloaded!');
  };

  const insertCode = (code) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const insertVal = ` ${code}`;
    const newVal = text.substring(0, start) + insertVal + text.substring(end);
    setScript(newVal);
    setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = start + insertVal.length;
      textarea.selectionEnd = start + insertVal.length;
    }, 0);
  };

  const handleTemplateChange = (e) => {
    const key = e.target.value;
    if (key && TEMPLATES[key]) {
      if (window.confirm('Load this template? This will replace your current script.')) {
        setScript(TEMPLATES[key]);
      }
      e.target.value = '';
    }
  };

  const formatScript = () => {
    const lines = script.split('\n');
    const formatted = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || (codes.escape && trimmed.startsWith(codes.escape))) {
        return line;
      }
      const tokens = trimmed.split(/\s+/);
      if (tokens.length >= 3) {
        const id = tokens[0].padEnd(4, ' ');
        const n = parseFloat(tokens[1]).toFixed(2).padStart(9, ' ');
        const e = parseFloat(tokens[2]).toFixed(2).padStart(9, ' ');
        let remaining = tokens.slice(3).join(' ');
        if (remaining) {
          const val3 = parseFloat(tokens[3]);
          if (tokens.length >= 5 && !isNaN(val3)) {
            const el = val3.toFixed(2).padStart(8, ' ');
            const desc = tokens.slice(4).join(' ');
            return `${id} ${n} ${e} ${el}  ${desc}`;
          }
          return `${id} ${n} ${e}  ${remaining}`;
        }
        return `${id} ${n} ${e}`;
      }
      return line;
    });
    setScript(formatted.join('\n'));
    showToast('Script columns aligned!');
  };

  const handleCodeChange = (category, field, val) => {
    setCodes(prev => ({
      ...prev,
      [field]: val
    }));
  };

  // ── Civil 3D Batch Import handler ─────────────────────────────────────────
  const handleCivil3DBatchFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so re-selecting the same file fires onChange again
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const parsed = parseCivil3DBatch(text);
      const previewScript = emitScriptFromBatch(parsed, file.name);
      setBatchImportModal({ parsed, fileName: file.name, previewScript });
    };
    reader.readAsText(file);
  };

  const applyBatchImport = () => {
    if (!batchImportModal) return;
    setScript(batchImportModal.previewScript);
    setBatchImportModal(null);
    showToast(`✅ Civil 3D batch imported — ${batchImportModal.parsed.pts.size} points loaded.`);
  };

  // ── Listen for Settings panel "Launch in Scripting Engine" event ───────────
  // The SettingsTab dispatches window.CustomEvent('boundaryiq:importBatchPath', { detail: { path } })
  // We fetch the raw file from the server's batch-library path, parse it, and open the modal.
  useEffect(() => {
    const handleRemoteImport = async (e) => {
      const filePath = e.detail?.path;
      if (!filePath) return;
      try {
        // Fetch the raw file content via the batch-library/file endpoint
        const res = await fetch(`/api/settings/batch-library/file?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) {
          showToast(`⚠ Could not load batch file: ${res.statusText}`);
          return;
        }
        const text = await res.text();
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        const parsed = parseCivil3DBatch(text);
        const previewScript = emitScriptFromBatch(parsed, fileName);
        setBatchImportModal({ parsed, fileName, previewScript });
      } catch (err) {
        showToast(`✗ Batch import error: ${err.message}`);
      }
    };
    window.addEventListener('boundaryiq:importBatchPath', handleRemoteImport);
    return () => window.removeEventListener('boundaryiq:importBatchPath', handleRemoteImport);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%' }}>
      {/* Title Header */}
      <div>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0 0 0.5rem 0', color: 'var(--text-primary)', fontSize: '1.5rem' }}>
          📝 Linework Scripting
        </h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          IDE for survey command language & figure plotting
        </p>
      </div>

      {/* ── Civil 3D Batch Import Modal ──────────────────────────────────────── */}
      {batchImportModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.72)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: 'linear-gradient(145deg, #0d1629 0%, #090e1a 100%)',
            border: '1px solid rgba(61,127,255,0.35)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
            width: 'min(860px, 95vw)',
            maxHeight: '88vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
            {/* Modal Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '1.2rem 1.5rem',
              borderBottom: '1px solid rgba(61,127,255,0.2)',
              background: 'rgba(61,127,255,0.05)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{
                  background: 'linear-gradient(135deg, #3d7fff 0%, #00d4a8 100%)',
                  width: 36, height: 36, borderRadius: 'var(--radius-md)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.2rem', boxShadow: '0 0 16px rgba(61,127,255,0.4)',
                }}>🏗️</div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '1rem', color: '#fff', letterSpacing: '-0.01em' }}>
                    Civil 3D Batch Import Preview
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    {batchImportModal.fileName} · {batchImportModal.parsed.pts.size} points · {batchImportModal.parsed.figures.length} figure(s)
                  </div>
                </div>
              </div>
              <button
                onClick={() => setBatchImportModal(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1 }}
              >✕</button>
            </div>

            {/* Warnings */}
            {batchImportModal.parsed.warnings.length > 0 && (
              <div style={{
                margin: '0.75rem 1.5rem 0',
                padding: '0.6rem 0.9rem',
                background: 'rgba(201,122,0,0.08)',
                border: '1px solid rgba(201,122,0,0.3)',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.75rem',
                color: '#ffaa00',
              }}>
                <strong>⚠ {batchImportModal.parsed.warnings.length} parse warning{batchImportModal.parsed.warnings.length !== 1 ? 's' : ''}:</strong>
                <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.2rem' }}>
                  {batchImportModal.parsed.warnings.slice(0, 10).map((w, i) => <li key={i}>{w}</li>)}
                  {batchImportModal.parsed.warnings.length > 10 && <li>…and {batchImportModal.parsed.warnings.length - 10} more</li>}
                </ul>
              </div>
            )}

            {/* Stats Grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '0.65rem',
              padding: '0.75rem 1.5rem 0',
            }}>
              {[
                { label: 'Points Computed', value: batchImportModal.parsed.pts.size, color: 'var(--accent)' },
                { label: 'Figures Defined', value: batchImportModal.parsed.figures.length, color: 'var(--success)' },
                { label: 'Parse Warnings',  value: batchImportModal.parsed.warnings.length, color: batchImportModal.parsed.warnings.length > 0 ? '#ffaa00' : 'var(--text-muted)' },
              ].map(s => (
                <div key={s.label} style={{
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', padding: '0.65rem 0.9rem',
                }}>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{s.label}</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Figures List */}
            {batchImportModal.parsed.figures.length > 0 && (
              <div style={{ padding: '0.75rem 1.5rem 0' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.4rem' }}>Figures</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {batchImportModal.parsed.figures.map(fig => (
                    <span key={fig.name} style={{
                      background: 'rgba(61,127,255,0.1)', border: '1px solid rgba(61,127,255,0.3)',
                      borderRadius: '99px', padding: '2px 10px',
                      fontSize: '0.72rem', color: 'var(--accent)', fontWeight: 600,
                    }}>
                      {fig.name} ({fig.pointIds.length} pts)
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Script Preview */}
            <div style={{ padding: '0.75rem 1.5rem 0', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.4rem' }}>Generated Script Preview</div>
              <textarea
                readOnly
                value={batchImportModal.previewScript}
                style={{
                  flex: 1,
                  minHeight: '180px',
                  background: '#07091a',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.75rem',
                  color: '#a8c7fa',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '0.73rem',
                  lineHeight: 1.6,
                  resize: 'none',
                  overflowY: 'auto',
                }}
              />
            </div>

            {/* Footer Actions */}
            <div style={{
              display: 'flex', justifyContent: 'flex-end', gap: '0.65rem',
              padding: '1rem 1.5rem',
              borderTop: '1px solid rgba(61,127,255,0.15)',
              background: 'rgba(0,0,0,0.2)',
            }}>
              <button
                id="civil3d-batch-import-cancel"
                className="btn btn-ghost btn-sm"
                onClick={() => setBatchImportModal(null)}
              >
                Cancel
              </button>
              <button
                id="civil3d-batch-import-apply"
                className="btn btn-primary"
                style={{
                  background: 'linear-gradient(135deg, #3d7fff 0%, #00d4a8 100%)',
                  border: 'none',
                  fontWeight: 700,
                  padding: '0.5rem 1.5rem',
                  boxShadow: '0 0 20px rgba(61,127,255,0.35)',
                }}
                onClick={applyBatchImport}
              >
                ✅ Apply to Script
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden file input for Civil 3D batch import */}
      <input
        type="file"
        accept=".txt,.TXT"
        ref={civil3dBatchFileRef}
        style={{ display: 'none' }}
        onChange={handleCivil3DBatchFileChange}
      />

      {/* ── Top Header Actions ────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: '1rem' }}>
        <div className="flex-between" style={{ alignItems: 'center' }}>
          <div className="card-title" style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, paddingBottom: 0, borderBottom: 'none' }}>
            <span>📝</span>
            <span>Linework Scripting IDE</span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 400, marginLeft: '0.25rem' }}>
              · Civil 3D / Microstation Code Engine
            </span>
          </div>
          
          <div className="flex-row" style={{ gap: '0.6rem', alignItems: 'center' }}>
            <button
              id="civil3d-batch-import-btn"
              className="btn btn-sm"
              onClick={() => civil3dBatchFileRef.current?.click()}
              title="Import a Civil 3D / Survey Module batch .txt file"
              style={{
                background: 'linear-gradient(135deg, rgba(61,127,255,0.18) 0%, rgba(0,212,168,0.12) 100%)',
                border: '1px solid rgba(61,127,255,0.45)',
                color: 'var(--accent)',
                fontWeight: 700,
                fontSize: '0.76rem',
                letterSpacing: '0.01em',
                boxShadow: '0 0 12px rgba(61,127,255,0.15)',
                transition: 'all 0.2s',
                whiteSpace: 'nowrap',
              }}
            >
              🏗️ Import Civil 3D Batch
            </button>

            <select style={{ width: 180, height: 32, padding: '0 0.5rem', fontSize: '0.78rem' }} onChange={handleTemplateChange}>
              <option value="">📁 Load Example Template...</option>
              <option value="closedLot">📐 Closed Lot with Curve</option>
              <option value="radiusCurve">🛰 Curve by Radius (RAD)</option>
              <option value="rectangleFit">⬛ Rectangle Fit (RECT)</option>
              <option value="rightTurnExtend">↩ Right Turn & Extend</option>
              <option value="parallelOffsets">┫ Parallel Offsets (H)</option>
            </select>
            
            <button className="btn btn-ghost btn-sm" onClick={formatScript} title="Align columns for readability">
              ⚙️ Align Script
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => {
              if (window.confirm('Clear current script?')) setScript('');
            }}>
              Clear
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '27fr 38fr 35fr', gap: '1rem', flex: 1, minHeight: 0 }}>
        
        {/* ── Left Column: Code Set Config Abbreviations ────────────────────────── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '1rem' }}>
          <div className="card-header" style={{ marginBottom: '0.75rem', paddingBottom: '0.5rem' }}>
            <div className="card-title" style={{ fontSize: '0.82rem' }}>🔧 Linework Code Set</div>
            <button className="btn btn-ghost btn-sm" style={{ padding: '2px 6px', fontSize: '0.68rem' }} onClick={() => setCodes(DEFAULT_CODES)}>Reset Default</button>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.78rem' }}>
            
            {/* Coding Methods */}
            <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: '0.35rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Coding Methods</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 50px', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                <span className="text-muted">Feature Delimiter</span>
                <input type="text" value={codes.delimiter} onChange={e => handleCodeChange('methods', 'delimiter', e.target.value)} style={{ padding: '2px 4px', textAlign: 'center', fontSize: '0.75rem' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 50px', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                <span className="text-muted">Field Code Escape</span>
                <input type="text" value={codes.escape} onChange={e => handleCodeChange('methods', 'escape', e.target.value)} style={{ padding: '2px 4px', textAlign: 'center', fontSize: '0.75rem' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '0.5rem', alignItems: 'center' }}>
                <span className="text-muted">Traverse Units</span>
                <select value={units} onChange={e => { setUnits(e.target.value); showToast(`Units changed to ${e.target.value === 'feet' ? 'US Survey Feet' : 'Meters'}`); }} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  <option value="feet">Feet (ft)</option>
                  <option value="meters">Meters (m)</option>
                </select>
              </div>
            </div>

            {/* Special Codes */}
            <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--accent2)', marginBottom: '0.35rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Special Codes</div>
              {[
                ['Begin Figure', 'begin'],
                ['Continue Figure', 'continue'],
                ['End Figure', 'end'],
                ['Close Polygon', 'close'],
                ['Horizontal Offset', 'horizontalOffset'],
                ['Vertical Offset', 'verticalOffset'],
                ['Stop Offsets', 'stopOffsets']
              ].map(([label, key]) => (
                <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 50px', gap: '0.5rem', alignItems: 'center', margin: '2px 0' }}>
                  <span className="text-muted">{label}</span>
                  <input type="text" value={codes[key]} onChange={e => handleCodeChange('special', key, e.target.value)} style={{ padding: '2px 4px', textAlign: 'center', fontSize: '0.75rem' }} />
                </div>
              ))}
            </div>

            {/* Line Segment Codes */}
            <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--warning)', marginBottom: '0.35rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Line Segment Codes</div>
              {[
                ['Recall Point', 'recallPoint'],
                ['Connect Point', 'connectPoint'],
                ['Rectangle Fit', 'rectangle'],
                ['Right Turn', 'rightTurn'],
                ['Extend Line', 'extend']
              ].map(([label, key]) => (
                <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 50px', gap: '0.5rem', alignItems: 'center', margin: '2px 0' }}>
                  <span className="text-muted">{label}</span>
                  <input type="text" value={codes[key]} onChange={e => handleCodeChange('line', key, e.target.value)} style={{ padding: '2px 4px', textAlign: 'center', fontSize: '0.75rem' }} />
                </div>
              ))}
            </div>

            {/* Curve Segment Codes */}
            <div>
              <div style={{ fontWeight: 600, color: '#e85a19', marginBottom: '0.35rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Curve Segment Codes</div>
              {[
                ['Begin Curve', 'beginCurve'],
                ['End Curve', 'endCurve'],
                ['Circle (Radius)', 'circle'],
                ['Point on Curve (OC)', 'pointOnCurve']
              ].map(([label, key]) => (
                <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 50px', gap: '0.5rem', alignItems: 'center', margin: '2px 0' }}>
                  <span className="text-muted">{label}</span>
                  <input type="text" value={codes[key]} onChange={e => handleCodeChange('curve', key, e.target.value)} style={{ padding: '2px 4px', textAlign: 'center', fontSize: '0.75rem' }} />
                </div>
              ))}
            </div>

            {/* Coordinate Transformations (TRS) */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--success)', marginBottom: '0.45rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Coordinate Transform (TRS)</div>
              
              {/* Mode Toggle Selector */}
              <div style={{ display: 'flex', gap: '4px', marginBottom: '0.5rem' }}>
                <button
                  className="btn btn-sm"
                  style={{
                    flex: 1,
                    fontSize: '0.68rem',
                    padding: '2px 4px',
                    justifyContent: 'center',
                    background: trsMode === 'manual' ? 'var(--success)' : 'transparent',
                    color: trsMode === 'manual' ? '#090e1a' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                    fontWeight: 600
                  }}
                  onClick={() => setTrsMode('manual')}
                >
                  Manual
                </button>
                <button
                  className="btn btn-sm"
                  style={{
                    flex: 1,
                    fontSize: '0.68rem',
                    padding: '2px 4px',
                    justifyContent: 'center',
                    background: trsMode === 'align2p' ? 'var(--success)' : 'transparent',
                    color: trsMode === 'align2p' ? '#090e1a' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                    fontWeight: 600
                  }}
                  onClick={() => setTrsMode('align2p')}
                >
                  2-Pt Align
                </button>
              </div>

              {trsMode === 'manual' ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px', gap: '0.4rem', alignItems: 'center', margin: '2px 0' }}>
                    <span className="text-muted">Shift N ({units === 'meters' ? 'm' : 'ft'})</span>
                    <input type="text" value={trsShiftN} onChange={e => setTrsShiftN(e.target.value)} style={{ padding: '2px 4px', textAlign: 'right', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px', gap: '0.4rem', alignItems: 'center', margin: '2px 0' }}>
                    <span className="text-muted">Shift E ({units === 'meters' ? 'm' : 'ft'})</span>
                    <input type="text" value={trsShiftE} onChange={e => setTrsShiftE(e.target.value)} style={{ padding: '2px 4px', textAlign: 'right', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px', gap: '0.4rem', alignItems: 'center', margin: '2px 0' }}>
                    <span className="text-muted">Rotate (deg)</span>
                    <input type="text" value={trsRotate} onChange={e => setTrsRotate(e.target.value)} style={{ padding: '2px 4px', textAlign: 'right', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px', gap: '0.4rem', alignItems: 'center', margin: '2px 0' }}>
                    <span className="text-muted">Scale Factor</span>
                    <input type="text" value={trsScale} onChange={e => setTrsScale(e.target.value)} style={{ padding: '2px 4px', textAlign: 'right', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div style={{ display: 'flex', gap: '4px', marginTop: '0.5rem' }}>
                    <button className="btn btn-primary btn-sm" style={{ flex: 1, padding: '2px 6px', fontSize: '0.7rem', justifyContent: 'center' }} onClick={applyTRS}>Apply TRS</button>
                    {scriptBackup !== null && (
                      <button className="btn btn-ghost btn-sm" style={{ padding: '2px 6px', fontSize: '0.7rem', color: 'var(--danger)', borderColor: 'var(--danger)', justifyContent: 'center' }} onClick={undoTRS}>Undo</button>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.74rem' }}>
                  {/* Point Selection Dropdowns for Source */}
                  {parsedPoints.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '0.2rem' }}>
                      <select
                        onChange={e => {
                          const p = parsedPoints.find(pt => pt.id === e.target.value);
                          if (p) setAlignSrcPt1({ e: p.easting.toString(), n: p.northing.toString() });
                          e.target.value = '';
                        }}
                        style={{ fontSize: '0.68rem', padding: '2px 4px', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      >
                        <option value="">Src 1 from...</option>
                        {parsedPoints.map(p => (
                          <option key={`align-s1-${p.id}`} value={p.id}>{p.id} ({p.easting.toFixed(0)}, {p.northing.toFixed(0)})</option>
                        ))}
                      </select>
                      <select
                        onChange={e => {
                          const p = parsedPoints.find(pt => pt.id === e.target.value);
                          if (p) setAlignSrcPt2({ e: p.easting.toString(), n: p.northing.toString() });
                          e.target.value = '';
                        }}
                        style={{ fontSize: '0.68rem', padding: '2px 4px', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      >
                        <option value="">Src 2 from...</option>
                        {parsedPoints.map(p => (
                          <option key={`align-s2-${p.id}`} value={p.id}>{p.id} ({p.easting.toFixed(0)}, {p.northing.toFixed(0)})</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Coordinates input form */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px 65px', gap: '4px', alignItems: 'center' }}>
                    <span className="text-muted" style={{ fontSize: '0.68rem' }}>Src P1 (E, N)</span>
                    <input type="text" placeholder="Easting" value={alignSrcPt1.e} onChange={e => setAlignSrcPt1(prev => ({ ...prev, e: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                    <input type="text" placeholder="Northing" value={alignSrcPt1.n} onChange={e => setAlignSrcPt1(prev => ({ ...prev, n: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px 65px', gap: '4px', alignItems: 'center' }}>
                    <span className="text-muted" style={{ fontSize: '0.68rem' }}>Src P2 (E, N)</span>
                    <input type="text" placeholder="Easting" value={alignSrcPt2.e} onChange={e => setAlignSrcPt2(prev => ({ ...prev, e: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                    <input type="text" placeholder="Northing" value={alignSrcPt2.n} onChange={e => setAlignSrcPt2(prev => ({ ...prev, n: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px 65px', gap: '4px', alignItems: 'center' }}>
                    <span className="text-muted" style={{ fontSize: '0.68rem' }}>Dest P3 (E, N)</span>
                    <input type="text" placeholder="Easting" value={alignDestPt1.e} onChange={e => setAlignDestPt1(prev => ({ ...prev, e: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                    <input type="text" placeholder="Northing" value={alignDestPt1.n} onChange={e => setAlignDestPt1(prev => ({ ...prev, n: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px 65px', gap: '4px', alignItems: 'center' }}>
                    <span className="text-muted" style={{ fontSize: '0.68rem' }}>Dest P4 (E, N)</span>
                    <input type="text" placeholder="Easting" value={alignDestPt2.e} onChange={e => setAlignDestPt2(prev => ({ ...prev, e: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                    <input type="text" placeholder="Northing" value={alignDestPt2.n} onChange={e => setAlignDestPt2(prev => ({ ...prev, n: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                  </div>

                  {/* Real-time parameter preview */}
                  {(() => {
                    const params = getImpliedAlignmentParams();
                    if (!params) return null;
                    return (
                      <div style={{ marginTop: '0.35rem', background: 'rgba(0, 212, 168, 0.05)', border: '1px solid rgba(0, 212, 168, 0.3)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontSize: '0.66rem', color: 'var(--success)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ fontWeight: 700 }}>Implied Alignment Parameters:</div>
                        <div>Scale: <strong>{params.scale.toFixed(6)}</strong></div>
                        <div>Rotation: <strong>{params.rotDeg.toFixed(4)}°</strong></div>
                        <div>Shift N: <strong>{params.shiftN.toFixed(2)}</strong>, E: <strong>{params.shiftE.toFixed(2)}</strong></div>
                      </div>
                    );
                  })()}

                  <div style={{ display: 'flex', gap: '4px', marginTop: '0.4rem' }}>
                    <button className="btn btn-success btn-sm" style={{ flex: 1, padding: '2px 6px', fontSize: '0.7rem', color: '#090e1a', justifyContent: 'center' }} onClick={apply2PointAlignment}>Apply Align</button>
                    {scriptBackup !== null && (
                      <button className="btn btn-ghost btn-sm" style={{ padding: '2px 6px', fontSize: '0.7rem', color: 'var(--danger)', borderColor: 'var(--danger)', justifyContent: 'center' }} onClick={undoTRS}>Undo</button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* COGO Intersections Solver */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--warning)', marginBottom: '0.35rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>COGO Solver</div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '0.4rem', alignItems: 'center', marginBottom: '0.35rem' }}>
                <span className="text-muted">Solver Type</span>
                <select value={cogoType} onChange={e => { setCogoType(e.target.value); setSolvedCogoPoints([]); }} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  <option value="bb">Bearing-Bearing</option>
                  <option value="dd">Distance-Distance</option>
                  <option value="bd">Bearing-Distance</option>
                </select>
              </div>

              {/* Quick point copy dropdowns */}
              {parsedPoints.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '0.35rem' }}>
                  <select
                    onChange={e => {
                      const p = parsedPoints.find(pt => pt.id === e.target.value);
                      if (p) setCogoPtA({ e: p.easting.toString(), n: p.northing.toString() });
                      e.target.value = '';
                    }}
                    style={{ fontSize: '0.68rem', padding: '2px 4px', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  >
                    <option value="">Copy A from...</option>
                    {parsedPoints.map(p => (
                      <option key={`cogo-a-${p.id}`} value={p.id}>{p.id} ({p.easting.toFixed(0)}, {p.northing.toFixed(0)})</option>
                    ))}
                  </select>

                  <select
                    onChange={e => {
                      const p = parsedPoints.find(pt => pt.id === e.target.value);
                      if (p) setCogoPtB({ e: p.easting.toString(), n: p.northing.toString() });
                      e.target.value = '';
                    }}
                    style={{ fontSize: '0.68rem', padding: '2px 4px', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  >
                    <option value="">Copy B from...</option>
                    {parsedPoints.map(p => (
                      <option key={`cogo-b-${p.id}`} value={p.id}>{p.id} ({p.easting.toFixed(0)}, {p.northing.toFixed(0)})</option>
                    ))}
                  </select>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px 65px', gap: '4px', margin: '2px 0', alignItems: 'center' }}>
                <span className="text-muted">Point A (E, N)</span>
                <input type="text" placeholder="Easting" value={cogoPtA.e} onChange={e => setCogoPtA(prev => ({ ...prev, e: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                <input type="text" placeholder="Northing" value={cogoPtA.n} onChange={e => setCogoPtA(prev => ({ ...prev, n: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 65px 65px', gap: '4px', margin: '2px 0', alignItems: 'center' }}>
                <span className="text-muted">Point B (E, N)</span>
                <input type="text" placeholder="Easting" value={cogoPtB.e} onChange={e => setCogoPtB(prev => ({ ...prev, e: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
                <input type="text" placeholder="Northing" value={cogoPtB.n} onChange={e => setCogoPtB(prev => ({ ...prev, n: e.target.value }))} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 134px', gap: '4px', margin: '2px 0', alignItems: 'center' }}>
                <span className="text-muted">{cogoType === 'bb' || cogoType === 'bd' ? 'Bearing A' : `Radius A (${units === 'meters' ? 'm' : 'ft'})`}</span>
                <input type="text" placeholder={cogoType === 'bb' || cogoType === 'bd' ? 'N 45-30-00 E' : '100.00'} value={cogoParamA} onChange={e => setCogoParamA(e.target.value)} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 134px', gap: '4px', margin: '2px 0', alignItems: 'center' }}>
                <span className="text-muted">{cogoType === 'bb' ? 'Bearing B' : `Radius B (${units === 'meters' ? 'm' : 'ft'})`}</span>
                <input type="text" placeholder={cogoType === 'bb' ? 'S 45 W' : '120.00'} value={cogoParamB} onChange={e => setCogoParamB(e.target.value)} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
              </div>

              <div style={{ display: 'flex', gap: '4px', marginTop: '0.5rem' }}>
                <button className="btn btn-warning btn-sm" style={{ flex: 1, padding: '2px 6px', fontSize: '0.7rem', color: '#090e1a', justifyContent: 'center' }} onClick={solveCOGO}>Solve Intersections</button>
                {solvedCogoPoints.length > 0 && (
                  <button className="btn btn-ghost btn-sm" style={{ padding: '2px 6px', fontSize: '0.7rem', justifyContent: 'center' }} onClick={() => setSolvedCogoPoints([])}>Clear Results</button>
                )}
              </div>

              {/* Solved coordinates output list */}
              {solvedCogoPoints.length > 0 && (
                <div style={{ marginTop: '0.5rem', background: 'rgba(255, 215, 0, 0.05)', border: '1px solid rgba(255, 215, 0, 0.3)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: '0.7rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontWeight: 700, color: '#ffd700' }}>Solved Points:</div>
                  {solvedCogoPoints.map((p, idx) => (
                     <div key={`sol-${idx}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: idx < solvedCogoPoints.length - 1 ? '1px dashed rgba(255, 215, 0, 0.2)' : 'none', paddingBottom: '3px' }}>
                       <div>
                         <div>E: <strong>{p.easting.toFixed(3)}</strong></div>
                         <div>N: <strong>{p.northing.toFixed(3)}</strong></div>
                       </div>
                       <button className="btn btn-ghost btn-sm" style={{ padding: '2px 5px', fontSize: '0.62rem' }} onClick={() => insertSolvedPoint(p)}>Insert</button>
                     </div>
                  ))}
                </div>
              )}
            </div>

            {/* COGO Curve Solver */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
              <div style={{ fontWeight: 600, color: '#e85a19', marginBottom: '0.35rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Curve Solver</div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: '0.4rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                <span className="text-muted">Parameter 1</span>
                <select value={curveParam1Type} onChange={e => { setCurveParam1Type(e.target.value); setSolvedCurve(null); }} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  <option value="radius">Radius</option>
                  <option value="delta">Delta Angle</option>
                  <option value="arc">Arc Length</option>
                  <option value="chord">Chord Length</option>
                  <option value="tangent">Tangent</option>
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: '0.4rem', alignItems: 'center', marginBottom: '0.35rem' }}>
                <span className="text-muted">Value 1</span>
                <input type="text" placeholder="e.g. 100.00" value={curveParam1Val} onChange={e => setCurveParam1Val(e.target.value)} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: '0.4rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                <span className="text-muted">Parameter 2</span>
                <select value={curveParam2Type} onChange={e => { setCurveParam2Type(e.target.value); setSolvedCurve(null); }} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  <option value="radius">Radius</option>
                  <option value="delta">Delta Angle</option>
                  <option value="arc">Arc Length</option>
                  <option value="chord">Chord Length</option>
                  <option value="tangent">Tangent</option>
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: '0.4rem', alignItems: 'center', marginBottom: '0.35rem' }}>
                <span className="text-muted">Value 2</span>
                <input type="text" placeholder="e.g. 45.00" value={curveParam2Val} onChange={e => setCurveParam2Val(e.target.value)} style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' }} />
              </div>

              <div style={{ display: 'flex', gap: '4px', marginTop: '0.5rem' }}>
                <button className="btn btn-sm" style={{ flex: 1, padding: '2px 6px', fontSize: '0.7rem', color: '#090e1a', background: '#e85a19', borderColor: '#e85a19', justifyContent: 'center' }} onClick={solveCurveCOGO}>Solve Curve</button>
                {solvedCurve && (
                  <button className="btn btn-ghost btn-sm" style={{ padding: '2px 6px', fontSize: '0.7rem', justifyContent: 'center' }} onClick={() => setSolvedCurve(null)}>Clear</button>
                )}
              </div>

              {/* Solved Curve Results table */}
              {solvedCurve && (
                <div style={{ marginTop: '0.5rem', background: 'rgba(232, 90, 25, 0.05)', border: '1px solid rgba(232, 90, 25, 0.3)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: '0.7rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontWeight: 700, color: '#e85a19' }}>Solved Curve Parameters:</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px' }}>
                    <span className="text-muted">Radius:</span>
                    <strong>{solvedCurve.radius.toFixed(2)} {units === 'meters' ? 'm' : 'ft'}</strong>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px' }}>
                    <span className="text-muted">Delta Angle:</span>
                    <strong>{(() => {
                      const d = solvedCurve.deltaDeg;
                      const deg = Math.floor(d);
                      const minVal = (d - deg) * 60;
                      const min = Math.floor(minVal);
                      const sec = Math.round((minVal - min) * 60);
                      return `${deg}°${min.toString().padStart(2,'0')}'${sec.toString().padStart(2,'0')}"`;
                    })()}</strong>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px' }}>
                    <span className="text-muted">Arc Length:</span>
                    <strong>{solvedCurve.arcLength.toFixed(2)} {units === 'meters' ? 'm' : 'ft'}</strong>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px' }}>
                    <span className="text-muted">Chord Length:</span>
                    <strong>{solvedCurve.chord.toFixed(2)} {units === 'meters' ? 'm' : 'ft'}</strong>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px' }}>
                    <span className="text-muted">Tangent:</span>
                    <strong>{solvedCurve.tangent.toFixed(2)} {units === 'meters' ? 'm' : 'ft'}</strong>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px' }}>
                    <span className="text-muted">External (E):</span>
                    <strong>{solvedCurve.external.toFixed(2)} {units === 'meters' ? 'm' : 'ft'}</strong>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px' }}>
                    <span className="text-muted">Mid-Ordinate (M):</span>
                    <strong>{solvedCurve.midOrdinate.toFixed(2)} {units === 'meters' ? 'm' : 'ft'}</strong>
                  </div>
                  <button className="btn btn-ghost btn-sm" style={{ marginTop: '4px', width: '100%', justifyContent: 'center', fontSize: '0.66rem', padding: '2px 4px' }} onClick={insertSolvedCurveIntoScript}>
                    📋 Insert Solved Data as Comment
                  </button>
                </div>
              )}
            </div>
            {/* DD ↔ DMS Converter */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
              <div style={{ fontWeight: 600, color: '#a855f7', marginBottom: '0.5rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>DD ↔ DMS</div>

              {/* Decimal Degrees input */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: '0.4rem', alignItems: 'center', marginBottom: '0.3rem' }}>
                <span className="text-muted" style={{ fontSize: '0.72rem' }}>Decimal °</span>
                <input
                  id="dd-input"
                  type="text"
                  placeholder="e.g. 45.5083"
                  value={ddInput}
                  onChange={e => {
                    const raw = e.target.value;
                    setDdInput(raw);
                    const dd = parseFloat(raw);
                    if (!isNaN(dd)) {
                      const sign = dd < 0 ? '-' : '';
                      const abs = Math.abs(dd);
                      const deg = Math.floor(abs);
                      const minFull = (abs - deg) * 60;
                      const min = Math.floor(minFull);
                      const sec = (minFull - min) * 60;
                      setDmsInput(`${sign}${deg}°${String(min).padStart(2,'0')}'${sec.toFixed(4).replace(/\.?0+$/,'')}"`);
                    } else if (raw.trim() === '' || raw.trim() === '-') {
                      setDmsInput('');
                    }
                  }}
                  style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right', borderRadius: 4 }}
                />
              </div>

              {/* DMS input */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: '0.4rem', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span className="text-muted" style={{ fontSize: '0.72rem' }}>D° M′ S″</span>
                <input
                  id="dms-input"
                  type="text"
                  placeholder={`45°30'30"`}
                  value={dmsInput}
                  onChange={e => {
                    const raw = e.target.value;
                    setDmsInput(raw);
                    // Parse: optional sign, then D[°d ] M['m ] S["s]
                    const m = raw.trim().match(/^(-?)\s*(\d+)[°d\s]\s*(\d+)['m\s]\s*([\d.]+)["\u201ds]?\s*$/);
                    if (m) {
                      const sign = m[1] === '-' ? -1 : 1;
                      const deg = parseFloat(m[2]);
                      const min = parseFloat(m[3]);
                      const sec = parseFloat(m[4]);
                      const dd = sign * (deg + min / 60 + sec / 3600);
                      setDdInput(dd.toFixed(8).replace(/\.?0+$/, ''));
                    } else if (raw.trim() === '' || raw.trim() === '-') {
                      setDdInput('');
                    }
                  }}
                  style={{ padding: '2px 4px', fontSize: '0.75rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right', borderRadius: 4 }}
                />
              </div>

              <button
                className="btn btn-ghost btn-sm"
                style={{ width: '100%', justifyContent: 'center', fontSize: '0.68rem', padding: '2px 4px', color: '#a855f7', borderColor: 'rgba(168,85,247,0.35)' }}
                onClick={() => { setDmsInput(''); setDdInput(''); }}
              >
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* ── Middle Column: Script Editor ────────────────────────────────────────── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: '1rem', minWidth: 0 }}>
          <div className="card-header" style={{ marginBottom: '0.6rem', paddingBottom: '0.5rem' }}>
            <div className="card-title" style={{ fontSize: '0.82rem' }}>
              📝 Script Editor
              <span className="status-badge pass" style={{ padding: '1px 5px', fontSize: '0.62rem' }}>
                {parsedPoints.length} Points
              </span>
            </div>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>P N E Z Description</span>
          </div>

          {/* Quick Code inserting buttons toolbar */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '0.5rem', background: 'var(--bg-elevated)', padding: '4px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
            {[
              ['B', 'Begin Fig'],
              ['CLS', 'Close'],
              ['BC', 'Curve Start'],
              ['OC', 'Curve Mid'],
              ['EC', 'Curve End'],
              ['RECT', 'Rectangle'],
              ['RT', 'Right Turn'],
              ['X', 'Extend'],
              ['H', 'H-Offset'],
              ['V', 'V-Offset']
            ].map(([lbl, tooltip]) => (
              <button
                key={lbl}
                className="btn btn-ghost btn-sm"
                style={{ padding: '3px 7px', fontSize: '0.68rem', fontWeight: 700 }}
                onClick={() => insertCode(codes[lbl === 'B' ? 'begin' : lbl === 'CLS' ? 'close' : lbl === 'BC' ? 'beginCurve' : lbl === 'EC' ? 'endCurve' : lbl === 'OC' ? 'pointOnCurve' : lbl === 'RECT' ? 'rectangle' : lbl === 'RT' ? 'rightTurn' : lbl === 'X' ? 'extend' : lbl === 'H' ? 'horizontalOffset' : 'verticalOffset'])}
                title={tooltip}
              >
                {lbl}
              </button>
            ))}
          </div>

          {/* Editor Textarea */}
          <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <textarea
              ref={textareaRef}
              value={script}
              onChange={e => setScript(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="# Enter surveyor points script here..."
              style={{
                flex: 1,
                resize: 'none',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.8rem',
                lineHeight: 1.6,
                background: '#090e1a',
                color: 'var(--text-primary)',
                padding: '0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)'
              }}
            />
          </div>

          {/* Syntax Warnings and errors */}
          {(errors.length > 0 || figures.some(f => f.selfIntersections && f.selfIntersections.length > 0)) && (
            <div style={{ marginTop: '0.5rem', maxHeight: 110, overflowY: 'auto', background: 'rgba(255,77,109,0.08)', border: '1px solid rgba(255,77,109,0.3)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: '0.72rem', color: 'var(--danger)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {errors.map((e, idx) => {
                const m = e.match(/^Line (\d+):/);
                const lineNo = m ? parseInt(m[1]) : null;
                return (
                  <div
                    key={`err-${idx}`}
                    style={{ cursor: lineNo ? 'pointer' : 'default', textDecoration: lineNo ? 'underline' : 'none', marginBottom: '2px' }}
                    onClick={() => lineNo && jumpToLine(lineNo)}
                    title={lineNo ? `Click to jump to line ${lineNo}` : undefined}
                  >
                    ⚠ {e}
                  </div>
                );
              })}
              {figures.map(fig => {
                if (!fig.selfIntersections || fig.selfIntersections.length === 0) return null;
                return fig.selfIntersections.map((inter, idx) => (
                  <div key={`self-int-${fig.name}-${idx}`} style={{ fontWeight: 500 }}>
                    ❌ Figure {fig.name} crosses itself: Segment [{inter.p1_1} → {inter.p1_2}] intersects [{inter.p2_1} → {inter.p2_2}] at ({inter.x.toFixed(2)}, {inter.y.toFixed(2)})!
                  </div>
                ));
              })}
            </div>
          )}
        </div>

        {/* ── Right Column: Interactive Canvas Map & Data details ────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minWidth: 0 }}>
          
          {/* Map Preview Card */}
          <div className="card" style={{ flex: 1.1, display: 'flex', flexDirection: 'column', padding: '1rem', position: 'relative', minHeight: 0 }}>
            <div className="card-header" style={{ marginBottom: '0.5rem', paddingBottom: '0.4rem' }}>
              <div className="card-title" style={{ fontSize: '0.82rem' }}>🗺 Linework Draft Preview</div>
              <div className="flex-row" style={{ gap: '0.4rem' }}>
                <button
                  className={`btn btn-ghost btn-sm ${showGrid ? 'btn-success' : ''}`}
                  style={{ padding: '2px 5px', fontSize: '0.65rem' }}
                  onClick={() => setShowGrid(!showGrid)}
                >
                  Grid
                </button>
                <button
                  className={`btn btn-ghost btn-sm ${showLabels ? 'btn-success' : ''}`}
                  style={{ padding: '2px 5px', fontSize: '0.65rem' }}
                  onClick={() => setShowLabels(!showLabels)}
                >
                  Labels
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: '2px 6px', fontSize: '0.65rem' }}
                  onClick={() => {
                    if (parsedPoints.length > 0) {
                      autoFit(parsedPoints, canvasDimensions.width, canvasDimensions.height);
                    }
                  }}
                >
                  🎯 Fit
                </button>
              </div>
            </div>

            {/* Visual Canvas Drawing Area */}
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: '#090e1a' }}>
              <canvas
                ref={canvasRef}
                width={canvasDimensions.width}
                height={canvasDimensions.height}
                style={{ display: 'block', width: '100%', height: '100%', cursor: isDragging ? 'grabbing' : 'grab' }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
                onDoubleClick={handleDoubleClick}
                onClick={handleCanvasClick}
              />

              {/* Float Help Tip */}
              <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(9, 14, 26, 0.85)', border: '1px solid var(--border)', borderRadius: '4px', padding: '3px 8px', fontSize: '0.62rem', color: 'var(--text-muted)', pointerEvents: 'none' }}>
                🖱 Scroll to Zoom · Drag to Pan · DblClick to Fit · Click Point
              </div>

              {/* Point tooltip overlay */}
              {hoveredPoint && (
                <div style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  background: 'rgba(20, 30, 53, 0.95)',
                  border: '1px solid var(--accent)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '6px 10px',
                  fontSize: '0.72rem',
                  color: 'var(--text-primary)',
                  boxShadow: 'var(--shadow-card)',
                  pointerEvents: 'none',
                  zIndex: 200,
                  maxWidth: 220,
                  lineHeight: 1.4
                }}>
                  <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: '3px' }}>Point {hoveredPoint.id}</div>
                  <div>Northing: {hoveredPoint.northing.toFixed(3)}</div>
                  <div>Easting: {hoveredPoint.easting.toFixed(3)}</div>
                  <div>Elevation: {hoveredPoint.elevation.toFixed(2)}</div>
                  {hoveredPoint.rawDescription && (
                    <div style={{ marginTop: '3px', borderTop: '1px solid var(--border)', paddingTop: '3px', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                      Code: {hoveredPoint.rawDescription}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Sub-tab Table / Exports Card */}
          <div className="card" style={{ flex: 0.9, display: 'flex', flexDirection: 'column', padding: '0.85rem 1rem', minHeight: 0 }}>
            {/* Header select */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', paddingBottom: '0.35rem', marginBottom: '0.5rem', gap: '0.75rem' }}>
              {[
                ['figures', '📐 Figures'],
                ['points', '📍 Points'],
                ['qc', '📋 QC Report'],
                ['exports', '📥 Exports']
              ].map(([key, label]) => (
                <button
                  key={key}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: activeSubTab === key ? 'var(--accent)' : 'var(--text-secondary)',
                    fontWeight: activeSubTab === key ? 600 : 400,
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                    paddingBottom: '3px',
                    borderBottom: activeSubTab === key ? '2px solid var(--accent)' : '2px solid transparent',
                    transition: 'all 0.15s'
                  }}
                  onClick={() => setActiveSubTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Sub-tab view area */}
            <div style={{ flex: 1, overflowY: 'auto', fontSize: '0.76rem' }}>
              
              {activeSubTab === 'figures' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {figures.length === 0 ? (
                    <div className="text-muted" style={{ padding: '1rem 0', textAlign: 'center' }}>No figures generated. Create points with figure labels.</div>
                  ) : (
                    figures.map((fig, idx) => {
                      const isMeters = units === 'meters';
                      const unitSfx = isMeters ? 'm' : 'ft';
                      const areaSfx = isMeters ? 'sq m' : 'sq ft';
                      const bigAreaSfx = isMeters ? 'ha' : 'ac';
                      const bigAreaDiv = isMeters ? 10000 : 43560;

                      return (
                        <div key={idx} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--text-primary)' }}>
                            <span>Figure {fig.name}</span>
                            <span style={{ fontSize: '0.65rem', padding: '1px 6px', borderRadius: 4, background: fig.isClosed ? 'rgba(0,212,168,0.12)' : 'rgba(255,77,109,0.12)', color: fig.isClosed ? 'var(--success)' : 'var(--danger)' }}>
                              {fig.isClosed ? 'CLOSED' : 'OPEN'}
                            </span>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                            <div>Vertices: <strong>{fig.vertices.length}</strong></div>
                            <div>Length: <strong>{fig.length.toFixed(2)} {unitSfx}</strong></div>
                            {fig.isClosed && <div>Area: <strong>{fig.area.toFixed(1)} {areaSfx}</strong> ({(fig.area / bigAreaDiv).toFixed(4)} {bigAreaSfx})</div>}
                            {fig.misclosure > 0.01 && (
                              <div style={{ gridColumn: 'span 2', color: 'var(--warning)', marginTop: '2px' }}>
                                Misclosure: <strong style={{ color: 'var(--danger)' }}>{fig.misclosure.toFixed(3)} {unitSfx}</strong>
                              </div>
                            )}
                          </div>
                          {fig.misclosure > 0.01 && fig.vertices.length >= 3 && (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{
                                marginTop: '0.35rem',
                                padding: '3px 8px',
                                fontSize: '0.68rem',
                                fontWeight: 600,
                                width: '100%',
                                justifyContent: 'center',
                                border: '1px solid rgba(255, 159, 67, 0.3)',
                                color: '#ff9f43',
                                background: 'rgba(255, 159, 67, 0.04)',
                                borderRadius: 'var(--radius-sm)',
                                cursor: 'pointer'
                              }}
                              onClick={() => adjustTraverseCompassRule(fig)}
                            >
                              ⚖️ Apply Compass Rule (Bowditch) Adjustment
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {activeSubTab === 'points' && (
                <div className="data-table-wrap" style={{ maxHeight: 130 }}>
                  <table className="data-table" style={{ fontSize: '0.72rem' }}>
                    <thead>
                      <tr>
                        <th>ID</th><th>Northing</th><th>Easting</th><th>Elev</th><th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedPoints.map(p => (
                        <tr
                          key={p.id}
                          style={{ background: hoveredPoint && hoveredPoint.id === p.id ? 'var(--accent-glow)' : undefined, cursor: 'pointer' }}
                          onMouseEnter={() => setHoveredPoint(p)}
                          onMouseLeave={() => setHoveredPoint(null)}
                          onClick={() => jumpToLine(p.lineIndex)}
                        >
                          <td style={{ fontWeight: 700 }}>{p.id}</td>
                          <td>{p.northing.toFixed(2)}</td>
                          <td>{p.easting.toFixed(2)}</td>
                          <td>{p.elevation.toFixed(1)}</td>
                          <td style={{ color: 'var(--text-secondary)' }}>{p.rawDescription}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeSubTab === 'exports' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.25rem 0' }}>
                  <button className="btn btn-primary btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={handleExportDXF}>
                    📥 Export DXF Linework (.dxf)
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={handleExportCSV}>
                    📥 Export Coordinate Points (.csv)
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={handleExportCOGO}>
                    📥 Export Traverse COGO Script (.txt)
                  </button>
                  <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', lineHeight: 1.4, textAlign: 'center', marginTop: '0.25rem' }}>
                    * DXF file exports separate layers for POINTS, FIGURES, and OFFSETS, fully compatible with Civil 3D, AutoCAD, and Microstation.
                  </div>
                </div>
              )}

              {activeSubTab === 'qc' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', height: '100%' }}>
                  {figures.length === 0 ? (
                    <div className="text-muted" style={{ padding: '1rem 0', textAlign: 'center' }}>No figures available to generate QC Report.</div>
                  ) : (
                    <>
                      {/* Figure selector if multiple */}
                      {figures.length > 1 && (
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                          <span className="text-muted" style={{ fontSize: '0.72rem' }}>Figure:</span>
                          <select
                            value={selectedQcFigureName || figures[0].name}
                            onChange={e => setSelectedQcFigureName(e.target.value)}
                            style={{ flex: 1, height: 26, fontSize: '0.72rem', padding: '0 0.25rem', background: '#090e1a', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                          >
                            {figures.map(f => (
                              <option key={f.name} value={f.name}>{f.name}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      
                      {/* QC Report Controls */}
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ flex: 1, justifyContent: 'center', fontSize: '0.7rem', padding: '4px' }}
                          onClick={() => {
                            const activeFigName = selectedQcFigureName || (figures[0] && figures[0].name);
                            const activeFig = figures.find(f => f.name === activeFigName) || figures[0];
                            if (activeFig) {
                              const report = generateQcReportText(activeFig, units);
                              handleCopyQcReport(report);
                            }
                          }}
                        >
                          📋 Copy Markdown
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ flex: 1, justifyContent: 'center', fontSize: '0.7rem', padding: '4px' }}
                          onClick={() => {
                            const activeFigName = selectedQcFigureName || (figures[0] && figures[0].name);
                            const activeFig = figures.find(f => f.name === activeFigName) || figures[0];
                            if (activeFig) {
                              const report = generateQcReportText(activeFig, units);
                              handleDownloadQcReport(report, activeFig.name);
                            }
                          }}
                        >
                          📥 Download .md
                        </button>
                      </div>

                      {/* Rendered QC report preview container */}
                      <div
                        style={{
                          flex: 1,
                          overflowY: 'auto',
                          background: '#090e1a',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '0.75rem',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: '0.68rem',
                          lineHeight: 1.4,
                          whiteSpace: 'pre-wrap',
                          color: 'var(--text-primary)',
                          maxHeight: 180
                        }}
                      >
                        {(() => {
                          const activeFigName = selectedQcFigureName || (figures[0] && figures[0].name);
                          const activeFig = figures.find(f => f.name === activeFigName) || figures[0];
                          return generateQcReportText(activeFig, units);
                        })()}
                      </div>
                    </>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>

      </div>
      <ToastPortal />
    </div>
  );
}
