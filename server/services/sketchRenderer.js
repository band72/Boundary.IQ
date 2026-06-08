// ─── Server-Side Boundary Sketch Renderer ────────────────────────────────────
// Produces 5 PNG pages that mirror the PrintBlueprint.jsx multi-page PDF layout.
//
//  Page 1 — Main boundary sketch + Mapcheck/Closure footer + Title block
//  Page 2 — Corrected metes & bounds legal description
//  Page 3 — Line table + Curve table
//  Page 4 — Original deed legal description (pre-correction)
//  Page 5 — Original uncorrected boundary sketch (dashed, UNCORRECTED watermark)
//
// Each page is letter-landscape (1056 × 816 px logical, 2× DPR = 2112 × 1632).

import { createCanvas } from 'canvas';

// ── Page dimensions ───────────────────────────────────────────────────────────
const W   = 1056;   // logical width  (11″ × 96 dpi)
const H   =  816;   // logical height (8.5″ × 96 dpi)
const DPR =  2;     // hi-res output

// ── Layout constants (all in logical px) ─────────────────────────────────────
const MARGIN      = 14;   // outer border inset
const PAD         = 36;   // inner map padding
const FOOTER_H    = 170;  // height of bottom footer strip (mapcheck / notes)
const TB_W        = 310;  // title-block column width (right side of footer)
const HDR_H       = 22;   // section-title header bar height

// ── Colours ───────────────────────────────────────────────────────────────────
const C_BLACK  = '#000000';
const C_BORDER = '#cccccc';
const C_HEADER = '#1a2e44';   // dark navy panel header background
const C_HDR_TXT= '#ffffff';
const C_GRID   = 'rgba(0,0,0,0.055)';
const C_RAW    = '#e63946';   // unadjusted traverse (red dashed)
const C_FILL   = 'rgba(0,0,0,0.04)';
const C_UNCORR = 'rgba(200,0,0,0.075)';
const C_LABEL  = '#444444';
const C_PASS   = '#007700';
const C_FAIL   = '#cc0000';

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Create a fresh hi-res canvas and return { canvas, ctx }. */
function newCanvas() {
  const canvas = createCanvas(W * DPR, H * DPR);
  const ctx    = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  // Redefine ctx.font setter to automatically map generic 'sans-serif'
  // to '"DejaVu Sans", "Liberation Sans", sans-serif' for accurate font metrics
  const proto = Object.getPrototypeOf(ctx);
  const desc = Object.getOwnPropertyDescriptor(proto, 'font');
  if (desc && desc.set) {
    Object.defineProperty(ctx, 'font', {
      set(val) {
        let mapped = val;
        if (typeof val === 'string' && val.includes('sans-serif') && !val.includes('DejaVu')) {
          mapped = val.replace('sans-serif', '"DejaVu Sans", "Liberation Sans", sans-serif');
        }
        desc.set.call(ctx, mapped);
      },
      get() {
        return desc.get.call(ctx);
      },
      configurable: true,
      enumerable: true
    });
  }

  return { canvas, ctx };
}

/** Fill aged cream background + double border + 20px grid. */
function drawPageFrame(ctx, isBlueprint = false) {
  ctx.fillStyle = isBlueprint ? '#0c1a2d' : '#f8f5ed';
  ctx.fillRect(0, 0, W, H);

  // Draw 20px warm brown or cyan grid lines
  ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.08)' : 'rgba(120, 90, 60, 0.08)';
  ctx.lineWidth = 0.5;
  for (let x = 20; x < W; x += 20) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 20; y < H; y += 20) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  ctx.lineWidth = 0.5;
  ctx.strokeRect(8, 8, W - 16, H - 16);
}

/** Panel header bar. */
function drawPanelHeader(ctx, x, y, w, h, text, isBlueprint = false) {
  ctx.fillStyle = isBlueprint ? '#111e36' : C_HEADER;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HDR_TXT;
  ctx.font = 'bold 8px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), x + 6, y + h / 2);
  if (isBlueprint) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke();
  }
}

/** Thin horizontal rule. */
function hRule(ctx, x, y, w) {
  ctx.save();
  ctx.strokeStyle = C_BORDER;
  ctx.lineWidth   = 0.5;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke();
  ctx.restore();
}

/**
 * Wrap and draw text inside a box.  Returns the Y coordinate after the last line.
 */
function drawWrappedText(ctx, text, x, y, maxW, lineH) {
  const words = String(text).split(' ');
  let line = '';
  for (const w of words) {
    const test = line + (line ? ' ' : '') + w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y); y += lineH; line = w;
    } else { line = test; }
  }
  if (line) { ctx.fillText(line, x, y); y += lineH; }
  return y;
}

/**
 * Draw the title block (compact version used inside the footer).
 * Returns the bottom Y coordinate of the block.
 */
function drawTitleBlock(ctx, x, y, w, h, meta, pageN, pageTotal, isBlueprint = false) {
  // Outer border
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  // "METES & BOUNDS PLATTED SKETCH" header
  const hdrH = 18;
  drawPanelHeader(ctx, x, y, w, hdrH, 'METES & BOUNDS PLATTED SKETCH', isBlueprint);

  // Field rows in pairs
  const pairs = [
    [
      ['PARCEL', meta.parcel || 'SUBJECT PARCEL'],
      ['DATE', new Date().toISOString().slice(0, 10)]
    ],
    [
      ['COUNTY / REGION', meta.county || 'UNINCORPORATED AREA'],
      ['STATE', meta.state || 'GENERAL RECORD']
    ],
    [
      ['AREA', meta.areaAcres ? `${parseFloat(meta.areaAcres).toFixed(4)} AC` : '—'],
      ['PERIMETER', meta.perimeter ? `${parseFloat(meta.perimeter).toFixed(2)} FT` : '—']
    ],
    [
      ['BASIS OF BEARINGS', meta.basisOfBearings || 'DEED OF RECORD'],
      ['STATUS', meta.status || '—']
    ],
    [
      ['PLATFORM', 'BOUNDARY.IQ PLATFORM'],
      pageN && pageTotal ? ['PAGE', `${pageN} OF ${pageTotal}`] : ['CLIENT', 'RECORD HOLDER']
    ]
  ];

  let fy = y + hdrH + 3;
  const colX1 = x + 6;
  const colW1 = Math.floor((w - 12) / 2) - 4;
  const colX2 = x + 6 + Math.floor((w - 12) / 2) + 4;
  const availRows = pairs.length;
  const rowH = (h - hdrH - 6) / availRows;

  // Draw vertical separator down the middle
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BORDER;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y + hdrH);
  ctx.lineTo(x + w / 2, y + h);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  for (const [f1, f2] of pairs) {
    if (fy + rowH > y + h - 2) break;

    // Draw field 1 (left column)
    if (f1) {
      ctx.font = '6px sans-serif'; ctx.fillStyle = isBlueprint ? '#94a3b8' : '#888888'; ctx.textAlign = 'left';
      ctx.fillText(f1[0].toUpperCase(), colX1, fy + 7);
      ctx.font = 'bold 7.5px sans-serif'; ctx.fillStyle = isBlueprint ? '#f1f5f9' : C_BLACK;
      let val1 = String(f1[1]);
      if (ctx.measureText(val1).width > colW1) {
        while (val1.length > 0 && ctx.measureText(val1 + '...').width > colW1) {
          val1 = val1.slice(0, -1);
        }
        val1 += '...';
      }
      ctx.fillText(val1, colX1, fy + 17);
    }

    // Draw field 2 (right column)
    if (f2) {
      ctx.font = '6px sans-serif'; ctx.fillStyle = isBlueprint ? '#94a3b8' : '#888888'; ctx.textAlign = 'left';
      ctx.fillText(f2[0].toUpperCase(), colX2, fy + 7);
      ctx.font = 'bold 7.5px sans-serif'; ctx.fillStyle = isBlueprint ? '#f1f5f9' : C_BLACK;
      let val2 = String(f2[1]);
      if (ctx.measureText(val2).width > colW1) {
        while (val2.length > 0 && ctx.measureText(val2 + '...').width > colW1) {
          val2 = val2.slice(0, -1);
        }
        val2 += '...';
      }
      ctx.fillText(val2, colX2, fy + 17);
    }

    fy += rowH;
    ctx.save();
    ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BORDER;
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x + 4, fy); ctx.lineTo(x + w - 4, fy); ctx.stroke();
    ctx.restore();
  }
  return y + h;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Helper functions to compute intermediate curve/creek coordinates
// ─────────────────────────────────────────────────────────────────────────────
function getCurvePoints(p1, p2, course, steps = 20) {
  const R = parseFloat(course.radius);
  if (!R || isNaN(R)) return [p1, p2];

  const dx = p2.easting - p1.easting;
  const dy = p2.northing - p1.northing;
  const chord = Math.hypot(dx, dy);
  if (chord < 0.01) return [p1, p2];

  const rSq = R * R;
  const halfChordSq = (chord / 2) * (chord / 2);
  if (rSq < halfChordSq) return [p1, p2];
  const h = Math.sqrt(rSq - halfChordSq);

  const mx = (p1.easting + p2.easting) / 2;
  const my = (p1.northing + p2.northing) / 2;

  const ux = -dy / chord;
  const uy = dx / chord;

  const isLeft = (course.curveDirection || '').toLowerCase() === 'left';
  const cx = isLeft ? mx + h * ux : mx - h * ux;
  const cy = isLeft ? my + h * uy : my - h * uy;

  const a1 = Math.atan2(p1.northing - cy, p1.easting - cx);
  const a2 = Math.atan2(p2.northing - cy, p2.easting - cx);

  let diff = a2 - a1;
  if (isLeft) {
    if (diff < 0) diff += 2 * Math.PI;
  } else {
    if (diff > 0) diff -= 2 * Math.PI;
  }

  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const angle = a1 + diff * t;
    pts.push({
      easting: cx + R * Math.cos(angle),
      northing: cy + R * Math.sin(angle)
    });
  }
  return pts;
}

function getWavyCreekPoints(p1, p2, frequency = 4, amplitude = 4, steps = 30) {
  const pts = [];
  const dx = p2.easting - p1.easting;
  const dy = p2.northing - p1.northing;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [p1, p2];

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const distAlong = t * len;
    const wave = Math.sin(t * Math.PI * frequency) * amplitude;
    pts.push({
      easting: p1.easting + ux * distAlong + px * wave,
      northing: p1.northing + uy * distAlong + py * wave
    });
  }
  return pts;
}

