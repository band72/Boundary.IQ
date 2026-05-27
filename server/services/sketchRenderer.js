// ─── Server-Side Boundary Sketch Renderer ────────────────────────────────────
// Replicates the PrintBlueprint.jsx canvas drawing logic using the `canvas`
// npm package (Node.js HTML5-compatible Canvas API).
// Produces a letter-landscape PNG (1056×816px @2× = 2112×1632) ready to save.

import { createCanvas } from 'canvas';

const PAD = 50;
const W   = 1056;  // letter landscape @ 96dpi
const H   =  816;
const DPR = 2;     // device pixel ratio — high-res output

/**
 * Render a boundary sketch to a PNG Buffer.
 *
 * @param {object[]} stations   Raw traverse stations [{northing, easting}]
 * @param {object[]} adjusted   Bowditch-adjusted stations (may be empty)
 * @param {object[]} courses    Course objects [{type, bearing, distance, ...}]
 * @param {object}   meta       { parcel, county, state, units, areaAcres,
 *                                perimeter, basisOfBearings, status }
 * @returns {Buffer} PNG image buffer
 */
export function renderSketchPng(stations, adjusted, courses, meta = {}) {
  const canvas = createCanvas(W * DPR, H * DPR);
  const ctx    = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // ── Border frames ─────────────────────────────────────────────────────────
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  ctx.lineWidth = 0.5;
  ctx.strokeRect(8, 8, W - 16, H - 16);

  // ── Point sets ────────────────────────────────────────────────────────────
  const rawPts = (stations?.length >= 2)
    ? stations.map(s => ({ northing: s.northing, easting: s.easting }))
    : [];
  const adjPts = (adjusted?.length >= 2)
    ? adjusted.map(s => ({ northing: s.northing, easting: s.easting }))
    : rawPts;

  if (rawPts.length < 2) {
    // No geometry — write placeholder
    ctx.fillStyle = '#888888';
    ctx.font = 'italic 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No traverse geometry available', W / 2, H / 2);
    return canvas.toBuffer('image/png');
  }

  // ── Coordinate transform ──────────────────────────────────────────────────
  const activePts = adjPts.length >= 2 ? adjPts : rawPts;
  const ns = activePts.map(p => p.northing);
  const es = activePts.map(p => p.easting);
  const minN = Math.min(...ns), maxN = Math.max(...ns);
  const minE = Math.min(...es), maxE = Math.max(...es);
  const rangeN = maxN - minN || 1;
  const rangeE = maxE - minE || 1;

  // Reserve right column for title block (280px) and bottom for tables (160px)
  const mapW = W - 280 - PAD;
  const mapH = H - 160 - PAD;
  const scaleX = mapW / rangeE;
  const scaleY = mapH / rangeN;
  const scale  = Math.min(scaleX, scaleY);

  const drawW  = rangeE * scale;
  const drawH  = rangeN * scale;
  const offX   = PAD + (mapW - drawW) / 2;
  const offY   = PAD / 2 + (mapH - drawH) / 2;

  const tx = e => offX + (e - minE) * scale;
  const ty = n => offY + mapH - (n - minN) * scale;

  // ── Grid ──────────────────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 0.5;
  const step = 60;
  for (let x = step; x < W - 280; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, H - 160); ctx.stroke();
  }
  for (let y = step; y < H - 160; y += step) {
    ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(W - 285, y); ctx.stroke();
  }

  // ── Raw traverse (red dashed) ─────────────────────────────────────────────
  if (rawPts.length >= 2) {
    ctx.beginPath();
    ctx.strokeStyle = '#e63946';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(tx(rawPts[0].easting), ty(rawPts[0].northing));
    for (let i = 1; i < rawPts.length; i++) {
      ctx.lineTo(tx(rawPts[i].easting), ty(rawPts[i].northing));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Adjusted boundary (black solid, shaded fill) ──────────────────────────
  if (adjPts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(tx(adjPts[0].easting), ty(adjPts[0].northing));
    for (let i = 1; i < adjPts.length; i++) {
      ctx.lineTo(tx(adjPts[i].easting), ty(adjPts[i].northing));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.0;
    ctx.moveTo(tx(adjPts[0].easting), ty(adjPts[0].northing));
    for (let i = 1; i < adjPts.length; i++) {
      ctx.lineTo(tx(adjPts[i].easting), ty(adjPts[i].northing));
    }
    ctx.closePath();
    ctx.stroke();
  }

  // ── Station nodes & course labels ─────────────────────────────────────────
  const labelPts = adjPts.length >= 2 ? adjPts : rawPts;
  let lineCount = 0, curveCount = 0;
  const linesList  = [];
  const curvesList = [];

  courses?.forEach((c, idx) => {
    if ((c.type || '').toLowerCase() === 'curve') {
      curveCount++;
      curvesList.push({ id: `C${curveCount}`, idx,
        arcLength: c.arcLength, chordBearing: c.chordBearing,
        chordDistance: c.chordDistance, radius: c.radius, delta: c.delta });
    } else {
      lineCount++;
      linesList.push({ id: `L${lineCount}`, idx, bearing: c.bearing, distance: c.distance });
    }
  });

  labelPts.forEach((p, i) => {
    const x = tx(p.easting), y = ty(p.northing);
    ctx.beginPath();
    ctx.arc(x, y, i === 0 ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle   = i === 0 ? '#000000' : '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();

    if (labelPts.length <= 35) {
      ctx.fillStyle = '#000000';
      ctx.font      = 'bold 9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(i === 0 ? 'POB' : `${i}`, x + 6, y - 4);
    }
  });

  // Course midpoint labels (L1, C1…)
  if (courses?.length > 0) {
    ctx.fillStyle = '#000000';
    ctx.font      = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
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
        const m = linesList.find(x => x.idx === i);  labelId = m ? m.id : '';
      }

      if (labelId) {
        const lx = mx + cpx * 12;
        const ly = my + cpy * 12;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        const tw = ctx.measureText(labelId).width;
        ctx.fillRect(lx - tw / 2 - 2, ly - 6, tw + 4, 12);
        ctx.restore();
        ctx.fillStyle = '#000000';
        ctx.fillText(labelId, lx, ly);
      }
    });
  }

  // ── North arrow ───────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(W - 290 - 45, 45);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, -22);
  ctx.fillStyle = '#000000';
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(7, 8); ctx.lineTo(0, 1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#000000'; ctx.lineWidth = 1.25;
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-7, 8); ctx.lineTo(0, 1); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(0, 12); ctx.stroke();
  ctx.restore();

  // ── Scale bar ─────────────────────────────────────────────────────────────
  ctx.save();
  const targets = [1,2,5,10,20,50,100,200,500,1000,2000,5000];
  let bestD = 100;
  for (const d of targets) { if (d * scale >= 60) { bestD = d; break; } }
  const barW = bestD * scale;
  const bx = PAD, by = H - 155, bh = 6;
  ctx.strokeStyle = '#000000'; ctx.lineWidth = 1.25;
  ctx.fillStyle = '#000000'; ctx.fillRect(bx, by, barW / 2, bh); ctx.strokeRect(bx, by, barW / 2, bh);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(bx + barW / 2, by, barW / 2, bh); ctx.strokeRect(bx + barW / 2, by, barW / 2, bh);
  ctx.fillStyle = '#000000';
  ctx.font = '8px monospace'; ctx.textAlign = 'center';
  ctx.fillText('0', bx, by - 4);
  ctx.fillText(`${bestD / 2}`, bx + barW / 2, by - 4);
  ctx.fillText(`${bestD} ${meta.units || 'Ft'}`, bx + barW, by - 4);
  ctx.font = 'italic 8px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`Scale: 1 in ≈ ${Math.round(96 / scale)} ${(meta.units || 'Feet').toLowerCase()}`, bx, by + bh + 12);
  ctx.restore();

  // ── Right column divider ──────────────────────────────────────────────────
  ctx.strokeStyle = '#000000'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(W - 282, 8); ctx.lineTo(W - 282, H - 8); ctx.stroke();

  // ── Right column: title block ─────────────────────────────────────────────
  const tbX = W - 278;
  let tbY   = 16;
  const tb = (label, value, bold = false) => {
    ctx.font = '7px sans-serif'; ctx.fillStyle = '#666666';
    ctx.textAlign = 'left'; ctx.fillText(label.toUpperCase(), tbX, tbY);
    tbY += 9;
    ctx.font = bold ? 'bold 9px sans-serif' : '9px sans-serif';
    ctx.fillStyle = '#000000';
    const val = String(value || '—');
    // Wrap at ~260px
    const maxW = 260;
    if (ctx.measureText(val).width > maxW) {
      const words = val.split(' ');
      let line = '';
      for (const w of words) {
        const test = line + (line ? ' ' : '') + w;
        if (ctx.measureText(test).width > maxW && line) {
          ctx.fillText(line, tbX, tbY); tbY += 10; line = w;
        } else { line = test; }
      }
      if (line) { ctx.fillText(line, tbX, tbY); tbY += 10; }
    } else {
      ctx.fillText(val, tbX, tbY); tbY += 11;
    }
    // Divider
    ctx.strokeStyle = '#dddddd'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(tbX, tbY); ctx.lineTo(W - 10, tbY); ctx.stroke();
    tbY += 4;
  };

  ctx.fillStyle = '#000000'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('METES & BOUNDS SKETCH', tbX, tbY); tbY += 14;
  ctx.strokeStyle = '#000000'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(tbX, tbY); ctx.lineTo(W - 10, tbY); ctx.stroke();
  tbY += 6;

  tb('Parcel', meta.parcel || 'SUBJECT PARCEL', true);
  tb('County / Region', meta.county || 'UNINCORPORATED AREA');
  tb('State', meta.state || 'GENERAL RECORD');
  tb('Area', meta.areaAcres ? `${parseFloat(meta.areaAcres).toFixed(4)} AC` : '—', true);
  tb('Perimeter', meta.perimeter ? `${parseFloat(meta.perimeter).toFixed(2)} FT` : '—');
  tb('Basis of Bearings', meta.basisOfBearings || 'DEED OF RECORD');
  tb('Status', meta.status || '—', true);
  tb('Platform', 'BOUNDARY.IQ PLATFORM');
  tb('Date', new Date().toISOString().slice(0, 10));

  // ── Bottom: Line table ────────────────────────────────────────────────────
  ctx.strokeStyle = '#000000'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(8, H - 157); ctx.lineTo(W - 8, H - 157); ctx.stroke();

  const tblY0 = H - 150;
  ctx.font = '7px monospace'; ctx.fillStyle = '#000000'; ctx.textAlign = 'left';
  // Headers
  const colW = Math.min(130, (W - 20) / Math.max(linesList.length > 0 ? 2 : 1, 1));
  if (linesList.length > 0) {
    ctx.font = 'bold 7px monospace';
    ctx.fillText('ID', 15, tblY0 + 8);
    ctx.fillText('BEARING', 35, tblY0 + 8);
    ctx.fillText('DIST', 115, tblY0 + 8);
    ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(15, tblY0 + 11); ctx.lineTo(W / 2 - 5, tblY0 + 11); ctx.stroke();
    ctx.font = '7px monospace';
    const maxRows = 10;
    linesList.slice(0, maxRows).forEach((l, i) => {
      const ry = tblY0 + 20 + i * 11;
      ctx.fillText(l.id,      15,  ry);
      ctx.fillText(l.bearing || '—', 35, ry);
      ctx.fillText(l.distance != null ? `${parseFloat(l.distance).toFixed(2)}'` : '—', 115, ry);
    });
    if (linesList.length > maxRows) {
      ctx.fillStyle = '#888888';
      ctx.fillText(`+${linesList.length - maxRows} more…`, 15, tblY0 + 20 + maxRows * 11);
    }
  }

  if (curvesList.length > 0) {
    const cx0 = W / 2;
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 7px monospace';
    ctx.fillText('ID', cx0 + 5, tblY0 + 8);
    ctx.fillText('RADIUS', cx0 + 25, tblY0 + 8);
    ctx.fillText('ARC LEN', cx0 + 80, tblY0 + 8);
    ctx.fillText('CHORD BRG', cx0 + 135, tblY0 + 8);
    ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(cx0 + 5, tblY0 + 11); ctx.lineTo(W - 10, tblY0 + 11); ctx.stroke();
    ctx.font = '7px monospace';
    const maxCRows = 10;
    curvesList.slice(0, maxCRows).forEach((c, i) => {
      const ry = tblY0 + 20 + i * 11;
      ctx.fillText(c.id, cx0 + 5, ry);
      ctx.fillText(c.radius != null ? `${parseFloat(c.radius).toFixed(2)}'` : '—', cx0 + 25, ry);
      ctx.fillText(c.arcLength != null ? `${parseFloat(c.arcLength).toFixed(2)}'` : '—', cx0 + 80, ry);
      ctx.fillText(c.chordBearing || '—', cx0 + 135, ry);
    });
  }

  ctx.textBaseline = 'alphabetic';
  return canvas.toBuffer('image/png');
}
