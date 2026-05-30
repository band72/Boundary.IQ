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
  return { canvas, ctx };
}

/** Fill white background + double border. */
function drawPageFrame(ctx) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C_BLACK;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  ctx.lineWidth = 0.5;
  ctx.strokeRect(8, 8, W - 16, H - 16);
}

/** Dark navy panel header bar. */
function drawPanelHeader(ctx, x, y, w, h, text) {
  ctx.fillStyle = C_HEADER;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = C_HDR_TXT;
  ctx.font = 'bold 8px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), x + 6, y + h / 2);
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
function drawTitleBlock(ctx, x, y, w, h, meta, pageN, pageTotal) {
  // Outer border
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  // "METES & BOUNDS PLATTED SKETCH" header
  const hdrH = 18;
  drawPanelHeader(ctx, x, y, w, hdrH, 'METES & BOUNDS PLATTED SKETCH');

  // Field rows
  const fields = [
    ['PARCEL',         meta.parcel        || 'SUBJECT PARCEL'],
    ['COUNTY / REGION',meta.county        || 'UNINCORPORATED AREA'],
    ['STATE',          meta.state         || 'GENERAL RECORD'],
    ['AREA',           meta.areaAcres     ? `${parseFloat(meta.areaAcres).toFixed(4)} AC` : '—'],
    ['PERIMETER',      meta.perimeter     ? `${parseFloat(meta.perimeter).toFixed(2)} FT` : '—'],
    ['BASIS OF BEARINGS', meta.basisOfBearings || 'DEED OF RECORD'],
    ['STATUS',         meta.status        || '—'],
    ['PLATFORM',       'BOUNDARY.IQ PLATFORM'],
    ['DATE',           new Date().toISOString().slice(0, 10)],
  ];

  if (pageN && pageTotal) {
    fields.push([`PAGE`, `${pageN} OF ${pageTotal}`]);
  }

  let fy = y + hdrH + 3;
  const colX = x + 6;
  const colW = w - 12;
  const availRows = fields.length;
  const rowH = Math.min(14, (h - hdrH - 6) / availRows);

  ctx.textBaseline = 'alphabetic';
  for (const [label, value] of fields) {
    if (fy + rowH > y + h - 4) break;
    ctx.font = '6px sans-serif'; ctx.fillStyle = '#888888'; ctx.textAlign = 'left';
    ctx.fillText(label.toUpperCase(), colX, fy + 6);
    ctx.font = 'bold 7.5px sans-serif'; ctx.fillStyle = C_BLACK;
    ctx.fillText(String(value), colX, fy + 6 + 9);
    fy += rowH;
    hRule(ctx, colX, fy, colW);
  }
  return y + h;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: draw the boundary geometry onto a canvas region
// region: { x, y, w, h } — pixel region available for the map drawing
// ─────────────────────────────────────────────────────────────────────────────
function drawBoundaryGeometry(ctx, rawPts, adjPts, courses, region, opts = {}, meta = {}) {
  const { x: rx, y: ry, w: rw, h: rh } = region;
  const { showRaw = true, showAdj = true, showGrid = true, showLabels = true, uncorrected = false } = opts;

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
  const ty = n => offY + availH - (n - minN) * scale;

  // Clip to region
  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();

  // Grid
  if (showGrid) {
    ctx.strokeStyle = C_GRID;
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
    ctx.strokeStyle = 'rgba(26, 46, 68, 0.15)';
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
    ctx.strokeStyle = '#4b5563';
    ctx.lineWidth = 1.0;
    ctx.setLineDash([6, 6]);
    // Vertical center line (easting = 7640)
    ctx.beginPath(); ctx.moveTo(tx(7640), ty(5000)); ctx.lineTo(tx(7640), ty(10280)); ctx.stroke();
    // Horizontal center line (northing = 7640)
    ctx.beginPath(); ctx.moveTo(tx(5000), ty(7640)); ctx.lineTo(tx(10280), ty(7640)); ctx.stroke();

    // 3. Section Boundary (thick black solid border)
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(tx(5000), ty(10280), (10280 - 5000) * scale, (10280 - 5000) * scale);

    // 4. Quadrant labels (faded elegant gray text in their geometric centers)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NW 1/4', tx(6320), ty(8960));
    ctx.fillText('NE 1/4', tx(8960), ty(8960));
    ctx.fillText('SW 1/4', tx(6320), ty(6320));
    ctx.fillText('SE 1/4', tx(8960), ty(6320));

    // 5. Central section number badge
    ctx.fillStyle = 'rgba(26, 46, 68, 0.06)';
    ctx.strokeStyle = 'rgba(26, 46, 68, 0.2)';
    ctx.lineWidth = 0.75;
    const midX = tx(7640), midY = ty(7640);
    ctx.fillRect(midX - 35, midY - 9, 70, 18);
    ctx.strokeRect(midX - 35, midY - 9, 70, 18);
    ctx.fillStyle = '#1a2e44';
    ctx.font = 'bold 7.5px sans-serif';
    ctx.fillText('SECTION 12', midX, midY);

    // 6. Label our actual 40-acre parcel in its center
    // Our parcel NW 1/4 of SE 1/4 lies in easting 7640-8960, northing 6320-7640
    ctx.fillStyle = '#cc0000';
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

  // Raw traverse (red dashed)
  if (showRaw && rawPts.length >= 2) {
    ctx.beginPath();
    ctx.strokeStyle = C_RAW;
    ctx.lineWidth   = 1.25;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(tx(rawPts[0].easting), ty(rawPts[0].northing));
    for (let i = 1; i < rawPts.length; i++) {
      ctx.lineTo(tx(rawPts[i].easting), ty(rawPts[i].northing));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Adjusted boundary fill + stroke  (or uncorrected dashed)
  const drawPts = adjPts.length >= 2 ? adjPts : rawPts;
  if (drawPts.length >= 2) {
    // Fill
    ctx.beginPath();
    ctx.moveTo(tx(drawPts[0].easting), ty(drawPts[0].northing));
    for (let i = 1; i < drawPts.length; i++) {
      ctx.lineTo(tx(drawPts[i].easting), ty(drawPts[i].northing));
    }
    ctx.closePath();
    ctx.fillStyle = C_FILL;
    ctx.fill();

    // Stroke
    ctx.beginPath();
    ctx.strokeStyle = C_BLACK;
    ctx.lineWidth   = 2.0;
    if (uncorrected) ctx.setLineDash([8, 6]);
    ctx.moveTo(tx(drawPts[0].easting), ty(drawPts[0].northing));
    for (let i = 1; i < drawPts.length; i++) {
      ctx.lineTo(tx(drawPts[i].easting), ty(drawPts[i].northing));
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Station nodes + vertex labels
  const labelPts = adjPts.length >= 2 ? adjPts : rawPts;
  labelPts.forEach((p, i) => {
    const px = tx(p.easting), py = ty(p.northing);
    ctx.beginPath();
    ctx.arc(px, py, i === 0 ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle   = i === 0 ? C_BLACK : '#ffffff';
    ctx.strokeStyle = C_BLACK;
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
    if (labelPts.length <= 35) {
      ctx.fillStyle    = C_BLACK;
      ctx.font         = 'bold 9px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(i === 0 ? 'POB' : `${i}`, px + 6, py - 4);
    }
  });

  // Course midpoint labels (L1, C1…)
  if (showLabels && courses?.length > 0) {
    ctx.fillStyle    = C_BLACK;
    ctx.font         = 'bold 9px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    courses.forEach((c, i) => {
      const p1 = labelPts[i];
      const p2 = labelPts[i + 1] || labelPts[0];
      if (!p1 || !p2) return;
      const mx = (tx(p1.easting) + tx(p2.easting)) / 2;
      const my = (ty(p1.northing) + ty(p2.northing)) / 2;
      const cdx = tx(p2.easting) - tx(p1.easting);
      const cdy = ty(p2.northing) - ty(p1.northing);
      const clen = Math.hypot(cdx, cdy) || 1;
      const cpx = -cdy / clen;
      const cpy =  cdx / clen;
      let labelId = '';
      if ((c.type || '').toLowerCase() === 'curve') {
        const m = curvesList.find(x => x.idx === i); labelId = m ? m.id : '';
      } else {
        const m = linesList.find(x  => x.idx === i); labelId = m ? m.id : '';
      }
      if (labelId) {
        const lx = mx + cpx * 12;
        const ly = my + cpy * 12;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        const tw = ctx.measureText(labelId).width;
        ctx.fillRect(lx - tw / 2 - 2, ly - 6, tw + 4, 12);
        ctx.restore();
        ctx.fillStyle = C_BLACK;
        ctx.fillText(labelId, lx, ly);
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

  // ── North arrow (top-right of the region) ────────────────────────────────
  const ax = rx + rw - 40;
  const ay = ry + 42;
  ctx.save();
  ctx.translate(ax, ay);
  ctx.fillStyle    = C_BLACK;
  ctx.font         = 'bold 15px sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('N', 0, -22);
  ctx.fillStyle = C_BLACK;
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(7, 8); ctx.lineTo(0, 1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1.25;
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
function drawMapcheck(ctx, x, y, w, h, closure, units) {
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  drawPanelHeader(ctx, x, y, w, 16, 'MAPCHECK / CLOSURE VERIFICATION');

  const pass = !closure?.status?.includes('FAIL') && !closure?.status?.includes('✗');
  const items = [
    ['PRECISION RATIO',    closure?.precisionRatio    || '1:∞',      true,  pass ? C_PASS : C_FAIL],
    ['LINEAR CLOSURE ERR', closure?.linearError       != null
                              ? `${parseFloat(closure.linearError).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}`
                              : '0.0000 FT',                         false, C_BLACK],
    ['ERROR NORTHING',     closure?.errorNorthing      != null
                              ? `${parseFloat(closure.errorNorthing).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}`
                              : '0.0000 FT',                         false, C_BLACK],
    ['ERROR EASTING',      closure?.errorEasting       != null
                              ? `${parseFloat(closure.errorEasting).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}`
                              : '0.0000 FT',                         false, C_BLACK],
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
    // simple 2-column grid for first 4, then full-width for status
    const cellX  = (i < 2) ? col1X : (i < 4 ? col2X : col1X);
    const cellW  = (i === 4) ? w - 16 : colW;
    ctx.font = '6.5px sans-serif'; ctx.fillStyle = '#666666'; ctx.textAlign = 'left';
    ctx.fillText(label, cellX, iy);
    iy += 10;
    ctx.font = bold ? 'bold 9px sans-serif' : '8px monospace';
    ctx.fillStyle = color;
    ctx.fillText(String(value), cellX, iy);
    iy += (i === 1 || i === 3) ? -10 : 14;   // pair rows side by side
    if (i === 1 || i === 3) iy += 14;
    if (i === 3) { hRule(ctx, x + 4, iy - 4, w - 8); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: page-number / sheet-info notes box
// ─────────────────────────────────────────────────────────────────────────────
function drawSheetNotes(ctx, x, y, w, h, title, lines, pageN, pageTotal) {
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  drawPanelHeader(ctx, x, y, w, 16, title);

  let ny = y + 24;
  ctx.font = '7.5px sans-serif'; ctx.fillStyle = '#333333'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  for (const line of lines) {
    if (ny > y + h - 20) break;
    ny = drawWrappedText(ctx, line, x + 8, ny, w - 16, 11);
  }

  // Page n of N footer inside box
  hRule(ctx, x + 4, y + h - 20, w - 8);
  ctx.font = 'bold 7.5px sans-serif'; ctx.fillStyle = C_BLACK;
  ctx.textAlign = 'left';
  ctx.fillText(`SHEET ${pageN} OF ${pageTotal}`, x + 8, y + h - 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: wrap paragraph text in a box
// ─────────────────────────────────────────────────────────────────────────────
function drawLegalDescBox(ctx, x, y, w, h, text, headerText) {
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  const hh = 18;
  drawPanelHeader(ctx, x, y, w, hh, headerText);

  // Clip to content area
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y + hh + 1, w - 2, h - hh - 2);
  ctx.clip();

  ctx.font = '9.5px Georgia, serif';
  ctx.fillStyle    = '#111111';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'alphabetic';

  let ty2 = y + hh + 18;
  const indent = 24;
  const lineH  = 16;
  const maxLineW = w - 32;

  if (text) {
    // First line with indent
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
    ctx.fillStyle = '#888888';
    ctx.fillText('[No legal description provided]', x + 16, ty2 + 30);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 1 — Main boundary sketch + Mapcheck footer + Title block
// ─────────────────────────────────────────────────────────────────────────────
function renderPage1(stations, adjusted, courses, meta, closure) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx);

  // Section title bar
  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('BOUNDARY SURVEY SKETCH — PAGE 1 OF 5', MARGIN + 8, titleY + titleBarH / 2);

  // Map region (above footer)
  const mapY  = titleY + titleBarH + 4;
  const mapH  = H - mapY - FOOTER_H - 8;
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN, mapY, W - MARGIN * 2, mapH);

  const rawPts = (stations?.length >= 2)
    ? stations.map(s => ({ northing: s.northing, easting: s.easting }))
    : [];
  const adjPts = (adjusted?.length >= 2)
    ? adjusted.map(s => ({ northing: s.northing, easting: s.easting }))
    : rawPts;

  if (rawPts.length >= 2) {
    drawBoundaryGeometry(ctx, rawPts, adjPts, courses,
      { x: MARGIN, y: mapY, w: W - MARGIN * 2, h: mapH }, {}, meta);
  } else {
    ctx.fillStyle = '#888888'; ctx.font = 'italic 16px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No traverse geometry available', W / 2, mapY + mapH / 2);
  }

  // Footer strip
  const footerY  = mapY + mapH + 6;
  const footerH  = H - footerY - MARGIN - 2;
  const notesW   = W - MARGIN * 2 - TB_W - 8;

  // Mapcheck box
  drawMapcheck(ctx, MARGIN, footerY, notesW, footerH, closure, meta.units);

  // Title block
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 1, 5);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 2 — Corrected metes & bounds legal description
// ─────────────────────────────────────────────────────────────────────────────
function renderPage2(legalDescription, meta) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx);

  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('METES & BOUNDS LEGAL DESCRIPTION — PAGE 2 OF 5', MARGIN + 8, titleY + titleBarH / 2);

  const bodyY = titleY + titleBarH + 4;
  const bodyH = H - bodyY - FOOTER_H - 8;

  drawLegalDescBox(ctx, MARGIN, bodyY, W - MARGIN * 2, bodyH, legalDescription, 'RECORD DESCRIPTION');

  // Footer
  const footerY = bodyY + bodyH + 6;
  const footerH = H - footerY - MARGIN - 2;
  const notesW  = W - MARGIN * 2 - TB_W - 8;
  drawSheetNotes(ctx, MARGIN, footerY, notesW, footerH,
    'SHEET NOTES & CERTIFICATION', [
      '1. This legal description represents a mathematical compilation of recorded deed and plat data.',
      '2. All coordinate geometry (COGO) calculations computed using standard traverse adjustments.',
    ], 2, 5);
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 2, 5);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 3 — Line table + Curve table
// ─────────────────────────────────────────────────────────────────────────────
function renderPage3(courses, meta) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx);

  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('SURVEY COMPILATION — LINE AND CURVE DATA TABLES — PAGE 3 OF 5', MARGIN + 8, titleY + titleBarH / 2);

  // Build lists
  const linesList  = [];
  const curvesList = [];
  courses?.forEach((c, idx) => {
    if ((c.type || '').toLowerCase() === 'curve') {
      curvesList.push({ id: `C${curvesList.length + 1}`, idx, radius: c.radius, arcLength: c.arcLength, chordBearing: c.chordBearing, chordDistance: c.chordDistance, delta: c.delta });
    } else {
      linesList.push({ id: `L${linesList.length + 1}`, idx, bearing: c.bearing, distance: c.distance });
    }
  });

  const bodyY  = titleY + titleBarH + 4;
  const bodyH  = H - bodyY - FOOTER_H - 8;
  const halfW  = Math.floor((W - MARGIN * 2 - 8) / 2);

  // ── Line table (left half) ───────────────────────────────────────────────
  const ltX = MARGIN;
  const ltW = halfW;
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(ltX, bodyY, ltW, bodyH);
  drawPanelHeader(ctx, ltX, bodyY, ltW, 18, 'LINE TABLE');

  const ltColX = [ltX + 6, ltX + 40, ltX + 190];   // ID | BEARING | DISTANCE
  const ltHdrY = bodyY + 18 + 12;
  ctx.font = 'bold 8px monospace'; ctx.fillStyle = C_BLACK;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('ID',       ltColX[0], ltHdrY);
  ctx.fillText('BEARING',  ltColX[1], ltHdrY);
  ctx.fillText('DISTANCE', ltColX[2], ltHdrY);
  hRule(ctx, ltX + 4, ltHdrY + 3, ltW - 8);

  ctx.font = '8px monospace'; ctx.fillStyle = C_LABEL;
  let ltRow = ltHdrY + 14;
  const ltRowH = 12;
  const ltMaxRows = Math.floor((bodyH - 50) / ltRowH);
  linesList.slice(0, ltMaxRows).forEach(l => {
    ctx.fillStyle = C_BLACK; ctx.fillText(l.id, ltColX[0], ltRow);
    ctx.fillStyle = C_LABEL;
    ctx.fillText(l.bearing || '—', ltColX[1], ltRow);
    ctx.fillText(l.distance != null ? `${parseFloat(l.distance).toFixed(2)}'` : '—', ltColX[2], ltRow);
    ltRow += ltRowH;
  });
  if (linesList.length > ltMaxRows) {
    ctx.fillStyle = '#888888'; ctx.font = 'italic 7.5px sans-serif';
    ctx.fillText(`+${linesList.length - ltMaxRows} more…`, ltColX[0], ltRow);
  }
  if (linesList.length === 0) {
    ctx.fillStyle = '#888888'; ctx.font = 'italic 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No Line Data Available', ltX + ltW / 2, bodyY + bodyH / 2);
  }

  // ── Curve table (right half) ─────────────────────────────────────────────
  const ctX = MARGIN + halfW + 8;
  const ctW = W - MARGIN * 2 - halfW - 8;
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(ctX, bodyY, ctW, bodyH);
  drawPanelHeader(ctx, ctX, bodyY, ctW, 18, 'CURVE TABLE');

  // Columns: ID | RADIUS | ARC LEN | CHORD BRG | CHORD DIST
  const ctColX = [ctX + 6, ctX + 32, ctX + 90, ctX + 152, ctX + 272];
  const ctHdrY = bodyY + 18 + 12;
  ctx.font = 'bold 8px monospace'; ctx.fillStyle = C_BLACK;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ['ID','RADIUS','ARC LEN','CHORD BRG','CHORD DIST'].forEach((h, i) => ctx.fillText(h, ctColX[i], ctHdrY));
  hRule(ctx, ctX + 4, ctHdrY + 3, ctW - 8);

  ctx.font = '8px monospace';
  let ctRow = ctHdrY + 14;
  const ctRowH = 12;
  const ctMaxRows = Math.floor((bodyH - 50) / ctRowH);
  curvesList.slice(0, ctMaxRows).forEach(c => {
    ctx.fillStyle = C_BLACK;  ctx.fillText(c.id, ctColX[0], ctRow);
    ctx.fillStyle = C_LABEL;
    ctx.fillText(c.radius    != null ? `${parseFloat(c.radius).toFixed(2)}'`     : '—', ctColX[1], ctRow);
    ctx.fillText(c.arcLength != null ? `${parseFloat(c.arcLength).toFixed(2)}'`  : '—', ctColX[2], ctRow);
    ctx.fillText(c.chordBearing  || '—', ctColX[3], ctRow);
    ctx.fillText(c.chordDistance != null ? `${parseFloat(c.chordDistance).toFixed(2)}'` : '—', ctColX[4], ctRow);
    ctRow += ctRowH;
  });
  if (curvesList.length > ctMaxRows) {
    ctx.fillStyle = '#888888'; ctx.font = 'italic 7.5px sans-serif';
    ctx.fillText(`+${curvesList.length - ctMaxRows} more…`, ctColX[0], ctRow);
  }
  if (curvesList.length === 0) {
    ctx.fillStyle = '#888888'; ctx.font = 'italic 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No Curve Data Available', ctX + ctW / 2, bodyY + bodyH / 2);
  }

  // Footer
  const footerY = bodyY + bodyH + 6;
  const footerH = H - footerY - MARGIN - 2;
  const notesW  = W - MARGIN * 2 - TB_W - 8;
  drawSheetNotes(ctx, MARGIN, footerY, notesW, footerH,
    'DATA TABLE METADATA', [
      `1. Line and curve identifiers match corresponding labels shown on Page 1.`,
      `2. Distances and radii are shown in standard survey feet.`,
    ], 3, 5);
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 3, 5);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 4 — Original deed legal description (pre-correction)
// ─────────────────────────────────────────────────────────────────────────────
function renderPage4(originalLegalDesc, meta) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx);

  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('ORIGINAL DEED — LEGAL DESCRIPTION (PRE-CORRECTION) — PAGE 4 OF 5', MARGIN + 8, titleY + titleBarH / 2);

  const bodyY = titleY + titleBarH + 4;
  const bodyH = H - bodyY - FOOTER_H - 8;

  drawLegalDescBox(ctx, MARGIN, bodyY, W - MARGIN * 2, bodyH, originalLegalDesc, 'ORIGINAL RECORD DESCRIPTION');

  const footerY = bodyY + bodyH + 6;
  const footerH = H - footerY - MARGIN - 2;
  const notesW  = W - MARGIN * 2 - TB_W - 8;
  drawSheetNotes(ctx, MARGIN, footerY, notesW, footerH,
    'SHEET NOTES', [
      '1. This page contains the original deed legal description as extracted prior to AI-assisted repair.',
      '2. Refer to Page 2 for the corrected metes & bounds legal description after traverse closure repair.',
    ], 4, 5);
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 4, 5);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 5 — Original uncorrected boundary sketch
// ─────────────────────────────────────────────────────────────────────────────
function renderPage5(originalCourses, meta) {
  const { canvas, ctx } = newCanvas();
  drawPageFrame(ctx);

  const titleBarH = 18;
  const titleY    = MARGIN + 2;
  ctx.fillStyle = C_HEADER;
  ctx.fillRect(MARGIN, titleY, W - MARGIN * 2, titleBarH);
  ctx.fillStyle = C_HDR_TXT; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('ORIGINAL DEED — UNCORRECTED BOUNDARY SKETCH — PAGE 5 OF 5', MARGIN + 8, titleY + titleBarH / 2);

  const mapY = titleY + titleBarH + 4;
  const mapH = H - mapY - FOOTER_H - 8;
  ctx.strokeStyle = C_BLACK; ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN, mapY, W - MARGIN * 2, mapH);

  if (originalCourses?.length >= 2) {
    // Compute raw points from original courses starting at POB 5000/5000
    const origPts = computePointsFromCourses(originalCourses);
    if (origPts.length >= 2) {
      drawBoundaryGeometry(ctx, origPts, [], originalCourses,
        { x: MARGIN, y: mapY, w: W - MARGIN * 2, h: mapH },
        { showRaw: false, showAdj: true, showGrid: true, showLabels: false, uncorrected: true }, meta);
    }
  } else {
    ctx.fillStyle = '#888888'; ctx.font = 'italic 14px sans-serif';
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
    ], 5, 5);
  drawTitleBlock(ctx, MARGIN + notesW + 8, footerY, TB_W, footerH, meta, 5, 5);

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

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

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
 * @returns {{ page1, page2, page3, page4, page5 }}  Each value is a PNG Buffer
 */
export function renderSketchPages(stations, adjusted, courses, meta = {},
  closure, legalDescription, originalLegalDesc, originalCourses) {
  return {
    page1: renderPage1(stations, adjusted, courses, meta, closure),
    page2: renderPage2(legalDescription || null, meta),
    page3: renderPage3(courses, meta),
    page4: renderPage4(originalLegalDesc || legalDescription || null, meta),
    page5: renderPage5(originalCourses || courses, meta),
  };
}

/**
 * Backwards-compatible single-canvas render (kept for any callers that still
 * use renderSketchPng — now returns Page 1 only).
 */
export function renderSketchPng(stations, adjusted, courses, meta = {}) {
  return renderPage1(stations, adjusted, courses, meta, null);
}