function getDensePoints(pts, coursesList) {
  if (!pts || pts.length === 0) return pts;
  if (!coursesList || coursesList.length === 0) return pts;
  const dense = [];
  dense.push(pts[0]);
  for (let i = 0; i < coursesList.length; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1] || pts[0];
    const c = coursesList[i];
    if (!p1 || !p2 || !c) continue;

    const isCreek = /stream|creek|river|meander|water|shoreline|center\s*line\s*of\s*an?\s*existing|along\s+said\s+center\s+line/i.test(c.description || c.label || c.bearing || '');

    if (c.type?.toLowerCase() === 'curve' || c.Type?.toLowerCase() === 'curve') {
      const curvePts = getCurvePoints(p1, p2, c, 20);
      for (let j = 1; j < curvePts.length; j++) {
        dense.push(curvePts[j]);
      }
    } else if (isCreek) {
      const creekPts = getWavyCreekPoints(p1, p2, 4, 3.5, 30);
      for (let j = 1; j < creekPts.length; j++) {
        dense.push(creekPts[j]);
      }
    } else {
      dense.push(p2);
    }
  }
  return dense;
}

function drawTreeSymbol(ctx, cx, cy, r, isBlueprint = false) {
  ctx.save();
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : '#334155';
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r * 0.2), cy + Math.sin(a) * (r * 0.2));
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: draw the boundary geometry onto a canvas region
// region: { x, y, w, h } — pixel region available for the map drawing
// ─────────────────────────────────────────────────────────────────────────────
function drawBoundaryGeometry(ctx, rawPts, adjPts, courses, region, opts = {}, meta = {}) {
  const { x: rx, y: ry, w: rw, h: rh } = region;
  const { showRaw = true, showAdj = true, showGrid = true, showLabels = true, uncorrected = false, showConceptualDetail = false, isBlueprint = false } = opts;

  const isOpenEnded = opts.isOpenEnded || meta.isOpenEnded || false;

  const activePts = adjPts.length >= 2 ? adjPts : rawPts;

  // Check if this is a PLSS aliquot deed (uses Section/Township/Range subdivision)
  const isPlss = meta && meta.parcel && (
    /sec/i.test(meta.parcel) ||
    /township/i.test(meta.parcel) ||
    /range/i.test(meta.parcel) ||
    /T\d+[NS]/i.test(meta.parcel) ||
    /quarter/i.test(meta.parcel) ||
    /[¼½]/.test(meta.parcel) ||
    /\d\/\d/.test(meta.parcel)
  );

  let minN, maxN, minE, maxE;
  if (isPlss) {
    // Show the entire 640-acre Section grid (5280 x 5280 ft) starting from base origin
    minN = 5000;
    maxN = 10280;
    minE = 5000;
    maxE = 10280;
  } else {
    const ns = activePts.map(p => p.northing);
    const es = activePts.map(p => p.easting);
    minN = Math.min(...ns);
    maxN = Math.max(...ns);
    minE = Math.min(...es);
    maxE = Math.max(...es);
  }

  const rangeN = maxN - minN || 1;
  const rangeE = maxE - minE || 1;

  const availW = rw - PAD * 2;
  const availH = rh - PAD * 2;
  const scale  = Math.min(availW / rangeE, availH / rangeN);

  const drawW  = rangeE * scale;
  const drawH  = rangeN * scale;
  const offX   = rx + PAD + (availW - drawW) / 2;
  const offY   = ry + PAD + (availH - drawH) / 2;

  const tx = e => offX + (e - minE) * scale;
  const ty = n => offY + drawH - (n - minN) * scale;

  // Theme colors
  const themeGrid = isBlueprint ? 'rgba(56, 189, 248, 0.15)' : 'rgba(0,0,0,0.06)';
  const themeBorder = isBlueprint ? '#38bdf8' : '#000000';
  const themeBoundary = isBlueprint ? '#00f3ff' : '#000000';
  const themeRaw = isBlueprint ? '#fb7185' : '#e63946';
  const themeLabelBox = isBlueprint ? '#0c1a2d' : '#f8f5ed';
  const themeText = isBlueprint ? '#ffffff' : '#000000';
  const themeTextMuted = isBlueprint ? '#94a3b8' : '#334155';
  const themeFill = isBlueprint ? 'rgba(0, 243, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)';

  // Clip to region
  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();

  // Grid
  if (showGrid) {
    ctx.strokeStyle = themeGrid;
    ctx.lineWidth   = 0.5;
    const step = 60;
    for (let gx = rx + step; gx < rx + rw; gx += step) {
      ctx.beginPath(); ctx.moveTo(gx, ry + 10); ctx.lineTo(gx, ry + rh - 10); ctx.stroke();
    }
    for (let gy = ry + step; gy < ry + rh; gy += step) {
      ctx.beginPath(); ctx.moveTo(rx + 10, gy); ctx.lineTo(rx + rw - 10, gy); ctx.stroke();
    }
  }

  // Draw PLSS Cadastral Section Breakdown Grid
  if (isPlss) {
    ctx.save();

    // 1. Quarter-Quarter lines (thin light-gray dashed lines dividing into 40-ac lots)
    ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.15)' : 'rgba(26, 46, 68, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 4]);
    // Verticals
    [6320, 8960].forEach(e => {
      ctx.beginPath(); ctx.moveTo(tx(e), ty(5000)); ctx.lineTo(tx(e), ty(10280)); ctx.stroke();
    });
    // Horizontals
    [6320, 8960].forEach(n => {
      ctx.beginPath(); ctx.moveTo(tx(5000), ty(n)); ctx.lineTo(tx(10280), ty(n)); ctx.stroke();
    });

    // 2. Main Quarter-Section lines (darker gray dashed lines dividing into 160-ac quarters)
    ctx.strokeStyle = isBlueprint ? '#38bdf8' : '#4b5563';
    ctx.lineWidth = 1.0;
    ctx.setLineDash([6, 6]);
    // Vertical center line (easting = 7640)
    ctx.beginPath(); ctx.moveTo(tx(7640), ty(5000)); ctx.lineTo(tx(7640), ty(10280)); ctx.stroke();
    // Horizontal center line (northing = 7640)
    ctx.beginPath(); ctx.moveTo(tx(5000), ty(7640)); ctx.lineTo(tx(10280), ty(7640)); ctx.stroke();

    // 3. Section Boundary (thick black solid border)
    ctx.strokeStyle = themeBorder;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(tx(5000), ty(10280), (10280 - 5000) * scale, (10280 - 5000) * scale);

    // 4. Quadrant labels (faded elegant gray text in their geometric centers)
    ctx.fillStyle = isBlueprint ? 'rgba(56, 189, 248, 0.2)' : 'rgba(0, 0, 0, 0.08)';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NW 1/4', tx(6320), ty(8960));
    ctx.fillText('NE 1/4', tx(8960), ty(8960));
    ctx.fillText('SW 1/4', tx(6320), ty(6320));
    ctx.fillText('SE 1/4', tx(8960), ty(6320));

    // 5. Central section number badge
    ctx.fillStyle = isBlueprint ? 'rgba(56, 189, 248, 0.06)' : 'rgba(26, 46, 68, 0.06)';
    ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.2)' : 'rgba(26, 46, 68, 0.2)';
    ctx.lineWidth = 0.75;
    const midX = tx(7640), midY = ty(7640);
    ctx.fillRect(midX - 35, midY - 9, 70, 18);
    ctx.strokeRect(midX - 35, midY - 9, 70, 18);
    ctx.fillStyle = isBlueprint ? '#38bdf8' : '#1a2e44';
    ctx.font = 'bold 7.5px sans-serif';
    ctx.fillText('SECTION 12', midX, midY);

    // 6. Label our actual 40-acre parcel in its center
    // Our parcel NW 1/4 of SE 1/4 lies in easting 7640-8960, northing 6320-7640
    ctx.fillStyle = isBlueprint ? '#fb7185' : '#cc0000';
    ctx.font = 'bold 7.5px sans-serif';
    ctx.fillText('SUBJECT PARCEL', tx(8300), ty(7040));
    ctx.font = 'bold 6.5px sans-serif';
    ctx.fillText('(40.00 ACRES)', tx(8300), ty(6920));

    ctx.restore();
  }

  // Build course label lists
  let lineCount = 0, curveCount = 0;
  const linesList  = [];
  const curvesList = [];
  courses?.forEach((c, idx) => {
    if ((c.type || '').toLowerCase() === 'curve') {
      curveCount++;
      curvesList.push({ id: `C${curveCount}`, idx, arcLength: c.arcLength, chordBearing: c.chordBearing, chordDistance: c.chordDistance, radius: c.radius, delta: c.delta });
    } else {
      lineCount++;
      linesList.push({ id: `L${lineCount}`, idx, bearing: c.bearing, distance: c.distance });
    }
  });

  const drawPts = adjPts.length >= 2 ? adjPts : rawPts;
  const denseRawPts = getDensePoints(rawPts, courses);
  const denseDrawPts = getDensePoints(drawPts, courses);

  // Raw traverse (red dashed)
  if (showRaw && denseRawPts.length >= 2) {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = themeRaw;
    ctx.lineWidth   = 1.25;
    ctx.setLineDash([4, 4]);
    if (isBlueprint) {
      ctx.shadowColor = themeRaw;
      ctx.shadowBlur = 4;
    }
    ctx.moveTo(tx(denseRawPts[0].easting), ty(denseRawPts[0].northing));
    for (let i = 1; i < denseRawPts.length; i++) {
      ctx.lineTo(tx(denseRawPts[i].easting), ty(denseRawPts[i].northing));
    }
    ctx.stroke();
    ctx.restore();
  }

  // Adjusted boundary fill + stroke  (or uncorrected dashed)
  if (denseDrawPts.length >= 2) {
    // Fill
    if (!isOpenEnded) {
      ctx.beginPath();
      ctx.moveTo(tx(denseDrawPts[0].easting), ty(denseDrawPts[0].northing));
      for (let i = 1; i < denseDrawPts.length; i++) {
        ctx.lineTo(tx(denseDrawPts[i].easting), ty(denseDrawPts[i].northing));
      }
      ctx.closePath();
      ctx.fillStyle = themeFill;
      ctx.fill();
    }

    // Stroke
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = themeBoundary;
    ctx.lineWidth   = 2.0;
    if (isBlueprint) {
      ctx.shadowColor = themeBoundary;
      ctx.shadowBlur = 6;
    }
    if (uncorrected) ctx.setLineDash([8, 6]);
    ctx.moveTo(tx(denseDrawPts[0].easting), ty(denseDrawPts[0].northing));
    for (let i = 1; i < denseDrawPts.length; i++) {
      ctx.lineTo(tx(denseDrawPts[i].easting), ty(denseDrawPts[i].northing));
    }
    if (!isOpenEnded) {
      ctx.closePath();
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 3.5. Draw Conceptual Details (Angled labels, Roadway, Easement, Center label, Creek, Setbacks, Residence, Trees)
  if (showConceptualDetail && adjPts.length > 1 && !isOpenEnded) {
    const centerX = drawPts.reduce((sum, p) => sum + tx(p.easting), 0) / drawPts.length;
    const centerY = drawPts.reduce((sum, p) => sum + ty(p.northing), 0) / drawPts.length;

    // A. Angled Metes & Bounds Labels parallel to segments
    drawPts.forEach((p1, i) => {
      const p2 = drawPts[(i + 1) % drawPts.length];
      const x1 = tx(p1.easting), y1 = ty(p1.northing);
      const x2 = tx(p2.easting), y2 = ty(p2.northing);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;

      let theta = Math.atan2(y2 - y1, x2 - x1);
      // Keep text readable (left-to-right, not upside down)
      if (theta < -Math.PI / 2 || theta > Math.PI / 2) {
        theta += Math.PI;
      }

      // Calculate perpendicular offset vector pointing outwards
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len;
      let ox = px, oy = py;
      const d1 = Math.hypot(mx + px * 5 - centerX, my + py * 5 - centerY);
      const d2 = Math.hypot(mx - px * 5 - centerX, my - py * 5 - centerY);
      if (d1 < d2) {
        ox = -px; oy = -py;
      }

      // Offset text slightly outwards
      const lx = mx + ox * 10;
      const ly = my + oy * 10;

      // Retrieve segment data
      const c = courses[i];
      let labelText = '';
      if (c) {
        if ((c.type || '').toLowerCase() === 'curve') {
          labelText = `${c.chordBearing || ''} R=${c.radius ? parseFloat(c.radius).toFixed(1) : ''}' L=${c.arcLength ? parseFloat(c.arcLength).toFixed(1) : ''}'`;
        } else {
          labelText = `${c.bearing || ''} ${c.distance ? parseFloat(c.distance).toFixed(2) : ''}'`;
        }
      }

      if (labelText) {
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(theta);
        ctx.font = 'bold 7.5px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Background box for legibility
        const tw = ctx.measureText(labelText).width;
        ctx.fillStyle = themeLabelBox;
        ctx.fillRect(-tw / 2 - 2, -4, tw + 4, 8);
        ctx.fillStyle = themeText;
        ctx.fillText(labelText, 0, 0);
        ctx.restore();
      }
    });

    // B. Center Label
    ctx.save();
    ctx.fillStyle = themeText;
    ctx.font = 'bold 8.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const centerName = meta.parcel ? `PART OF ${meta.parcel.toUpperCase()}` : 'SUBJECT PARCEL';
    const centerArea = meta.areaAcres ? `${parseFloat(meta.areaAcres).toFixed(4)} ACRES` : '';
    ctx.fillText(centerName, centerX, centerY - 6);
    if (centerArea) {
      ctx.font = 'bold 7.5px sans-serif';
      ctx.fillText(centerArea, centerX, centerY + 6);
    }
    ctx.restore();

    // C. Roadway along bottom-most boundary segment
    let bottomIdx = 0;
    let maxMidY = -Infinity;
    drawPts.forEach((p1, i) => {
      const p2 = drawPts[(i + 1) % drawPts.length];
      const my = (ty(p1.northing) + ty(p2.northing)) / 2;
      if (my > maxMidY) {
        maxMidY = my;
        bottomIdx = i;
      }
    });

    const p1 = drawPts[bottomIdx];
    const p2 = drawPts[(bottomIdx + 1) % drawPts.length];
    const ax = tx(p1.easting), ay = ty(p1.northing);
    const bx = tx(p2.easting), by = ty(p2.northing);

    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let rnx = -dy / len, rny = dx / len;
    if (rny < 0) {
      rnx = -rnx; rny = -rny;
    }

    // Road edge lines (Curb property line & far road side)
    const offsetCurb = 14;
    const offsetFar = 42;
    const offsetCenter = 28;

    ctx.strokeStyle = themeTextMuted;
    ctx.lineWidth = 1.25;

    // Property curb line (solid)
    ctx.beginPath();
    ctx.moveTo(ax + rnx * offsetCurb - dx * 0.2, ay + rny * offsetCurb - dy * 0.2);
    ctx.lineTo(bx + rnx * offsetCurb + dx * 0.2, by + rny * offsetCurb + dy * 0.2);
    ctx.stroke();

    // Far road edge (solid)
    ctx.beginPath();
    ctx.moveTo(ax + rnx * offsetFar - dx * 0.2, ay + rny * offsetFar - dy * 0.2);
    ctx.lineTo(bx + rnx * offsetFar + dx * 0.2, by + rny * offsetFar + dy * 0.2);
    ctx.stroke();

    // Center line (dashed)
    ctx.strokeStyle = themeTextMuted;
    ctx.lineWidth = 0.75;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(ax + rnx * offsetCenter - dx * 0.2, ay + rny * offsetCenter - dy * 0.2);
    ctx.lineTo(bx + rnx * offsetCenter + dx * 0.2, by + rny * offsetCenter + dy * 0.2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Road Label
    const getStreetName = (text) => {
      if (!text) return null;
      const match = text.match(/([A-Za-z0-9\s]+?\s+(?:Boulevard|Blvd|Parkway|Pkwy|Avenue|Ave|Street|St|Road|Rd|Highway|Hwy|Lane|Ln|Drive|Dr|Way|Court|Ct|Circle|Cir))/i);
      if (match) {
        const words = match[1].trim().split(/\s+/);
        if (words.length > 3) return words.slice(-3).join(' ').toUpperCase();
        return match[1].trim().toUpperCase();
      }
      return null;
    };

    const roadLabel = (getStreetName(meta.legalDescription || '') || 'PUBLIC ROADWAY') + ' R.O.W.';
    const rmx = (ax + bx) / 2 + rnx * offsetCenter;
    const rmy = (ay + by) / 2 + rny * offsetCenter;
    let rtheta = Math.atan2(by - ay, bx - ax);
    if (rtheta < -Math.PI / 2 || rtheta > Math.PI / 2) {
      rtheta += Math.PI;
    }

    ctx.save();
    ctx.translate(rmx, rmy);
    ctx.rotate(rtheta);
    ctx.fillStyle = themeTextMuted;
    ctx.font = 'italic bold 7.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rtw = ctx.measureText(roadLabel).width;
    ctx.fillStyle = themeLabelBox;
    ctx.fillRect(-rtw / 2 - 3, -5, rtw + 6, 10);
    ctx.fillStyle = themeTextMuted;
    ctx.fillText(roadLabel, 0, 0);
    ctx.restore();

    // D. Utility Easement along rear (opposite of bottom)
    const rearIdx = (bottomIdx + Math.floor(drawPts.length / 2)) % drawPts.length;
    const rp1 = drawPts[rearIdx];
    const rp2 = drawPts[(rearIdx + 1) % drawPts.length];
    const rcx = tx(rp1.easting), rcy = ty(rp1.northing);
    const rdx_pt = tx(rp2.easting), rdy_pt = ty(rp2.northing);

    const rdx = rdx_pt - rcx, rdy = rdy_pt - rcy;
    const rlen = Math.hypot(rdx, rdy) || 1;
    let einx = -rdy / rlen, einy = rdx / rlen;
    const esmx = (rcx + rdx_pt) / 2;
    const esmy = (rcy + rdy_pt) / 2;
    const ed1 = Math.hypot(esmx + einx * 5 - centerX, esmy + einy * 5 - centerY);
    const ed2 = Math.hypot(esmx - einx * 5 - centerX, esmy - einy * 5 - centerY);
    if (ed2 < ed1) {
      einx = -einx; einy = -einy;
    }

    // Draw easement line offset inwards by 12px
    const eax = rcx + einx * 12, eay = rcy + einy * 12;
    const ebx = rdx_pt + einx * 12, eby = rdy_pt + einy * 12;

    ctx.strokeStyle = isBlueprint ? '#fb7185' : 'rgba(239, 68, 68, 0.65)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(eax, eay);
    ctx.lineTo(ebx, eby);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label easement
    const emx = (eax + ebx) / 2;
    const emy = (eay + eby) / 2;
    let etheta = Math.atan2(eby - eay, ebx - eax);
    if (etheta < -Math.PI / 2 || etheta > Math.PI / 2) {
      etheta += Math.PI;
    }

    ctx.save();
    ctx.translate(emx, emy);
    ctx.rotate(etheta);
    ctx.fillStyle = isBlueprint ? '#f43f5e' : '#ef4444';
    ctx.font = 'italic bold 6.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText("10' UTILITY EASEMENT", 0, -2);
    ctx.restore();

    // E. Wavy Creek details (if any segment is a creek)
    courses.forEach((c, idx) => {
      const isCreek = /stream|creek|river|meander|water|shoreline|center\s*line\s*of\s*an?\s*existing|along\s+said\s+center\s+line/i.test(c.description || c.label || c.bearing || '');
      if (isCreek) {
        const p1_c = drawPts[idx];
        const p2_c = drawPts[(idx + 1) % drawPts.length];
        if (!p1_c || !p2_c) return;

        const x1 = tx(p1_c.easting), y1 = ty(p1_c.northing);
        const x2 = tx(p2_c.easting), y2 = ty(p2_c.northing);

        const ptsWavy = getWavyCreekPoints(p1_c, p2_c, 4, 3.5, 30);
        
        // Left Bank
        ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.5)' : 'rgba(51, 65, 85, 0.4)';
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ptsWavy.forEach((pt, j) => {
          const dx_pt = ptsWavy[Math.min(j + 1, ptsWavy.length - 1)].easting - pt.easting;
          const dy_pt = ptsWavy[Math.min(j + 1, ptsWavy.length - 1)].northing - pt.northing;
          const len_pt = Math.hypot(dx_pt, dy_pt) || 1;
          const px_pt = -dy_pt / len_pt;
          const py_pt = dx_pt / len_pt;
          const bx_p = tx(pt.easting) + px_pt * 4;
          const by_p = ty(pt.northing) + py_pt * 4;
          if (j === 0) ctx.moveTo(bx_p, by_p);
          else ctx.lineTo(bx_p, by_p);
        });
        ctx.stroke();

        // Right Bank
        ctx.beginPath();
        ptsWavy.forEach((pt, j) => {
          const dx_pt = ptsWavy[Math.min(j + 1, ptsWavy.length - 1)].easting - pt.easting;
          const dy_pt = ptsWavy[Math.min(j + 1, ptsWavy.length - 1)].northing - pt.northing;
          const len_pt = Math.hypot(dx_pt, dy_pt) || 1;
          const px_pt = -dy_pt / len_pt;
          const py_pt = dx_pt / len_pt;
          const bx_p = tx(pt.easting) - px_pt * 4;
          const by_p = ty(pt.northing) - py_pt * 4;
          if (j === 0) ctx.moveTo(bx_p, by_p);
          else ctx.lineTo(bx_p, by_p);
        });
        ctx.stroke();

        const centerPt = ptsWavy[Math.floor(ptsWavy.length / 2)];
        ctx.save();
        ctx.translate(tx(centerPt.easting), ty(centerPt.northing));
        ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
        ctx.fillStyle = isBlueprint ? '#38bdf8' : '#334155';
        ctx.font = 'italic bold 6px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText("NATIVE CREEK", 0, 10);
        ctx.restore();

        // 25' Riparian Buffer
        ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.5)' : 'rgba(51, 65, 85, 0.4)';
        ctx.lineWidth = 0.75;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ptsWavy.forEach((pt, j) => {
          const dx_pt = ptsWavy[Math.min(j + 1, ptsWavy.length - 1)].easting - pt.easting;
          const dy_pt = ptsWavy[Math.min(j + 1, ptsWavy.length - 1)].northing - pt.northing;
          const len_pt = Math.hypot(dx_pt, dy_pt) || 1;
          const px_pt = -dy_pt / len_pt;
          const py_pt = dx_pt / len_pt;
          
          const mx_pt = tx(pt.easting);
          const my_pt = ty(pt.northing);
          const testX1 = mx_pt + px_pt * 15;
          const testY1 = my_pt + py_pt * 15;
          const testX2 = mx_pt - px_pt * 15;
          const testY2 = my_pt - py_pt * 15;
          const d_1 = Math.hypot(testX1 - centerX, testY1 - centerY);
          const d_2 = Math.hypot(testX2 - centerX, testY2 - centerY);
          const sign = d_1 < d_2 ? 1 : -1;

          const bx_p = mx_pt + px_pt * 15 * sign;
          const by_p = my_pt + py_pt * 15 * sign;
          if (j === 0) ctx.moveTo(bx_p, by_p);
          else ctx.lineTo(bx_p, by_p);
        });
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.save();
        ctx.translate(tx(centerPt.easting), ty(centerPt.northing));
        ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
        ctx.fillStyle = isBlueprint ? '#38bdf8' : '#334155';
        ctx.font = 'italic 5px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText("25' RIPARIAN BUFFER", 0, -15);
        ctx.restore();
      }
    });

    // F. Setbacks and Residence Footprint
    ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.35)' : 'rgba(51, 65, 85, 0.25)';
    ctx.lineWidth = 0.75;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    drawPts.forEach((p, i) => {
      const next = drawPts[(i + 1) % drawPts.length];
      const x1 = tx(p.easting), y1 = ty(p.northing);
      const x2 = tx(next.easting), y2 = ty(next.northing);

      const dx_s = x2 - x1, dy_s = y2 - y1;
      const len_s = Math.hypot(dx_s, dy_s) || 1;
      const px_s = -dy_s / len_s, py_s = dx_s / len_s;
      const mx_s = (x1 + x2) / 2, my_s = (y1 + y2) / 2;
      const d1 = Math.hypot(mx_s + px_s * 5 - centerX, my_s + py_s * 5 - centerY);
      const d2 = Math.hypot(mx_s - px_s * 5 - centerX, my_s - py_s * 5 - centerY);
      const inX = d1 < d2 ? px_s : -px_s;
      const inY = d1 < d2 ? py_s : -py_s;

      const offsetFt = i === bottomIdx ? 35 : (i === rearIdx ? 20 : 15);
      const offsetPx = offsetFt * scale * 0.15;

      const ox1 = x1 + inX * offsetPx;
      const oy1 = y1 + inY * offsetPx;
      const ox2 = x2 + inX * offsetPx;
      const oy2 = y2 + inY * offsetPx;

      if (i === 0) ctx.moveTo(ox1, oy1);
      ctx.lineTo(ox2, oy2);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Residence footprint placement at centroid
    const houseW = 35 * scale * 0.18;
    const houseH = 50 * scale * 0.18;
    if (houseW > 10 && houseH > 10) {
      ctx.fillStyle = isBlueprint ? '#1e293b' : '#e2e8f0';
      ctx.strokeStyle = isBlueprint ? '#00f3ff' : '#0f172a';
      ctx.lineWidth = 1.25;
      ctx.fillRect(centerX - houseW/2, centerY - houseH/2, houseW, houseH);
      ctx.strokeRect(centerX - houseW/2, centerY - houseH/2, houseW, houseH);

      ctx.fillStyle = isBlueprint ? '#ffffff' : '#0f172a';
      ctx.font = 'bold 5.5px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('RESIDENCE', centerX, centerY);

      ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.4)' : 'rgba(51, 65, 85, 0.3)';
      ctx.lineWidth = 0.5;

      ctx.beginPath();
      ctx.moveTo(centerX, centerY + houseH/2);
      ctx.lineTo(centerX, centerY + houseH/2 + 25);
      ctx.stroke();
      
      ctx.fillStyle = isBlueprint ? '#a5f3fc' : '#334155';
      ctx.font = '5px sans-serif';
      ctx.fillText("35' FRONT SB", centerX, centerY + houseH/2 + 12);

      ctx.beginPath();
      ctx.moveTo(centerX, centerY - houseH/2);
      ctx.lineTo(centerX, centerY - houseH/2 - 20);
      ctx.stroke();
      ctx.fillText("20' REAR SB", centerX, centerY - houseH/2 - 10);
    }

    // G. Draw Tree Symbols in yard areas
    const treePositions = [
      { x: centerX - houseW * 1.2, y: centerY - houseH * 0.8, r: 8 },
      { x: centerX - houseW * 1.5, y: centerY + houseH * 0.8, r: 6 },
      { x: centerX + houseW * 1.4, y: centerY - houseH * 0.9, r: 7 },
      { x: centerX + houseW * 1.3, y: centerY + houseH * 0.7, r: 9 }
    ];

    treePositions.forEach(pos => {
      drawTreeSymbol(ctx, pos.x, pos.y, pos.r, isBlueprint);
    });
  }

  // Station nodes + vertex labels
  const labelPts = adjPts.length >= 2 ? adjPts : rawPts;
  labelPts.forEach((p, i) => {
    const px = tx(p.easting), py = ty(p.northing);
    ctx.beginPath();
    ctx.arc(px, py, i === 0 ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle   = i === 0 ? themeBoundary : '#ffffff';
    ctx.strokeStyle = themeBorder;
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
    if (labelPts.length <= 35) {
      ctx.fillStyle    = themeText;
      ctx.font         = 'bold 9px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(i === 0 ? 'POB' : `${i}`, px + 6, py - 4);
    }
  });

  // Course midpoint labels (L1, C1…)
  if (showLabels && courses?.length > 0) {
    const centerX = labelPts.reduce((sum, p) => sum + tx(p.easting), 0) / labelPts.length;
    const centerY = labelPts.reduce((sum, p) => sum + ty(p.northing), 0) / labelPts.length;

    ctx.fillStyle    = themeText;
    ctx.font         = 'bold 9px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    courses.forEach((c, i) => {
      const p1 = labelPts[i];
      const p2 = labelPts[i + 1] || labelPts[0];
      if (!p1 || !p2) return;
      const x1 = tx(p1.easting), y1 = ty(p1.northing);
      const x2 = tx(p2.easting), y2 = ty(p2.northing);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;

      let theta = Math.atan2(y2 - y1, x2 - x1);
      if (theta < -Math.PI / 2 || theta > Math.PI / 2) {
        theta += Math.PI;
      }

      // Calculate outward normal vector
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len;
      let ox = px, oy = py;
      const d1 = Math.hypot(mx + px * 5 - centerX, my + py * 5 - centerY);
      const d2 = Math.hypot(mx - px * 5 - centerX, my - py * 5 - centerY);
      if (d1 < d2) {
        ox = -px; oy = -py;
      }

      let labelId = '';
      if ((c.type || '').toLowerCase() === 'curve') {
        const m = curvesList.find(x => x.idx === i); labelId = m ? m.id : '';
      } else {
        const m = linesList.find(x  => x.idx === i); labelId = m ? m.id : '';
      }

      if (labelId) {
        // Offset inwards if showConceptualDetail is true (so it doesn't overlap with bearing/distance on the outside)
        // Otherwise offset outwards
        const sideMultiplier = showConceptualDetail ? -1 : 1;
        const lx = mx + ox * 10 * sideMultiplier;
        const ly = my + oy * 10 * sideMultiplier;

        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(theta);

        // Background box for legibility
        ctx.fillStyle = themeLabelBox;
        const tw = ctx.measureText(labelId).width;
        ctx.fillRect(-tw / 2 - 2, -5, tw + 4, 10);

        ctx.fillStyle = themeText;
        ctx.fillText(labelId, 0, 0);
        ctx.restore();
      }
    });
  }

  // UNCORRECTED watermark
  if (uncorrected) {
    ctx.save();
    ctx.translate(rx + rw / 2, ry + rh / 2);
    ctx.rotate(-Math.PI / 6);
    ctx.font         = 'bold 56px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = C_UNCORR;
    ctx.fillText('UNCORRECTED', 0, 0);
    ctx.restore();
  }

  ctx.restore(); // remove clip

  const hasZeroLengthLines = (courses && courses.some(c => c.assumedZeroLength || c.distance === 0 || c.chordDistance === 0)) ||
                             (meta && meta.hasZeroLengthLines === true);
  if (hasZeroLengthLines) {
    ctx.save();
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⚠️ WARNING: 0-LENGTH LINES DETECTED & ASSUMED 10.0 FT FOR CONCEPTUAL SKETCH (VERIFY DEED)', rx + rw / 2, ry + 15);
    ctx.restore();
  }

  // ── North arrow (top-right of the region) ────────────────────────────────
  const ax = rx + rw - 40;
  const ay = ry + 42;
  ctx.save();
  ctx.translate(ax, ay);
  ctx.fillStyle    = themeText;
  ctx.font         = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('N', 0, -22);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-7, 8); ctx.lineTo(0, 1); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(0, 12); ctx.stroke();
  ctx.restore();

  // ── Scale bar (bottom-left of the region) ────────────────────────────────
  ctx.save();
  const targets = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  let bestD = 100;
  for (const d of targets) { if (d * scale >= 60) { bestD = d; break; } }
  const barW = bestD * scale;
  const bx = rx + PAD;
  const by = ry + rh - 20;
  const bh = 6;
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1.25;
  ctx.fillStyle   = C_BLACK; ctx.fillRect(bx, by, barW / 2, bh); ctx.strokeRect(bx, by, barW / 2, bh);
  ctx.fillStyle   = '#ffffff'; ctx.fillRect(bx + barW / 2, by, barW / 2, bh); ctx.strokeRect(bx + barW / 2, by, barW / 2, bh);
  ctx.fillStyle   = C_BLACK;
  ctx.font        = '8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('0',             bx,            by - 4);
  ctx.fillText(`${bestD / 2}`, bx + barW / 2, by - 4);
  ctx.fillText(`${bestD} Ft`,  bx + barW,     by - 4);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: draw the mapcheck / closure verification box
// ─────────────────────────────────────────────────────────────────────────────
function drawMapcheck(ctx, x, y, w, h, closure, units, isBlueprint = false) {
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  drawPanelHeader(ctx, x, y, w, 16, 'MAPCHECK / CLOSURE VERIFICATION', isBlueprint);

  const pass = !closure?.status?.includes('FAIL') && !closure?.status?.includes('✗');
  const items = [
    ['PRECISION RATIO',    closure?.precisionRatio    || '1:∞',      true,  pass ? C_PASS : C_FAIL],
    ['LINEAR CLOSURE ERR', closure?.linearError       != null
                              ? `${parseFloat(closure.linearError).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}`
                              : '0.0000 FT',                         false, isBlueprint ? '#f1f5f9' : C_BLACK],
    ['ERROR NORTHING',     closure?.errorNorthing      != null
                              ? `${parseFloat(closure.errorNorthing).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}`
                              : '0.0000 FT',                         false, isBlueprint ? '#f1f5f9' : C_BLACK],
    ['ERROR EASTING',      closure?.errorEasting       != null
                              ? `${parseFloat(closure.errorEasting).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}`
                              : '0.0000 FT',                         false, isBlueprint ? '#f1f5f9' : C_BLACK],
    ['TRAVERSE STATUS',    closure?.status             || 'PASS',    true,  pass ? C_PASS : C_FAIL],
  ];

  let iy = y + 22;
  const col1X = x + 8;
  const col2X = x + w / 2 + 4;
  const colW  = w / 2 - 12;

  ctx.textBaseline = 'alphabetic';
  items.forEach(([label, value, bold, color], i) => {
    const ix = i < 2 ? col1X : (i < 4 ? col2X : col1X);
    const labelX = i < 4 ? (i % 2 === 0 ? col1X : col2X) : col1X;
    const cellX  = (i < 2) ? col1X : (i < 4 ? col2X : col1X);
    const cellW  = (i === 4) ? w - 16 : colW;
    ctx.font = '6.5px sans-serif'; ctx.fillStyle = isBlueprint ? '#94a3b8' : '#666666'; ctx.textAlign = 'left';
    ctx.fillText(label, cellX, iy);
    iy += 10;
    ctx.font = bold ? 'bold 9px sans-serif' : '8px monospace';
    ctx.fillStyle = color;
    ctx.fillText(String(value), cellX, iy);
    iy += (i === 1 || i === 3) ? -10 : 14;
    if (i === 1 || i === 3) iy += 14;
    if (i === 3) {
      ctx.save();
      ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BORDER;
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x + 4, iy - 4); ctx.lineTo(x + w - 4, iy - 4); ctx.stroke();
      ctx.restore();
    }
  });
}

function drawSheetNotes(ctx, x, y, w, h, title, lines, pageN, pageTotal, isBlueprint = false) {
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  drawPanelHeader(ctx, x, y, w, 16, title, isBlueprint);

  let ny = y + 24;
  ctx.font = '7.5px sans-serif'; ctx.fillStyle = isBlueprint ? '#f1f5f9' : '#333333'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  for (const line of lines) {
    if (ny > y + h - 20) break;
    ny = drawWrappedText(ctx, line, x + 8, ny, w - 16, 11);
  }

  // Page n of N footer inside box
  ctx.save();
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BORDER;
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(x + 4, y + h - 20); ctx.lineTo(x + w - 4, y + h - 20); ctx.stroke();
  ctx.restore();

  ctx.font = 'bold 7.5px sans-serif'; ctx.fillStyle = isBlueprint ? '#f1f5f9' : C_BLACK;
  ctx.textAlign = 'left';
  ctx.fillText(`SHEET ${pageN} OF ${pageTotal}`, x + 8, y + h - 8);
}

function drawLegalDescBox(ctx, x, y, w, h, text, headerText, isBlueprint = false) {
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  const hh = 18;
  drawPanelHeader(ctx, x, y, w, hh, headerText, isBlueprint);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y + hh + 1, w - 2, h - hh - 2);
  ctx.clip();

  ctx.font = '9.5px Georgia, serif';
  ctx.fillStyle    = isBlueprint ? '#f1f5f9' : '#111111';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'alphabetic';

  let ty2 = y + hh + 18;
  const indent = 24;
  const lineH  = 16;
  const maxLineW = w - 32;

  if (text) {
    let firstLine = true;
    const words = text.replace(/\r?\n/g, ' ').split(' ');
    let line = '';
    for (const word of words) {
      const test = line + (line ? ' ' : '') + word;
      const lineX = firstLine ? x + 8 + indent : x + 8;
      if (ctx.measureText(test).width > maxLineW && line) {
        ctx.fillText(line, lineX, ty2);
        ty2 += lineH;
        firstLine = false;
        line = word;
        if (ty2 > y + h - 6) break;
      } else {
        line = test;
      }
    }
    if (line && ty2 <= y + h - 6) {
      ctx.fillText(line, firstLine ? x + 8 + indent : x + 8, ty2);
    }
  } else {
    ctx.font      = 'italic 8.5px sans-serif';
    ctx.fillStyle = isBlueprint ? '#64748b' : '#888888';
    ctx.fillText('[No legal description provided]', x + 16, ty2 + 30);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 1 — Main boundary sketch + Mapcheck footer + Title block
// ─────────────────────────────────────────────────────────────────────────────
function renderPage1(stations, adjusted, courses, meta, closure, showConceptualDetail = false, isBlueprint = false) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx, isBlueprint);

  // Section title bar
  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = isBlueprint ? '#111e36' : C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('BOUNDARY SURVEY SKETCH — PAGE 1 OF 5', MARGIN + 8, titleY + titleBarH / 2);
  if (isBlueprint) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(MARGIN, titleY + titleBarH); ctx.lineTo(W - MARGIN, titleY + titleBarH); ctx.stroke();
  }

  // Map region (above footer)
  const mapY  = titleY + titleBarH + 4;
  const mapH  = H - mapY - FOOTER_H - 8;
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN, mapY, W - MARGIN * 2, mapH);

  const rawPts = (stations?.length >= 2)
    ? stations.map(s => ({ northing: s.northing, easting: s.easting }))
    : [];
  const adjPts = (adjusted?.length >= 2)
    ? adjusted.map(s => ({ northing: s.northing, easting: s.easting }))
    : rawPts;

  if (rawPts.length >= 2) {
    drawBoundaryGeometry(ctx, rawPts, adjPts, courses,
      { x: MARGIN, y: mapY, w: W - MARGIN * 2, h: mapH }, { showConceptualDetail, isBlueprint, isOpenEnded: meta.isOpenEnded || false }, meta);
  } else {
    ctx.fillStyle = isBlueprint ? '#94a3b8' : '#888888'; ctx.font = 'italic 16px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No traverse geometry available', W / 2, mapY + mapH / 2);
  }

  // Footer strip
  const footerY  = mapY + mapH + 6;
  const footerH  = H - footerY - MARGIN - 2;
  const notesW   = W - MARGIN * 2 - TB_W - 8;

  // Mapcheck box
  drawMapcheck(ctx, MARGIN, footerY, notesW, footerH, closure, meta.units, isBlueprint);

  // Title block
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 1, 5, isBlueprint);

  return canvas.toBuffer('image/png');
}

function renderPage2(originalLegalDesc, meta, isBlueprint = false) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx, isBlueprint);

  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = isBlueprint ? '#111e36' : C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('ORIGINAL DEED — LEGAL DESCRIPTION (PRE-CORRECTION) — PAGE 2 OF 5', MARGIN + 8, titleY + titleBarH / 2);
  if (isBlueprint) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(MARGIN, titleY + titleBarH); ctx.lineTo(W - MARGIN, titleY + titleBarH); ctx.stroke();
  }

  const bodyY = titleY + titleBarH + 4;
  const bodyH = H - bodyY - FOOTER_H - 8;

  drawLegalDescBox(ctx, MARGIN, bodyY, W - MARGIN * 2, bodyH, originalLegalDesc, 'ORIGINAL RECORD DESCRIPTION', isBlueprint);

  // Footer
  const footerY = bodyY + bodyH + 6;
  const footerH = H - footerY - MARGIN - 2;
  const notesW  = W - MARGIN * 2 - TB_W - 8;
  drawSheetNotes(ctx, MARGIN, footerY, notesW, footerH,
    'SHEET NOTES', [
      '1. This page contains the original deed legal description as extracted prior to AI-assisted repair.',
      '2. Refer to Page 4 for the corrected metes & bounds legal description after traverse closure repair.',
    ], 2, 5, isBlueprint);
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 2, 5, isBlueprint);

  return canvas.toBuffer('image/png');
}

function renderPage3(courses, meta, isBlueprint = false) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx, isBlueprint);

  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = isBlueprint ? '#111e36' : C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('SURVEY COMPILATION — LINE AND CURVE DATA TABLES — PAGE 3 OF 5', MARGIN + 8, titleY + titleBarH / 2);
  if (isBlueprint) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(MARGIN, titleY + titleBarH); ctx.lineTo(W - MARGIN, titleY + titleBarH); ctx.stroke();
  }

  // Build lists
  const linesList  = [];
  const curvesList = [];
  courses?.forEach((c, idx) => {
    if ((c.type || '').toLowerCase() === 'curve') {
      curvesList.push({ id: `C${curvesList.length + 1}`, idx, radius: c.radius, arcLength: c.arcLength, chordBearing: c.chordBearing, chordDistance: c.chordDistance, delta: c.delta, assumedZeroLength: c.assumedZeroLength });
    } else {
      linesList.push({ id: `L${linesList.length + 1}`, idx, bearing: c.bearing, distance: c.distance, assumedZeroLength: c.assumedZeroLength });
    }
  });

  const bodyY  = titleY + titleBarH + 4;
  const bodyH  = H - bodyY - FOOTER_H - 8;
  const halfW  = Math.floor((W - MARGIN * 2 - 8) / 2);

  const borderCol = isBlueprint ? '#38bdf8' : C_BLACK;
  const textCol = isBlueprint ? '#f1f5f9' : C_LABEL;
  const keyCol = isBlueprint ? '#ffffff' : C_BLACK;

  // ── Line table (left half) ───────────────────────────────────────────────
  const ltX = MARGIN;
  const ltW = halfW;
  ctx.strokeStyle = borderCol; ctx.lineWidth = 1;
  ctx.strokeRect(ltX, bodyY, ltW, bodyH);
  drawPanelHeader(ctx, ltX, bodyY, ltW, 18, 'LINE TABLE', isBlueprint);

  const ltColX = [ltX + 6, ltX + 40, ltX + 190];   // ID | BEARING | DISTANCE
  const ltHdrY = bodyY + 18 + 12;
  ctx.font = 'bold 8px monospace'; ctx.fillStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('ID',       ltColX[0], ltHdrY);
  ctx.fillText('BEARING',  ltColX[1], ltHdrY);
  ctx.fillText('DISTANCE', ltColX[2], ltHdrY);

  ctx.save();
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BORDER;
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(ltX + 4, ltHdrY + 3); ctx.lineTo(ltX + ltW - 4, ltHdrY + 3); ctx.stroke();
  ctx.restore();

  ctx.font = '8px monospace';
  let ltRow = ltHdrY + 14;
  const ltRowH = 12;
  const ltMaxRows = Math.floor((bodyH - 50) / ltRowH);
  linesList.slice(0, ltMaxRows).forEach((l, rIdx) => {
    if (isBlueprint && rIdx % 2 === 1) {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.5)';
      ctx.fillRect(ltX + 1, ltRow - 9, ltW - 2, ltRowH);
    }
    ctx.fillStyle = keyCol; ctx.fillText(l.id, ltColX[0], ltRow);
    ctx.fillStyle = textCol;
    ctx.fillText(l.bearing || '—', ltColX[1], ltRow);
    if (l.assumedZeroLength) {
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 8px monospace';
    }
    ctx.fillText(l.distance != null ? `${parseFloat(l.distance).toFixed(2)}'*` : '—', ltColX[2], ltRow);
    if (l.assumedZeroLength) {
      ctx.fillStyle = textCol;
      ctx.font = '8px monospace';
    }
    ltRow += ltRowH;
  });
  if (linesList.length > ltMaxRows) {
    ctx.fillStyle = isBlueprint ? '#94a3b8' : '#888888'; ctx.font = 'italic 7.5px sans-serif';
    ctx.fillText(`+${linesList.length - ltMaxRows} more…`, ltColX[0], ltRow);
  }
  if (linesList.length === 0) {
    ctx.fillStyle = isBlueprint ? '#94a3b8' : '#888888'; ctx.font = 'italic 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No Line Data Available', ltX + ltW / 2, bodyY + bodyH / 2);
  }

  // ── Curve table (right half) ─────────────────────────────────────────────
  const ctX = MARGIN + halfW + 8;
  const ctW = W - MARGIN * 2 - halfW - 8;
  ctx.strokeStyle = borderCol; ctx.lineWidth = 1;
  ctx.strokeRect(ctX, bodyY, ctW, bodyH);
  drawPanelHeader(ctx, ctX, bodyY, ctW, 18, 'CURVE TABLE', isBlueprint);

  // Columns: ID | RADIUS | ARC LEN | CHORD BRG | CHORD DIST
  const ctColX = [ctX + 6, ctX + 32, ctX + 90, ctX + 152, ctX + 272];
  const ctHdrY = bodyY + 18 + 12;
  ctx.font = 'bold 8px monospace'; ctx.fillStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ['ID','RADIUS','ARC LEN','CHORD BRG','CHORD DIST'].forEach((h, i) => ctx.fillText(h, ctColX[i], ctHdrY));

  ctx.save();
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BORDER;
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(ctX + 4, ctHdrY + 3); ctx.lineTo(ctX + ctW - 4, ctHdrY + 3); ctx.stroke();
  ctx.restore();

  ctx.font = '8px monospace';
  let ctRow = ctHdrY + 14;
  const ctRowH = 12;
  const ctMaxRows = Math.floor((bodyH - 50) / ctRowH);
  curvesList.slice(0, ctMaxRows).forEach((c, rIdx) => {
    if (isBlueprint && rIdx % 2 === 1) {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.5)';
      ctx.fillRect(ctX + 1, ctRow - 9, ctW - 2, ctRowH);
    }
    ctx.fillStyle = keyCol;  ctx.fillText(c.id, ctColX[0], ctRow);
    ctx.fillStyle = textCol;
    ctx.fillText(c.radius    != null ? `${parseFloat(c.radius).toFixed(2)}'`     : '—', ctColX[1], ctRow);
    if (c.assumedZeroLength) {
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 8px monospace';
    }
    ctx.fillText(c.arcLength != null ? `${parseFloat(c.arcLength).toFixed(2)}'*`  : '—', ctColX[2], ctRow);
    if (c.assumedZeroLength) {
      ctx.fillStyle = textCol;
      ctx.font = '8px monospace';
    }
    ctx.fillText(c.chordBearing  || '—', ctColX[3], ctRow);
    if (c.assumedZeroLength) {
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 8px monospace';
    }
    ctx.fillText(c.chordDistance != null ? `${parseFloat(c.chordDistance).toFixed(2)}'*` : '—', ctColX[4], ctRow);
    if (c.assumedZeroLength) {
      ctx.fillStyle = textCol;
      ctx.font = '8px monospace';
    }
    ctRow += ctRowH;
  });
  if (curvesList.length > ctMaxRows) {
    ctx.fillStyle = isBlueprint ? '#94a3b8' : '#888888'; ctx.font = 'italic 7.5px sans-serif';
    ctx.fillText(`+${curvesList.length - ctMaxRows} more…`, ctColX[0], ctRow);
  }
  if (curvesList.length === 0) {
    ctx.fillStyle = isBlueprint ? '#94a3b8' : '#888888'; ctx.font = 'italic 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No Curve Data Available', ctX + ctW / 2, bodyY + bodyH / 2);
  }

  // Footer
  const footerY = bodyY + bodyH + 6;
  const footerH = H - footerY - MARGIN - 2;
  const notesW  = W - MARGIN * 2 - TB_W - 8;
  const notes = [
    `1. Line and curve identifiers match corresponding labels shown on Page 1.`,
    `2. Distances and radii are shown in standard survey feet.`,
  ];
  if (courses?.some(c => c.assumedZeroLength)) {
    notes.push(`3. * Assumed segment length (0-length course replaced with 10.0 feet for sketch consistency).`);
  }
  drawSheetNotes(ctx, MARGIN, footerY, notesW, footerH,
    'DATA TABLE METADATA', notes, 3, 5, isBlueprint);
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 3, 5, isBlueprint);

  return canvas.toBuffer('image/png');
}

function renderPage4(legalDescription, meta, isBlueprint = false) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx, isBlueprint);

  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = isBlueprint ? '#111e36' : C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('METES & BOUNDS LEGAL DESCRIPTION — PAGE 4 OF 5', MARGIN + 8, titleY + titleBarH / 2);
  if (isBlueprint) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(MARGIN, titleY + titleBarH); ctx.lineTo(W - MARGIN, titleY + titleBarH); ctx.stroke();
  }

  const bodyY = titleY + titleBarH + 4;
  const bodyH = H - bodyY - FOOTER_H - 8;

  drawLegalDescBox(ctx, MARGIN, bodyY, W - MARGIN * 2, bodyH, legalDescription, 'CORRECTED RECORD DESCRIPTION', isBlueprint);

  const footerY = bodyY + bodyH + 6;
  const footerH = H - footerY - MARGIN - 2;
  const notesW  = W - MARGIN * 2 - TB_W - 8;
  drawSheetNotes(ctx, MARGIN, footerY, notesW, footerH,
    'SHEET NOTES & CERTIFICATION', [
      '1. This legal description represents a mathematical compilation of recorded deed and plat data.',
      '2. All coordinate geometry (COGO) calculations computed using standard traverse adjustments.',
    ], 4, 5, isBlueprint);
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 4, 5, isBlueprint);

  return canvas.toBuffer('image/png');
}

function renderPage5(originalCourses, meta, isBlueprint = false) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx, isBlueprint);

  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = isBlueprint ? '#111e36' : C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('ORIGINAL DEED — UNCORRECTED BOUNDARY SKETCH — PAGE 5 OF 5', MARGIN + 8, titleY + titleBarH / 2);
  if (isBlueprint) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(MARGIN, titleY + titleBarH); ctx.lineTo(W - MARGIN, titleY + titleBarH); ctx.stroke();
  }

  const mapY = titleY + titleBarH + 4;
  const mapH = H - mapY - FOOTER_H - 8;
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN, mapY, W - MARGIN * 2, mapH);

  if (originalCourses?.length >= 2) {
    const origPts = computePointsFromCourses(originalCourses);
    if (origPts.length >= 2) {
      drawBoundaryGeometry(ctx, origPts, [], originalCourses,
        { x: MARGIN, y: mapY, w: W - MARGIN * 2, h: mapH },
        { showRaw: false, showAdj: true, showGrid: true, showLabels: false, uncorrected: true, isBlueprint, isOpenEnded: meta.isOpenEnded || false }, meta);
    }
  } else {
    ctx.fillStyle = isBlueprint ? '#94a3b8' : '#888888'; ctx.font = 'italic 14px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Original geometry not available', W / 2, mapY + mapH / 2);
  }

  const footerY = mapY + mapH + 6;
  const footerH = H - footerY - MARGIN - 2;
  const notesW  = W - MARGIN * 2 - TB_W - 8;
  drawSheetNotes(ctx, MARGIN, footerY, notesW, footerH,
    'ORIGINAL SKETCH NOTES', [
      '1. This sketch represents the original boundary geometry as extracted from the deed prior to any AI-assisted corrections.',
      '2. Dashed lines indicate uncorrected traverse — compare with the corrected solid-line sketch on Page 1.',
      '3. Closure errors and self-intersections (bow-ties) may be present in this original geometry.',
    ], 5, 5, isBlueprint);
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 5, 5, isBlueprint);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: recompute raw points from courses (mirrors PrintBlueprint logic)
// ─────────────────────────────────────────────────────────────────────────────
function computePointsFromCourses(courses, pob = { northing: 5000, easting: 5000 }) {
  const pts = [{ northing: pob.northing, easting: pob.easting }];
  let curN = pob.northing, curE = pob.easting;
  for (const c of courses) {
    const bearingStr = (c.bearing || c.chordBearing || '').toUpperCase();
    const dist = parseFloat(c.distance ?? c.chordDistance ?? c.arcLength ?? 0);
    if (dist <= 0) continue;
    const match = bearingStr.match(/([NS])\s*(\d+(?:\.\d+)?)(?:\D+(\d+(?:\.\d+)?))?(?:\D+(\d+(?:\.\d+)?))?[^EW]*([EW])/i);
    if (!match) continue;
    const ns  = match[1], ew = match[5];
    const deg = parseFloat(match[2]);
    const min = parseFloat(match[3] || 0);
    const sec = parseFloat(match[4] || 0);
    const dd  = deg + min / 60 + sec / 3600;
    let az = 0;
    if (ns === 'N' && ew === 'E') az = dd;
    else if (ns === 'S' && ew === 'E') az = 180 - dd;
    else if (ns === 'S' && ew === 'W') az = 180 + dd;
    else if (ns === 'N' && ew === 'W') az = 360 - dd;
    const rad = (az * Math.PI) / 180;
    curN += dist * Math.cos(rad);
    curE += dist * Math.sin(rad);
    pts.push({ northing: curN, easting: curE });
  }
  return pts;
}

/**
 * Render all 5 boundary sketch pages as PNG Buffers.
 *
 * @param {object[]} stations            Traverse stations [{northing, easting}]
 * @param {object[]} adjusted            Bowditch-adjusted stations
 * @param {object[]} courses             Course objects (corrected)
 * @param {object}   meta                { parcel, county, state, units, areaAcres, perimeter,
 *                                         basisOfBearings, status }
 * @param {object}   [closure]           Closure/mapcheck stats { precisionRatio, linearError,
 *                                         errorNorthing, errorEasting, status }
 * @param {string}   [legalDescription]  Corrected metes & bounds text
 * @param {string}   [originalLegalDesc] Pre-repair legal description text
 * @param {object[]} [originalCourses]   Original (pre-repair) course objects
 * @param {boolean}  [showConceptualDetail] Draw custom site details
 * @param {boolean}  [blueprintTheme]    Force blueprint dark mode theme
 * @returns {{ page1, page2, page3, page4, page5 }}  Each value is a PNG Buffer
 */
export function renderSketchPages(stations, adjusted, courses, meta = {},
  closure, legalDescription, originalLegalDesc, originalCourses, showConceptualDetail = false, blueprintTheme = false) {
  const isBlueprint = blueprintTheme || meta.blueprintTheme || meta.theme === 'blueprint' || process.env.BLUEPRINT_THEME === 'true';

  if (meta) {
    meta.legalDescription = legalDescription || originalLegalDesc || '';
  }
  return {
    page1: renderPage1(stations, adjusted, courses, meta, closure, showConceptualDetail, isBlueprint),
    page2: renderPage2(originalLegalDesc || legalDescription || null, meta, isBlueprint),
    page3: renderPage3(courses, meta, isBlueprint),
    page4: renderPage4(legalDescription || null, meta, isBlueprint),
    page5: renderPage5(originalCourses || courses, meta, isBlueprint),
  };
}

/**
 * Backwards-compatible single-canvas render (kept for any callers that still
 * use renderSketchPng — now returns Page 1 only).
 */
export function renderSketchPng(stations, adjusted, courses, meta = {}) {
  return renderPage1(stations, adjusted, courses, meta, null);
}

export function renderConceptualPages(conceptualAnalysis, legalDesc, meta = {}, blueprintTheme = false) {
  const isBlueprint = blueprintTheme || meta.blueprintTheme || meta.theme === 'blueprint' || process.env.BLUEPRINT_THEME === 'true';
  return {
    page1: renderConceptualPage1(conceptualAnalysis, legalDesc, meta, isBlueprint),
    page2: renderConceptualPage2(legalDesc, meta, isBlueprint),
    page3: renderConceptualPage3(conceptualAnalysis, meta, isBlueprint),
  };
}

function renderConceptualPage1(conceptualAnalysis, legalDesc = '', meta = {}, isBlueprint = false) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx, isBlueprint);

  // Section title
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HEADER;
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('CONCEPTUAL PLAT SKETCH MAP', PAD, PAD + 10);

  // Map box
  const mapX = PAD;
  const mapY = PAD + 25;
  const mapW = W - PAD * 2;
  const mapH = H - FOOTER_H - PAD - 35;

  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mapX, mapY, mapW, mapH);

  // Grid background
  ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.08)' : 'rgba(0,0,0,0.035)';
  ctx.lineWidth = 0.5;
  const gridStep = 60;
  for (let gx = mapX + gridStep; gx < mapX + mapW; gx += gridStep) {
    ctx.beginPath(); ctx.moveTo(gx, mapY); ctx.lineTo(gx, mapY + mapH); ctx.stroke();
  }
  for (let gy = mapY + gridStep; gy < mapY + mapH; gy += gridStep) {
    ctx.beginPath(); ctx.moveTo(mapX, gy); ctx.lineTo(mapX + mapW, gy); ctx.stroke();
  }

  // Parse lot and block numbers
  const lotMatch = legalDesc.toUpperCase().match(/LOT\s*(\d+[A-Z]?|\d+)/i) || 
                   (conceptualAnalysis.Description || '').toUpperCase().match(/LOT\s*(\d+[A-Z]?|\d+)/i);
  const blockMatch = legalDesc.toUpperCase().match(/BLOCK\s*(\d+[A-Z]?|\d+)/i) ||
                     (conceptualAnalysis.Description || '').toUpperCase().match(/BLOCK\s*(\d+[A-Z]?|\d+)/i);
  const lotNum = lotMatch ? lotMatch[1] : "107";
  const blockNum = blockMatch ? blockMatch[1] : "A";

  const subMatch = legalDesc.match(/(?:subdivision|plat|replat)\s+of\s+([A-Za-z0-9\s]+?)(?:,|\.|\b)/i) || 
                   legalDesc.match(/([A-Za-z0-9\s]+?)\s+subdivision/i) ||
                   (conceptualAnalysis.Description || '').match(/(?:subdivision|plat|replat)\s+of\s+([A-Za-z0-9\s]+?)(?:,|\.|\b)/i);
  const subName = subMatch ? subMatch[1].trim().toUpperCase() : "RECORDED PLAT SUBDIVISION";

  // North Arrow
  const arrowX = mapX + mapW - 60;
  const arrowY = mapY + 60;
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(arrowX, arrowY, 16, 0, Math.PI * 2);
  ctx.stroke();
  
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY - 20);
  ctx.lineTo(arrowX - 5, arrowY - 5);
  ctx.lineTo(arrowX + 5, arrowY - 5);
  ctx.closePath();
  ctx.fillStyle = isBlueprint ? '#00f3ff' : C_BLACK;
  ctx.fill();
  
  ctx.font = 'bold 10px sans-serif';
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.textAlign = 'center';
  ctx.fillText('N', arrowX, arrowY - 24);

  // Title block on map
  ctx.textAlign = 'left';
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HEADER;
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('CONCEPTUAL PLAT SKETCH MAP', mapX + 30, mapY + 40);
  ctx.font = '600 9px sans-serif';
  ctx.fillStyle = isBlueprint ? '#94a3b8' : C_LABEL;
  ctx.fillText(`SUBDIVISION: ${subName}`, mapX + 30, mapY + 55);
  ctx.fillText(`BLOCK: ${blockNum}`, mapX + 30, mapY + 68);

  // Roadway along bottom of map box
  const roadY = mapY + mapH - 120;
  const roadH = 50;
  ctx.strokeStyle = isBlueprint ? '#1e293b' : '#334155';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(mapX, roadY); ctx.lineTo(mapX + mapW, roadY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(mapX, roadY + roadH); ctx.lineTo(mapX + mapW, roadY + roadH); ctx.stroke();
  
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : '#64748b';
  ctx.lineWidth = 1.0;
  ctx.setLineDash([8, 8]);
  ctx.beginPath(); ctx.moveTo(mapX, roadY + roadH / 2); ctx.lineTo(mapX + mapW, roadY + roadH / 2); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = isBlueprint ? '#94a3b8' : '#334155';
  ctx.font = 'italic bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PLATTED ROADWAY (PUBLIC RIGHT-OF-WAY)', mapX + mapW / 2, roadY + roadH / 2 + 3);

  // Lots grid inside block
  const blockX = mapX + 80;
  const blockWidth = mapW - 160;
  const blockY = mapY + 110;
  const blockHeight = roadY - blockY - 10;

  ctx.strokeStyle = isBlueprint ? '#38bdf8' : '#94a3b8';
  ctx.lineWidth = 1.0;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(blockX, blockY, blockWidth, blockHeight);
  ctx.setLineDash([]);
  ctx.fillStyle = isBlueprint ? '#38bdf8' : '#94a3b8';
  ctx.font = 'italic bold 9px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`BLOCK ${blockNum} BOUNDARY`, blockX + 20, blockY + 14);

  // 5 Lots inside block
  const numLots = 5;
  const lotW = blockWidth / numLots;
  const startLotVal = isNaN(parseInt(lotNum)) ? 105 : parseInt(lotNum) - 2;

  for (let i = 0; i < numLots; i++) {
    const lx = blockX + i * lotW;
    const ly = blockY + 30;
    const lh = blockHeight - 30;

    const currentLotLabel = isNaN(parseInt(lotNum))
      ? (i === 2 ? lotNum : `LOT ${105 + i}`)
      : `LOT ${startLotVal + i}`;

    const isSubject = (i === 2);

    if (isSubject) {
      // Highlight subject lot
      ctx.fillStyle = isBlueprint ? 'rgba(0, 243, 255, 0.08)' : 'rgba(14, 165, 233, 0.08)';
      ctx.fillRect(lx, ly, lotW, lh);
      
      ctx.strokeStyle = isBlueprint ? '#00f3ff' : '#0284c7';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(lx, ly, lotW, lh);

      // Hatch pattern
      ctx.strokeStyle = isBlueprint ? 'rgba(0, 243, 255, 0.15)' : 'rgba(14, 165, 233, 0.15)';
      ctx.lineWidth = 1.0;
      for (let offset = 10; offset < lotW + lh; offset += 15) {
        ctx.beginPath();
        ctx.moveTo(lx + Math.max(0, offset - lh), ly + Math.min(lh, offset));
        ctx.lineTo(lx + Math.min(lotW, offset), ly + Math.max(0, offset - lotW));
        ctx.stroke();
      }

      ctx.fillStyle = isBlueprint ? '#00f3ff' : '#0284c7';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(currentLotLabel, lx + lotW / 2, ly + lh / 2 - 8);
      ctx.font = 'bold 8px sans-serif';
      ctx.fillText('(SUBJECT PROPERTY)', lx + lotW / 2, ly + lh / 2 + 4);
      
      ctx.font = '500 7.5px sans-serif';
      ctx.fillStyle = isBlueprint ? '#94a3b8' : '#64748b';
      ctx.fillText("60.00'", lx + lotW / 2, ly + 14);
      ctx.fillText("110.00'", lx + lotW / 2, ly + lh - 10);
      
      ctx.save();
      ctx.translate(lx + 10, ly + lh / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("110.00' (TYP)", 0, 0);
      ctx.restore();
    } else {
      ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.4)' : '#cbd5e1';
      ctx.lineWidth = 1.0;
      ctx.strokeRect(lx, ly, lotW, lh);

      ctx.fillStyle = isBlueprint ? '#94a3b8' : '#94a3b8';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(currentLotLabel, lx + lotW / 2, ly + lh / 2);
    }
  }

  // Rear drainage easement
  ctx.strokeStyle = isBlueprint ? '#fb7185' : '#ef4444';
  ctx.lineWidth = 1.0;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(blockX, blockY + 50);
  ctx.lineTo(blockX + blockWidth, blockY + 50);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = isBlueprint ? '#fb7185' : '#ef4444';
  ctx.font = 'italic 7.5px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText("15' REAR DRAINAGE & UTILITY EASEMENT", blockX + 15, blockY + 45);

  // Disclaimer stamp at bottom of map
  const stampW = 420;
  const stampH = 30;
  const stampX = mapX + (mapW - stampW) / 2;
  const stampY = mapY + mapH - 45;
  ctx.strokeStyle = isBlueprint ? 'rgba(56, 189, 248, 0.4)' : 'rgba(196, 78, 0, 0.4)';
  ctx.fillStyle = isBlueprint ? 'rgba(56, 189, 248, 0.04)' : 'rgba(196, 78, 0, 0.04)';
  ctx.lineWidth = 1.0;
  ctx.strokeRect(stampX, stampY, stampW, stampH);
  ctx.fillRect(stampX, stampY, stampW, stampH);

  ctx.fillStyle = isBlueprint ? '#38bdf8' : '#c44e00';
  ctx.font = 'bold 8.5px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('CONCEPTUAL DIAGRAM — FOR ILLUSTRATIVE PURPOSES ONLY', mapX + mapW / 2, stampY + 12);
  ctx.font = '500 7px sans-serif';
  ctx.fillText('NOT A FIELD SURVEY. PROPERTY BOUNDARIES AND RELATIVE SIZES ARE RECORD ESTIMATES.', mapX + mapW / 2, stampY + 22);

  // Draw Footer notes and Title block
  const footerY = H - FOOTER_H - MARGIN;
  const footerW = W - MARGIN * 2;
  const tbWidth = TB_W;
  const noteW = footerW - tbWidth - 12;

  // Notes Box
  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN, footerY, noteW, FOOTER_H);
  drawPanelHeader(ctx, MARGIN, footerY, noteW, HDR_H, 'CONCEPTUAL ANALYSIS SUMMARY', isBlueprint);

  // Notes Box content
  let curY = footerY + HDR_H + 18;

  // Parent Tract Estimate
  ctx.fillStyle = isBlueprint ? '#ffffff' : C_BLACK;
  ctx.font = 'bold 8.5px sans-serif';
  const parentLabel = 'Parent Tract Estimate: ';
  ctx.fillText(parentLabel, MARGIN + 12, curY);
  const parentLabelW = ctx.measureText(parentLabel).width;
  ctx.font = '8.5px sans-serif';
  const parentVal = conceptualAnalysis.ParentTractSizeEstimate || conceptualAnalysis.parentTractSizeEstimate || 'unknown';
  curY = drawWrappedText(ctx, parentVal, MARGIN + 12 + parentLabelW, curY, noteW - 24 - parentLabelW, 12);
  curY += 2;

  // Standard Lot Size
  ctx.font = 'bold 8.5px sans-serif';
  ctx.fillStyle = isBlueprint ? '#ffffff' : C_BLACK;
  const lotLabel = 'Standard Lot Size: ';
  ctx.fillText(lotLabel, MARGIN + 12, curY);
  const lotLabelW = ctx.measureText(lotLabel).width;
  ctx.font = '8.5px sans-serif';
  const lotVal = conceptualAnalysis.LotSizeEstimate || conceptualAnalysis.lotSizeEstimate || '0.15 acres';
  curY = drawWrappedText(ctx, lotVal, MARGIN + 12 + lotLabelW, curY, noteW - 24 - lotLabelW, 12);
  curY += 4;
  
  // Relative Comparison
  ctx.font = 'italic 8.5px sans-serif';
  ctx.fillStyle = isBlueprint ? '#94a3b8' : '#444444';
  const relComp = conceptualAnalysis.RelativeComparison || conceptualAnalysis.relativeComparison || '';
  drawWrappedText(ctx, relComp, MARGIN + 12, curY, noteW - 24, 13);

  // Title Block
  drawTitleBlock(ctx, MARGIN + noteW + 12, footerY, tbWidth, FOOTER_H, meta, 1, 3, isBlueprint);

  return canvas.toBuffer('image/png');
}

function renderConceptualPage2(legalDesc, meta = {}, isBlueprint = false) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx, isBlueprint);

  // Section title
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HEADER;
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('METES & BOUNDS LEGAL DESCRIPTION', PAD, PAD + 10);

  // Description box
  const descX = PAD;
  const descY = PAD + 25;
  const descW = W - PAD * 2;
  const descH = H - FOOTER_H - PAD - 35;

  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(descX, descY, descW, descH);
  drawPanelHeader(ctx, descX, descY, descW, HDR_H, 'RECORD DESCRIPTION', isBlueprint);

  ctx.fillStyle = isBlueprint ? '#f1f5f9' : C_BLACK;
  ctx.font = '11px serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  
  const textX = descX + 24;
  const textY = descY + HDR_H + 24;
  const maxTextW = descW - 48;
  const lineH = 18;

  if (legalDesc) {
    drawWrappedText(ctx, legalDesc, textX, textY, maxTextW, lineH);
  } else {
    ctx.font = 'italic 10px sans-serif';
    ctx.fillStyle = isBlueprint ? '#94a3b8' : '#666666';
    ctx.fillText('[No legal description provided.]', textX, textY);
  }

  // Footer notes and Title block
  const footerY = H - FOOTER_H - MARGIN;
  const footerW = W - MARGIN * 2;
  const tbWidth = TB_W;
  const noteW = footerW - tbWidth - 12;

  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN, footerY, noteW, FOOTER_H);
  drawPanelHeader(ctx, MARGIN, footerY, noteW, HDR_H, 'SHEET NOTES & CERTIFICATION', isBlueprint);

  ctx.fillStyle = isBlueprint ? '#ffffff' : C_BLACK;
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('1. This legal description represents a mathematical compilation of recorded deed and plat data.', MARGIN + 12, footerY + HDR_H + 25);
  ctx.fillText('2. No mathematical boundary traverse could be computed due to reference to recorded plat.', MARGIN + 12, footerY + HDR_H + 40);

  ctx.font = 'bold 8px sans-serif';
  ctx.fillText('SHEET IDENTIFIER: RECORD LEGAL DESCRIPTION', MARGIN + 12, footerY + FOOTER_H - 18);

  // Title Block
  drawTitleBlock(ctx, MARGIN + noteW + 12, footerY, tbWidth, FOOTER_H, meta, 2, 3, isBlueprint);

  return canvas.toBuffer('image/png');
}

function renderConceptualPage3(conceptualAnalysis, meta = {}, isBlueprint = false) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx, isBlueprint);

  // Section title
  ctx.fillStyle = isBlueprint ? '#38bdf8' : C_HEADER;
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('CONCEPTUAL LOT & BLOCK ANALYSIS', PAD, PAD + 10);

  // Description box
  const descX = PAD;
  const descY = PAD + 25;
  const descW = W - PAD * 2;
  const descH = H - FOOTER_H - PAD - 35;

  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(descX, descY, descW, descH);
  drawPanelHeader(ctx, descX, descY, descW, HDR_H, 'LOT & BLOCK ASSUMPTIONS & COMPARATIVE ANALYSIS', isBlueprint);

  let curY = descY + HDR_H + 20;

  // Title 1: Deed Summary
  ctx.fillStyle = isBlueprint ? '#38bdf8' : '#1a365d';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('DEED SUMMARY & INTERPRETATION', descX + 20, curY);
  curY += 16;
  ctx.fillStyle = isBlueprint ? '#f1f5f9' : C_BLACK;
  ctx.font = '9.5px sans-serif';
  curY = drawWrappedText(ctx, conceptualAnalysis.Description || conceptualAnalysis.description || '', descX + 20, curY, descW - 40, 14);
  curY += 12;

  // Title 2: General Assumptions
  ctx.fillStyle = isBlueprint ? '#38bdf8' : '#1a365d';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('1. GENERAL ASSUMPTIONS FOR LOT & BLOCK SIZES', descX + 20, curY);
  curY += 16;
  ctx.fillStyle = isBlueprint ? '#f1f5f9' : C_BLACK;
  ctx.font = '9.5px sans-serif';
  ctx.fillText('When a deed refers to a subdivision Plat, surveyors and database systems use the following size assumptions:', descX + 20, curY);
  curY += 14;
  ctx.font = '9px sans-serif';
  ctx.fillText('• Subdivision Lots (Residential): Standard residential lots typically range between 0.10 to 0.25 acres. Standard: 0.15 acres.', descX + 25, curY);
  curY += 13;
  ctx.fillText('• Subdivision Tracts / Blocks (Commercial): Tracts inside replats typically range from 1.0 to 5.0+ acres.', descX + 25, curY);
  curY += 13;
  ctx.fillText('• Government Lots: Fractional sections along boundaries or water bodies typically range from 10 to 50 acres.', descX + 25, curY);
  curY += 18;

  // Title 3: Specific Breakdown
  ctx.fillStyle = isBlueprint ? '#38bdf8' : '#1a365d';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('2. SPECIFIC SIZE ESTIMATES & RELATIVE COMPARISON', descX + 20, curY);
  curY += 16;
  
  // Parent Tract size estimate
  ctx.fillStyle = isBlueprint ? '#ffffff' : C_BLACK;
  ctx.font = 'bold 9.5px sans-serif';
  const parentLabel = 'Parent Tract size estimate: ';
  ctx.fillText(parentLabel, descX + 20, curY);
  const parentLabelW = ctx.measureText(parentLabel).width;
  ctx.font = '9.5px sans-serif';
  const parentVal = conceptualAnalysis.ParentTractSizeEstimate || conceptualAnalysis.parentTractSizeEstimate || 'unknown';
  curY = drawWrappedText(ctx, parentVal, descX + 20 + parentLabelW, curY, descW - 40 - parentLabelW, 13);
  curY += 2;

  // Standard Lot size estimate
  ctx.font = 'bold 9.5px sans-serif';
  ctx.fillStyle = isBlueprint ? '#ffffff' : C_BLACK;
  const lotLabel = 'Standard Lot size estimate: ';
  ctx.fillText(lotLabel, descX + 20, curY);
  const lotLabelW = ctx.measureText(lotLabel).width;
  ctx.font = '9.5px sans-serif';
  const lotVal = conceptualAnalysis.LotSizeEstimate || conceptualAnalysis.lotSizeEstimate || '0.15 acres';
  curY = drawWrappedText(ctx, lotVal, descX + 20 + lotLabelW, curY, descW - 40 - lotLabelW, 13);
  curY += 4;

  // Relative comparison
  ctx.font = 'italic 9.5px sans-serif';
  ctx.fillStyle = isBlueprint ? '#94a3b8' : '#444444';
  const relComp = conceptualAnalysis.RelativeComparison || conceptualAnalysis.relativeComparison || '';
  drawWrappedText(ctx, relComp, descX + 20, curY, descW - 40, 14);

  // Footer notes and Title block
  const footerY = H - FOOTER_H - MARGIN;
  const footerW = W - MARGIN * 2;
  const tbWidth = TB_W;
  const noteW = footerW - tbWidth - 12;

  ctx.strokeStyle = isBlueprint ? '#38bdf8' : C_BLACK;
  ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN, footerY, noteW, FOOTER_H);
  drawPanelHeader(ctx, MARGIN, footerY, noteW, HDR_H, 'CONCEPTUAL SHEET NOTES', isBlueprint);

  ctx.fillStyle = isBlueprint ? '#ffffff' : C_BLACK;
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('1. This analysis provides a conceptual representation based on standard lot, block, and tract guidelines.', MARGIN + 12, footerY + HDR_H + 25);
  ctx.fillText('2. True dimensions and boundaries require a professional land survey of the referenced plat map.', MARGIN + 12, footerY + HDR_H + 40);

  ctx.font = 'bold 8px sans-serif';
  ctx.fillText('SHEET IDENTIFIER: CONCEPTUAL ANALYSIS', MARGIN + 12, footerY + FOOTER_H - 18);

  // Title Block
  drawTitleBlock(ctx, MARGIN + noteW + 12, footerY, tbWidth, FOOTER_H, meta, 3, 3, isBlueprint);

  return canvas.toBuffer('image/png');
}
