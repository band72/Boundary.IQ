import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { authFetch, authFetchRaw } from '../api';
import { resolveLabels, getLeaderIntersection } from '../utils/labelLayout';
const PAD = 50;

function drawConceptualMap(ctx, W, H, conceptualAnalysis, legalDesc = '') {
  // Extract lot number and subdivision name
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

  // 1. Grid lines (blueprint style)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.04)';
  ctx.lineWidth = 0.5;
  const step = 60;
  for (let x = step; x < W; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, H - 10); ctx.stroke();
  }
  for (let y = step; y < H; y += step) {
    ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(W - 10, y); ctx.stroke();
  }

  // 2. North Arrow
  const arrowX = W - 60;
  const arrowY = 65;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(arrowX, arrowY, 14, 0, Math.PI * 2);
  ctx.stroke();
  
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY - 18);
  ctx.lineTo(arrowX - 4, arrowY - 4);
  ctx.lineTo(arrowX + 4, arrowY - 4);
  ctx.closePath();
  ctx.fillStyle = '#000000';
  ctx.fill();

  ctx.font = '700 9px sans-serif';
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.fillText('N', arrowX, arrowY - 21);

  // 3. Draw Title Stamp
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1e293b';
  ctx.font = '700 11px sans-serif';
  ctx.fillText('CONCEPTUAL PLAT SKETCH MAP', 30, 45);
  ctx.font = '600 8px sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(`SUBDIVISION: ${subName}`, 30, 58);
  ctx.fillText(`BLOCK: ${blockNum}`, 30, 68);

  // 4. Draw Roadway along bottom
  const roadY = 350;
  const roadH = 45;
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1.5;
  // Top road line
  ctx.beginPath(); ctx.moveTo(30, roadY); ctx.lineTo(W - 30, roadY); ctx.stroke();
  // Bottom road line
  ctx.beginPath(); ctx.moveTo(30, roadY + roadH); ctx.lineTo(W - 30, roadY + roadH); ctx.stroke();
  
  // Center dashed line
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.0;
  ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(30, roadY + roadH / 2); ctx.lineTo(W - 30, roadY + roadH / 2); ctx.stroke();
  ctx.setLineDash([]);

  // Road Label
  ctx.fillStyle = '#334155';
  ctx.font = 'italic 700 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PLATTED ROADWAY (PUBLIC RIGHT-OF-WAY)', W / 2, roadY + roadH / 2 + 3);

  // 5. Draw Subdivision Block & Lots
  const blockX = 100;
  const blockY = 110;
  const blockW = 520;
  const blockH = 200;

  // Draw Block Boundary (Dashed outline)
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.0;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(blockX, blockY, blockW, blockH);
  ctx.setLineDash([]);
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'italic 700 8px sans-serif';
  ctx.fillText(`BLOCK ${blockNum} BOUNDARY`, blockX + 60, blockY + 12);

  // Draw 5 Lots inside block
  const numLots = 5;
  const lotW = blockW / numLots;
  const startLotVal = isNaN(parseInt(lotNum)) ? 105 : parseInt(lotNum) - 2;

  for (let i = 0; i < numLots; i++) {
    const lx = blockX + i * lotW;
    const ly = blockY + 25;
    const lh = blockH - 25;

    const currentLotLabel = isNaN(parseInt(lotNum))
      ? (i === 2 ? lotNum : `LOT ${105 + i}`)
      : `LOT ${startLotVal + i}`;

    const isSubject = (i === 2); // Middle lot is subject

    if (isSubject) {
      // Highlight subject lot
      ctx.fillStyle = 'rgba(14, 165, 233, 0.08)';
      ctx.fillRect(lx, ly, lotW, lh);
      
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(lx, ly, lotW, lh);

      // Draw hatch pattern manually inside subject lot for surveyor style
      ctx.strokeStyle = 'rgba(14, 165, 233, 0.15)';
      ctx.lineWidth = 1.0;
      for (let offset = 10; offset < lotW + lh; offset += 15) {
        ctx.beginPath();
        ctx.moveTo(lx + Math.max(0, offset - lh), ly + Math.min(lh, offset));
        ctx.lineTo(lx + Math.min(lotW, offset), ly + Math.max(0, offset - lotW));
        ctx.stroke();
      }

      ctx.fillStyle = '#0284c7';
      ctx.font = '700 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(currentLotLabel, lx + lotW / 2, ly + lh / 2 - 8);
      ctx.font = '700 7px sans-serif';
      ctx.fillText('(SUBJECT PROPERTY)', lx + lotW / 2, ly + lh / 2 + 4);
      
      // Draw standard residential lot dimensions label
      ctx.font = '500 6.5px sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText("60.00'", lx + lotW / 2, ly + 12);
      ctx.fillText("110.00'", lx + lotW / 2, ly + lh - 8);
      
      // Side dimension vertical
      ctx.save();
      ctx.translate(lx + 8, ly + lh / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("110.00' (TYP)", 0, 0);
      ctx.restore();
    } else {
      // Neighbor lot
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.0;
      ctx.strokeRect(lx, ly, lotW, lh);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(currentLotLabel, lx + lotW / 2, ly + lh / 2);
    }
  }

  // 6. Draw a utility easement line
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 1.0;
  ctx.setLineDash([2, 3]);
  // rear easement line
  ctx.beginPath();
  ctx.moveTo(blockX, blockY + 40);
  ctx.lineTo(blockX + blockW, blockY + 40);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ef4444';
  ctx.font = 'italic 6px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText("15' REAR DRAINAGE & UTILITY EASEMENT", blockX + 15, blockY + 36);

  // 7. Disclaimer stamp box at bottom
  const stampW = 380;
  const stampH = 26;
  const stampX = (W - stampW) / 2;
  const stampY = H - 42;
  ctx.strokeStyle = 'rgba(196, 78, 0, 0.4)';
  ctx.fillStyle = 'rgba(196, 78, 0, 0.04)';
  ctx.lineWidth = 1.0;
  ctx.strokeRect(stampX, stampY, stampW, stampH);
  ctx.fillRect(stampX, stampY, stampW, stampH);

  ctx.fillStyle = '#c44e00';
  ctx.font = '700 7.5px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('CONCEPTUAL DIAGRAM — FOR ILLUSTRATIVE PURPOSES ONLY', W / 2, stampY + 10);
  ctx.font = '500 6.5px sans-serif';
  ctx.fillText('NOT A FIELD SURVEY. PROPERTY BOUNDARIES AND RELATIVE SIZES ARE RECORD ESTIMATES.', W / 2, stampY + 19);
}

function computePointsFromCourses(courses, pob = { northing: 5000, easting: 5000 }) {
  const pts = [{ northing: pob.northing, easting: pob.easting }];
  let curN = pob.northing;
  let curE = pob.easting;

  courses.forEach(c => {
    let bearingStr = c.bearing || c.chordBearing || '';
    let dist = parseFloat(c.distance ?? c.chordDistance ?? c.arcLength ?? 0);

    if (dist <= 0) return;

    // Parse bearing (e.g. "N45-30-00E" or "S12°34'56\"W")
    let match = bearingStr.toUpperCase().match(/([NS])\s*(\d+(?:\.\d+)?)(?:\D+(\d+(?:\.\d+)?))?(?:\D+(\d+(?:\.\d+)?))?[^EW]*([EW])/i);
    let angleRad;
    if (match) {
      let ns = match[1];
      let deg = parseFloat(match[2]);
      let min = parseFloat(match[3] || 0);
      let sec = parseFloat(match[4] || 0);
      let ew = match[5];

      let decimalDeg = deg + min / 60 + sec / 3600;
      let azimuth = 0;

      if (ns === 'N' && ew === 'E') azimuth = decimalDeg;
      else if (ns === 'S' && ew === 'E') azimuth = 180 - decimalDeg;
      else if (ns === 'S' && ew === 'W') azimuth = 180 + decimalDeg;
      else if (ns === 'N' && ew === 'W') azimuth = 360 - decimalDeg;

      angleRad = (azimuth * Math.PI) / 180;
    } else {
      bearingStr = bearingStr.toUpperCase().trim();
      if (bearingStr === 'N' || bearingStr === 'NORTH') angleRad = 0;
      else if (bearingStr === 'S' || bearingStr === 'SOUTH') angleRad = Math.PI;
      else if (bearingStr === 'E' || bearingStr === 'EAST') angleRad = Math.PI / 2;
      else if (bearingStr === 'W' || bearingStr === 'WEST') angleRad = Math.PI * 1.5;
      else if (bearingStr === 'NE') angleRad = Math.PI / 4;
      else if (bearingStr === 'SE') angleRad = Math.PI * 0.75;
      else if (bearingStr === 'SW') angleRad = Math.PI * 1.25;
      else if (bearingStr === 'NW') angleRad = Math.PI * 1.75;
      else return; // skip if unparseable
    }

    curN += dist * Math.cos(angleRad);
    curE += dist * Math.sin(angleRad);
    pts.push({ northing: curN, easting: curE });
  });

  return pts;
}

// Helper functions to compute intermediate curve coordinates
function getCurvePoints(p1, p2, course, steps = 20) {
  const R = parseFloat(course.radius || course.Radius);
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

  const isLeft = (course.curveDirection || course.CurveDirection || '').toLowerCase() === 'left';
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

function parseDmsToDecimal(dms) {
  if (dms == null) return 0;
  const clean = dms.toString().trim();
  const match = clean.match(/^(-?\d+(?:\.\d+)?)\s*[°º*^d]?$/)
    || clean.match(/^(-?\d+)\s*[°º*^d]?\s*(\d+)\s*['’‘`]?\s*(\d+(?:\.\d+)?)\s*["”?']{0,2}$/)
    || clean.match(/^(-?\d+)\s*[°º*^d]?\s*(\d+(?:\.\d+)?)\s*['’‘`]?$/);

  if (match) {
    const deg = parseFloat(match[1]);
    const min = match[2] ? parseFloat(match[2]) : 0;
    const sec = match[3] ? parseFloat(match[3]) : 0;

    // Check for mixed decimal/DMS scrivener error (e.g. 22°97'38.78" where min >= 60)
    if (min >= 60) {
      const minStr = match[2];
      const secStr = match[3] || '';
      const combinedDecStr = `${minStr}${secStr}`.replace(/\./g, '');
      const decValue = parseFloat(`${deg}.${combinedDecStr}`);
      return decValue * (deg < 0 ? -1 : 1);
    }

    const sign = deg < 0 ? -1 : 1;
    return (Math.abs(deg) + min / 60.0 + sec / 3600.0) * sign;
  }
  const val = parseFloat(clean);
  if (!isNaN(val)) return val;
  return 0;
}

function parseBearingToDegrees(b) {
  if (!b) return null;
  const clean = b.toUpperCase().trim().replace(/[^0-9NSEW°'"\-.\s]/g, '');
  const m = clean.match(/^([NS])\s*(\d+(?:\.\d+)?)(?:[°\-\s](\d+(?:\.\d+)?))?(?:['\-\s](\d+(?:\.\d+)?))?["'\s]*([EW])/);
  if (m) {
    const [, ns, degStr, minStr, secStr, ew] = m;
    const deg = parseFloat(degStr || 0);
    const min = parseFloat(minStr || 0);
    const sec = parseFloat(secStr || 0);
    const decDeg = deg + min / 60 + sec / 3600;
    if (ns === 'N' && ew === 'E') return decDeg;
    if (ns === 'S' && ew === 'E') return 180 - decDeg;
    if (ns === 'S' && ew === 'W') return 180 + decDeg;
    if (ns === 'N' && ew === 'W') return 360 - decDeg;
  }
  if (clean === 'N' || clean === 'NORTH') return 0;
  if (clean === 'S' || clean === 'SOUTH') return 180;
  if (clean === 'E' || clean === 'EAST') return 90;
  if (clean === 'W' || clean === 'WEST') return 270;
  return null;
}

function azimuthToBearingString(azDeg) {
  let ns, ew, brg;
  if (azDeg <= 90)       { ns = 'N'; ew = 'E'; brg = azDeg; }
  else if (azDeg <= 180) { ns = 'S'; ew = 'E'; brg = 180 - azDeg; }
  else if (azDeg <= 270) { ns = 'S'; ew = 'W'; brg = azDeg - 180; }
  else                   { ns = 'N'; ew = 'W'; brg = 360 - azDeg; }

  let totalSec = Math.round(brg * 3600 * 100) / 100;
  let d = Math.floor(totalSec / 3600);
  let remSec = totalSec - d * 3600;
  let mn = Math.floor(remSec / 60);
  let sec = remSec - mn * 60;

  const dd = String(d).padStart(2, '0');
  const mm = String(mn).padStart(2, '0');
  const ss = sec.toFixed(2).padStart(5, '0');
  return `${ns}${dd}°${mm}'${ss}"${ew}`;
}

function resolveCurvePropertiesClient(c, prevAzimuthDeg) {
  let r = c.radius != null && c.radius !== '' ? parseFloat(c.radius) : null;
  let l = c.arcLength != null && c.arcLength !== '' ? parseFloat(c.arcLength) : null;
  let dDeg = c.delta != null && c.delta !== '' ? parseDmsToDecimal(c.delta) : null;
  let chDist = c.chordDistance != null && c.chordDistance !== '' ? parseFloat(c.chordDistance) : null;
  let chBrg = c.chordBearing || c.bearing || null;

  if (isNaN(r)) r = null;
  if (isNaN(l)) l = null;
  if (isNaN(dDeg)) dDeg = null;
  if (isNaN(chDist)) chDist = null;

  let deltaRad = dDeg !== null ? dDeg * Math.PI / 180 : null;

  if (r !== null && l !== null && dDeg !== null) {
    const calculatedDeltaRad = l / r;
    const calculatedDeltaDeg = calculatedDeltaRad * 180.0 / Math.PI;
    if (Math.abs(dDeg - calculatedDeltaDeg) > 0.5) {
      dDeg = calculatedDeltaDeg;
      deltaRad = calculatedDeltaRad;
    }
  }

  if (deltaRad === null) {
    if (r !== null && l !== null) {
      deltaRad = l / r;
    } else if (r !== null && chDist !== null) {
      if (chDist <= 2 * r) {
        deltaRad = 2 * Math.asin(chDist / (2 * r));
      }
    } else if (l !== null && chDist !== null) {
      if (chDist < l) {
        const ratio = chDist / l;
        let low = 0;
        let high = Math.PI;
        for (let iter = 0; iter < 50; iter++) {
          const mid = (low + high) / 2;
          const val = Math.sin(mid) / mid;
          if (val > ratio) {
            low = mid;
          } else {
            high = mid;
          }
        }
        deltaRad = 2 * ((low + high) / 2);
      }
    }
  }

  if (deltaRad !== null && deltaRad > 0) {
    if (r === null) {
      if (l !== null) {
        r = l / deltaRad;
      } else if (chDist !== null) {
        const sinHalf = Math.sin(deltaRad / 2);
        if (sinHalf > 0) {
          r = chDist / (2 * sinHalf);
        }
      }
    }

    if (l === null && r !== null) {
      l = r * deltaRad;
    }

    if (chDist === null && r !== null) {
      chDist = 2 * r * Math.sin(deltaRad / 2);
    }

    dDeg = deltaRad * 180 / Math.PI;
  }

  if (chBrg === null && prevAzimuthDeg !== null && dDeg !== null) {
    const deflectionSign = (c.curveDirection || c.direction || '').toLowerCase() === 'left' ? -1 : 1;
    const synthAzDeg = (prevAzimuthDeg + deflectionSign * (dDeg / 2.0) + 360) % 360;
    chBrg = azimuthToBearingString(synthAzDeg);
  }

  return {
    radius: r,
    arcLength: l,
    delta: dDeg,
    chordDistance: chDist,
    chordBearing: chBrg
  };
}

export default function PrintBlueprint({
  courses = [],
  stations = [],
  adjusted = [],
  units = 'Feet',
  area = 0,
  perimeter = 0,
  pob = { northing: 5000, easting: 5000 },
  initialLegalDescription = '',
  originalCourses = null,          // Pre-repair original extraction courses
  originalLegalDescription = '',   // Pre-repair original legal description
  closure = null,
  onClose,
  conceptualAnalysis = null,       // Shaded parcel relative size assumptions
  isOpenEnded = false
}) {
  const [canvasElement, setCanvasElement] = useState(null);
  const [printCanvasElement, setPrintCanvasElement] = useState(null);
  const [originalCanvasElement, setOriginalCanvasElement] = useState(null);
  
  // Title block metadata state
  const [county, setCounty] = useState('');
  const [stateVal, setStateVal] = useState('');
  const [parcel, setParcel] = useState('');
  const [client, setClient] = useState('');
  const [basisBrg, setBasisBrg] = useState('DEED OF RECORD');
  const [deedBook, setDeedBook] = useState('');
  const [deedPage, setDeedPage] = useState('');
  const [legalDesc, setLegalDesc] = useState(initialLegalDescription);
  
  // Customizer options
  const [showGrid, setShowGrid] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showRaw, setShowRaw] = useState(true);
  const [showAdjusted, setShowAdjusted] = useState(true);
  const [showConceptualDetail, setShowConceptualDetail] = useState(() => {
    return localStorage.getItem('boundaryiq_show_conceptual_detail') !== 'false';
  });

  const [blueprintTheme, setBlueprintTheme] = useState(() => {
    return localStorage.getItem('boundaryiq_blueprint_theme') === 'true';
  });

  const [leaderStyle, setLeaderStyle] = useState(() => {
    return localStorage.getItem('boundaryiq_leader_style') || 'arc';
  });

  const [labelContentMode, setLabelContentMode] = useState(() => {
    return localStorage.getItem('boundaryiq_label_content_mode') || 'auto';
  });

  useEffect(() => {
    localStorage.setItem('boundaryiq_show_conceptual_detail', showConceptualDetail);
  }, [showConceptualDetail]);

  useEffect(() => {
    localStorage.setItem('boundaryiq_blueprint_theme', blueprintTheme);
  }, [blueprintTheme]);

  useEffect(() => {
    localStorage.setItem('boundaryiq_leader_style', leaderStyle);
  }, [leaderStyle]);

  useEffect(() => {
    localStorage.setItem('boundaryiq_label_content_mode', labelContentMode);
  }, [labelContentMode]);


  const isMultiPagePrint = true;
  
  // API loading state
  const [loadingLegal, setLoadingLegal] = useState(false);

  // Auto-generate legal description if empty or requested
  const generateLegal = async () => {
    setLoadingLegal(true);
    try {
      const body = {
        courses: courses.map(c => ({
          type: c.type ?? 'Line',
          bearing: c.bearing || null,
          distance: c.distance ? parseFloat(c.distance) : null,
          chordBearing: c.chordBearing || null,
          chordDistance: c.chordDistance ? parseFloat(c.chordDistance) : null,
          arcLength: c.arcLength ? parseFloat(c.arcLength) : null,
          delta: c.delta ? parseFloat(c.delta) : null,
          radius: c.radius ? parseFloat(c.radius) : null,
          curveDirection: c.curveDirection || null,
        })),
        pobNorthing: parseFloat(pob.northing) || 5000,
        pobEasting:  parseFloat(pob.easting) || 5000,
        parcelDescription: parcel  || 'SUBJECT PARCEL',
        county:   county    || null,
        state:    stateVal  || null,
        units:    units.toLowerCase(),
        basisOfBearings: basisBrg || null,
        bearingSystem: 'grid bearings',
        areaAcres:  area ? parseFloat(area) : null,
        perimeter:  perimeter ? parseFloat(perimeter) : null,
      };

      const data = await authFetch('/writer/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setLegalDesc(data.legalDescription ?? data.LegalDescription ?? '');
    } catch (e) {
      console.error('Failed to generate legal description:', e);
    } finally {
      setLoadingLegal(false);
    }
  };

  // Generate lists of Lines and Curves for the tables
  const linesList = [];
  const curvesList = [];
  let prevAzimuthDeg = null;
  
  courses.forEach((c, idx) => {
    const isCurve = (c.type || '').toLowerCase() === 'curve';
    if (isCurve) {
      const resolvedCurve = resolveCurvePropertiesClient(c, prevAzimuthDeg);
      
      curvesList.push({
        id: `C${curvesList.length + 1}`,
        idx,
        radius: resolvedCurve.radius != null ? `${resolvedCurve.radius.toFixed(2)}` : '—',
        delta: resolvedCurve.delta != null ? `${resolvedCurve.delta.toFixed(4)}°` : '—',
        arcLength: resolvedCurve.arcLength != null ? `${resolvedCurve.arcLength.toFixed(2)}` : '—',
        chordBearing: resolvedCurve.chordBearing || '—',
        chordDistance: resolvedCurve.chordDistance != null ? `${resolvedCurve.chordDistance.toFixed(2)}` : '—',
        assumedZeroLength: c.assumedZeroLength || false
      });

      if (resolvedCurve.delta !== null) {
        const deflectionSign = (c.curveDirection || c.direction || '').toLowerCase() === 'left' ? -1 : 1;
        if (prevAzimuthDeg !== null) {
          prevAzimuthDeg = (prevAzimuthDeg + deflectionSign * resolvedCurve.delta + 360) % 360;
        } else if (resolvedCurve.chordBearing) {
          const parsed = parseBearingToDegrees(resolvedCurve.chordBearing);
          if (parsed !== null) prevAzimuthDeg = parsed;
        }
      }
    } else {
      const bearingStr = c.bearing || '';
      const parsed = parseBearingToDegrees(bearingStr);
      if (parsed !== null) {
        prevAzimuthDeg = parsed;
      }

      linesList.push({
        id: `L${linesList.length + 1}`,
        idx,
        bearing: c.bearing || '—',
        distance: c.distance || '—',
        assumedZeroLength: c.assumedZeroLength || false
      });
    }
  });

  // Calculate mapcheck/closure statistics if not provided as a prop
  const computedClosure = (() => {
    if (closure) return closure;
    if (!stations || stations.length < 2) return null;
    const first = stations[0];
    const last = stations[stations.length - 1];
    const errN = first.northing - last.northing;
    const errE = first.easting - last.easting;
    const linearError = Math.sqrt(errN * errN + errE * errE);
    const precision = perimeter > 0 && linearError > 0 ? perimeter / linearError : 0;
    const ratio = precision >= 999999 ? '1:∞ (Perfect)' : `1:${Math.round(precision).toLocaleString()}`;
    const statusText = precision >= 10000 ? `✓ PASSES ${ratio}` : `✗ FAILS ${ratio} (min 1:10,000)`;
    return {
      errorNorthing: errN,
      errorEasting: errE,
      linearError,
      precisionRatio: ratio,
      status: statusText
    };
  })();

  // Helper to render the surveyor title block
  const renderTitleBlock = () => (
    <div className="blueprint-title-block">
      <div className="tb-row border-bottom">
        <div className="tb-cell col-12 bold center font-sans" style={{ fontSize: '0.78rem', letterSpacing: '0.05em' }}>
          METES & BOUNDS PLATTED SKETCH
        </div>
      </div>
      <div className="tb-row border-bottom">
        <div className="tb-cell col-6">
          <span className="tb-label">PARCEL</span>
          <span className="tb-val bold truncate">{parcel || 'SUBJECT PROPERTIES'}</span>
        </div>
        <div className="tb-cell col-6 border-left">
          <span className="tb-label">CLIENT</span>
          <span className="tb-val truncate">{client || 'DEED HOLDER OF RECORD'}</span>
        </div>
      </div>
      <div className="tb-row border-bottom">
        <div className="tb-cell col-6">
          <span className="tb-label">DEED BOOK</span>
          <span className="tb-val bold truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {deedBook || '—'}
          </span>
        </div>
        <div className="tb-cell col-6 border-left">
          <span className="tb-label">DEED PAGE</span>
          <span className="tb-val bold truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {deedPage || '—'}
          </span>
        </div>
      </div>
      <div className="tb-row border-bottom">
        <div className="tb-cell col-6">
          <span className="tb-label">COUNTY / REGION</span>
          <span className="tb-val truncate">{county || 'UNINCORPORATED AREA'}</span>
        </div>
        <div className="tb-cell col-6 border-left">
          <span className="tb-label">STATE / REGION</span>
          <span className="tb-val truncate">{stateVal || 'GENERAL RECORD'}</span>
        </div>
      </div>
      <div className="tb-row border-bottom">
        <div className="tb-cell col-4">
          <span className="tb-label">CALCULATED AREA</span>
          <span className="tb-val bold">{area ? `${parseFloat(area).toFixed(4)} AC` : '—'}</span>
        </div>
        <div className="tb-cell col-4 border-left">
          <span className="tb-label">PERIMETER</span>
          <span className="tb-val">{perimeter ? `${parseFloat(perimeter).toFixed(2)} FT` : '—'}</span>
        </div>
        <div className="tb-cell col-4 border-left">
          <span className="tb-label">POB NORTH/EAST</span>
          <span className="tb-val" style={{ fontSize: '0.58rem' }}>
            N: {parseFloat(pob.northing).toFixed(1)}<br />
            E: {parseFloat(pob.easting).toFixed(1)}
          </span>
        </div>
      </div>
      <div className="tb-row">
        <div className="tb-cell col-6">
          <span className="tb-label">BASIS OF BEARINGS</span>
          <span className="tb-val truncate" style={{ fontSize: '0.62rem' }}>{basisBrg}</span>
        </div>
        <div className="tb-cell col-6 border-left">
          <span className="tb-label">COMPILATION PLATFORM</span>
          <span className="tb-val bold text-accent" style={{ fontSize: '0.62rem', letterSpacing: '0.02em', color: '#1a365d' }}>
            BOUNDARY.IQ PLATFORM
          </span>
        </div>
      </div>
    </div>
  );

  // Main drawing logic
  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => {
    const drawTreeSymbol = (ctx, cx, cy, r) => {
      ctx.save();
      ctx.strokeStyle = blueprintTheme ? '#38bdf8' : '#334155';
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
    };

    const draw = (canvas) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');

      const W = 720;
      const H = 480;
      canvas.width = W * 2;
      canvas.height = H * 2;
      ctx.scale(2, 2);

      ctx.clearRect(0, 0, W, H);

      // Theme colors
      const themeGrid = blueprintTheme ? 'rgba(56, 189, 248, 0.15)' : 'rgba(0,0,0,0.06)';
      const themeBorder = blueprintTheme ? '#38bdf8' : '#000000';
      const themeBoundary = blueprintTheme ? '#00f3ff' : '#000000';
      const themeRaw = blueprintTheme ? '#fb7185' : '#e63946';
      const themeLabelBox = blueprintTheme ? '#0c1a2d' : '#f8f5ed';
      const themeText = blueprintTheme ? '#ffffff' : '#000000';
      const themeTextMuted = blueprintTheme ? '#94a3b8' : '#334155';
      const themeFill = blueprintTheme ? 'rgba(0, 243, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)';

      // Map drawing points selection
      const rawPts = stations?.length 
        ? (stations.map(s => ({ northing: s.northing, easting: s.easting })) || [])
        : (courses?.length ? computePointsFromCourses(courses, pob) : []);
      const adjPts = adjusted?.length ? adjusted : rawPts;
      
      if (rawPts.length < 2) {
        if (conceptualAnalysis) {
          drawConceptualMap(ctx, W, H, conceptualAnalysis, legalDesc);
        }
        return;
      }

      // Use active points for bounds scaling
      const activePts = showAdjusted ? adjPts : rawPts;
      const ns = activePts.map(p => p.northing), es = activePts.map(p => p.easting);
      const minN = Math.min(...ns), maxN = Math.max(...ns);
      const minE = Math.min(...es), maxE = Math.max(...es);
      const rangeN = maxN - minN || 1, rangeE = maxE - minE || 1;

      const scaleX = (W - PAD * 2) / rangeE;
      const scaleY = (H - PAD * 2) / rangeN;
      const scale = Math.min(scaleX, scaleY);

      const drawW = rangeE * scale;
      const drawH = rangeN * scale;
      const offsetX = (W - drawW) / 2;
      const offsetY = (H - drawH) / 2;

      const tx = e => offsetX + (e - minE) * scale;
      const ty = n => H - offsetY - (n - minN) * scale;

      // Draw boundary border frame around the map canvas
      ctx.strokeStyle = themeBorder;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(5, 5, W - 10, H - 10);
      ctx.lineWidth = 0.5;
      ctx.strokeRect(8, 8, W - 16, H - 16);

      // 1. Grid Lines
      if (showGrid) {
        ctx.strokeStyle = themeGrid;
        ctx.lineWidth = 0.5;
        const step = 60;
        for (let x = step; x < W; x += step) {
          ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, H - 10); ctx.stroke();
        }
        for (let y = step; y < H; y += step) {
          ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(W - 10, y); ctx.stroke();
        }
      }

      const denseRawPts = getDensePoints(rawPts, courses);
      const denseAdjPts = getDensePoints(adjPts, courses);

      // 2. Draw Raw (Unadjusted) Boundary (if requested and exists)
      if (showRaw && denseRawPts.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = themeRaw;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 4]);
        if (blueprintTheme) {
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

      // 3. Draw Adjusted Boundary (Solid Black)
      if (showAdjusted && denseAdjPts.length > 1) {
        // Draw closed shaded polygon first
        if (!isOpenEnded) {
          ctx.beginPath();
          ctx.moveTo(tx(denseAdjPts[0].easting), ty(denseAdjPts[0].northing));
          for (let i = 1; i < denseAdjPts.length; i++) {
            ctx.lineTo(tx(denseAdjPts[i].easting), ty(denseAdjPts[i].northing));
          }
          ctx.closePath();
          ctx.fillStyle = themeFill;
          ctx.fill();
        }

        // Draw boundary line stroke
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = themeBoundary;
        ctx.lineWidth = 2.0;
        if (blueprintTheme) {
          ctx.shadowColor = themeBoundary;
          ctx.shadowBlur = 6;
        }
        ctx.moveTo(tx(denseAdjPts[0].easting), ty(denseAdjPts[0].northing));
        for (let i = 1; i < denseAdjPts.length; i++) {
          ctx.lineTo(tx(denseAdjPts[i].easting), ty(denseAdjPts[i].northing));
        }
        if (!isOpenEnded) {
          ctx.closePath();
        }
        ctx.stroke();
        ctx.restore();
      }

      // 3.5. Draw Conceptual Details (Angled labels, Roadway, Easement, Center label)
      if (showConceptualDetail && adjPts.length > 1 && !isOpenEnded) {
        const drawPts = adjPts;

        // Calculate geometric center for text placements
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
            if (c.type === 'Curve') {
              labelText = `${c.chordBearing || ''} R=${c.radius ? parseFloat(c.radius).toFixed(1) : ''}' L=${c.arcLength ? parseFloat(c.arcLength).toFixed(1) : ''}'`;
            } else {
              labelText = `${c.bearing || ''} ${c.distance ? parseFloat(c.distance).toFixed(2) : ''}'`;
            }
          }

          if (labelText) {
            ctx.save();
            ctx.translate(lx, ly);
            ctx.rotate(theta);
            ctx.font = 'bold 7px "Inter", sans-serif';
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
        ctx.font = 'bold 8.5px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const centerName = parcel ? `PART OF ${parcel.toUpperCase()}` : 'SUBJECT PARCEL';
        const centerArea = area ? `${parseFloat(area).toFixed(4)} ACRES` : '';
        ctx.fillText(centerName, centerX, centerY - 6);
        if (centerArea) {
          ctx.font = 'bold 7.5px "Inter", sans-serif';
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

        const roadLabel = (getStreetName(legalDesc) || 'PUBLIC ROADWAY') + ' R.O.W.';
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
        ctx.font = 'italic bold 7px "Inter", sans-serif';
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

        ctx.strokeStyle = blueprintTheme ? '#fb7185' : 'rgba(239, 68, 68, 0.65)';
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
        ctx.fillStyle = blueprintTheme ? '#f43f5e' : '#ef4444';
        ctx.font = 'italic bold 6.5px "Inter", sans-serif';
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
            ctx.strokeStyle = blueprintTheme ? 'rgba(56, 189, 248, 0.5)' : 'rgba(51, 65, 85, 0.4)';
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
            ctx.fillStyle = blueprintTheme ? '#38bdf8' : '#334155';
            ctx.font = 'italic bold 6px "Inter", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("NATIVE CREEK", 0, 10);
            ctx.restore();

            // 25' Riparian Buffer
            ctx.strokeStyle = blueprintTheme ? 'rgba(56, 189, 248, 0.5)' : 'rgba(51, 65, 85, 0.4)';
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
            ctx.fillStyle = blueprintTheme ? '#38bdf8' : '#334155';
            ctx.font = 'italic 5px "Inter", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("25' RIPARIAN BUFFER", 0, -15);
            ctx.restore();
          }
        });

        // F. Setbacks and Residence Footprint
        ctx.strokeStyle = blueprintTheme ? 'rgba(56, 189, 248, 0.35)' : 'rgba(51, 65, 85, 0.25)';
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
          ctx.fillStyle = blueprintTheme ? '#1e293b' : '#e2e8f0';
          ctx.strokeStyle = blueprintTheme ? '#00f3ff' : '#0f172a';
          ctx.lineWidth = 1.25;
          ctx.fillRect(centerX - houseW/2, centerY - houseH/2, houseW, houseH);
          ctx.strokeRect(centerX - houseW/2, centerY - houseH/2, houseW, houseH);

          ctx.fillStyle = blueprintTheme ? '#ffffff' : '#0f172a';
          ctx.font = 'bold 5.5px "Inter", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('RESIDENCE', centerX, centerY);

          ctx.strokeStyle = blueprintTheme ? 'rgba(56, 189, 248, 0.4)' : 'rgba(51, 65, 85, 0.3)';
          ctx.lineWidth = 0.5;

          ctx.beginPath();
          ctx.moveTo(centerX, centerY + houseH/2);
          ctx.lineTo(centerX, centerY + houseH/2 + 25);
          ctx.stroke();
          
          ctx.fillStyle = blueprintTheme ? '#a5f3fc' : '#334155';
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
          drawTreeSymbol(ctx, pos.x, pos.y, pos.r);
        });
      }

      // 4. Draw Stations and Course Labels (L1, C1...)
      const labeledPts = showAdjusted ? adjPts : rawPts;
      labeledPts.forEach((p, i) => {
        const x = tx(p.easting), y = ty(p.northing);
        
        ctx.beginPath();
        ctx.arc(x, y, i === 0 ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? themeBoundary : '#ffffff';
        ctx.strokeStyle = themeBorder;
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      });

      // Compute resolved positions for all labels in logical canvas space
      const resolvedPoints = labeledPts.map(p => ({ x: tx(p.easting), y: ty(p.northing) }));
      const resolvedLabels = resolveLabels(ctx, resolvedPoints, courses, W, H, {
        stationFont: 'bold 9px "JetBrains Mono", monospace',
        segmentFont: 'bold 9px "Inter", sans-serif',
        stationPadding: 3,
        segmentPaddingX: 4,
        segmentPaddingY: 2,
        vertexRadius: 3,
        showStations: labeledPts.length <= 35,
        showSegments: showLabels,
        showConceptualDetail: showConceptualDetail,
        leaderStyle,
        labelContentMode
      });

      // Draw all resolved labels
      const leaderColor = blueprintTheme ? 'rgba(56, 189, 248, 0.8)' : 'rgba(0, 0, 0, 0.6)';
      const labelBorderColor = blueprintTheme ? 'rgba(56, 189, 248, 0.6)' : 'rgba(0, 0, 0, 0.4)';
      const segmentCurveBorder = blueprintTheme ? 'rgba(251, 113, 133, 0.6)' : 'rgba(230, 57, 70, 0.6)';

      resolvedLabels.forEach(lbl => {
        if (lbl.type === 'station') {
          if (lbl.needsLeader) {
            const intersection = getLeaderIntersection(lbl.anchorX, lbl.anchorY, lbl.x, lbl.y, lbl.width, lbl.height);
            ctx.beginPath();
            ctx.moveTo(lbl.anchorX, lbl.anchorY);
            if (lbl.leaderStyle === 'arc') {
              const dx = intersection.x - lbl.anchorX;
              const dy = intersection.y - lbl.anchorY;
              const dist = Math.hypot(dx, dy) || 1e-9;
              const midX = (lbl.anchorX + intersection.x) / 2;
              const midY = (lbl.anchorY + intersection.y) / 2;
              const px = -dy / dist;
              const py = dx / dist;
              const controlX = midX + px * dist * 0.2;
              const controlY = midY + py * dist * 0.2;
              ctx.quadraticCurveTo(controlX, controlY, intersection.x, intersection.y);
            } else {
              ctx.lineTo(intersection.x, intersection.y);
            }
            ctx.strokeStyle = leaderColor;
            ctx.lineWidth = 0.8;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(lbl.anchorX, lbl.anchorY, 1.5, 0, Math.PI * 2);
            ctx.fillStyle = leaderColor;
            ctx.fill();

            ctx.save();
            ctx.font = 'bold 9px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = themeLabelBox;
            ctx.strokeStyle = labelBorderColor;
            ctx.lineWidth = 0.8;
            const rx = lbl.x - lbl.width / 2;
            const ry = lbl.y - lbl.height / 2;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(rx, ry, lbl.width, lbl.height, 2);
            else ctx.rect(rx, ry, lbl.width, lbl.height);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = themeText;
            ctx.fillText(lbl.text, lbl.x, lbl.y);
            ctx.restore();
          } else {
            ctx.save();
            ctx.fillStyle = themeText;
            ctx.font = 'bold 9px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            // Subtle text stroke shadow for contrast
            ctx.strokeStyle = themeLabelBox;
            ctx.lineWidth = 2.5;
            ctx.strokeText(lbl.text, lbl.x, lbl.y);
            ctx.fillText(lbl.text, lbl.x, lbl.y);
            ctx.restore();
          }
        } else if (lbl.type === 'segment') {
          if (lbl.needsLeader) {
            const intersection = getLeaderIntersection(lbl.anchorX, lbl.anchorY, lbl.x, lbl.y, lbl.width, lbl.height);
            ctx.beginPath();
            ctx.moveTo(lbl.anchorX, lbl.anchorY);
            if (lbl.leaderStyle === 'arc') {
              const dx = intersection.x - lbl.anchorX;
              const dy = intersection.y - lbl.anchorY;
              const dist = Math.hypot(dx, dy) || 1e-9;
              const midX = (lbl.anchorX + intersection.x) / 2;
              const midY = (lbl.anchorY + intersection.y) / 2;
              const px = -dy / dist;
              const py = dx / dist;
              const controlX = midX + px * dist * 0.2;
              const controlY = midY + py * dist * 0.2;
              ctx.quadraticCurveTo(controlX, controlY, intersection.x, intersection.y);
            } else {
              ctx.lineTo(intersection.x, intersection.y);
            }
            ctx.strokeStyle = leaderColor;
            ctx.lineWidth = 0.8;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(lbl.anchorX, lbl.anchorY, 1.5, 0, Math.PI * 2);
            ctx.fillStyle = leaderColor;
            ctx.fill();
          }

          ctx.save();
          ctx.font = 'bold 9px "Inter", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.translate(lbl.x, lbl.y);
          if (lbl.rotated) {
            ctx.rotate(lbl.angle);
          }

          ctx.fillStyle = themeLabelBox;
          ctx.strokeStyle = lbl.isCurve ? segmentCurveBorder : labelBorderColor;
          ctx.lineWidth = 0.8;
          
          const rx = -lbl.width / 2;
          const ry = -lbl.height / 2;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(rx, ry, lbl.width, lbl.height, 3);
          else ctx.rect(rx, ry, lbl.width, lbl.height);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = themeText;
          ctx.fillText(lbl.text, 0, 0);
          ctx.restore();
        }
      });


      // 6. Draw North Arrow
      ctx.save();
      ctx.translate(W - 45, 45);
      ctx.fillStyle = themeText;
      ctx.font = 'bold 15px "Inter", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('N', 0, -22);

      // Right half
      ctx.fillStyle = themeBoundary;
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(7, 8);
      ctx.lineTo(0, 1);
      ctx.closePath();
      ctx.fill();

      // Left half (white/hollow)
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = themeBorder;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(-7, 8);
      ctx.lineTo(0, 1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(0, 12);
      ctx.stroke();
      ctx.restore();

      // 7. Draw Scale Bar
      ctx.save();
      const targetDistances = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
      let bestD = 100;
      for (const d of targetDistances) {
        const pxWidth = d * scale;
        if (pxWidth >= 85) {
          bestD = d;
          break;
        }
      }
      const scaleBarPxWidth = bestD * scale;
      const bx = 30; 
      const by = H - 35; 
      const bh = 6; 
      const wHalf = scaleBarPxWidth / 2;

      ctx.strokeStyle = themeBorder;
      ctx.lineWidth = 1.25;

      // Segment 1
      ctx.fillStyle = themeBoundary;
      ctx.fillRect(bx, by, wHalf, bh);
      ctx.strokeRect(bx, by, wHalf, bh);

      // Segment 2
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx + wHalf, by, wHalf, bh);
      ctx.strokeRect(bx + wHalf, by, wHalf, bh);

      // Label markings
      ctx.fillStyle = themeText;
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('0', bx, by - 4);
      ctx.fillText(`${bestD / 2}`, bx + wHalf, by - 4);
      ctx.fillText(`${bestD} ${units}`, bx + scaleBarPxWidth, by - 4);

      // Text scale description
      ctx.font = 'italic 8px "Inter", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`Scale: 1 in = ${Math.round(96 / scale)} ${units.toLowerCase()}`, bx, by + bh + 12);

      // 0-length line warning in red
      const hasZeroLengthLines = courses.some(c => c.assumedZeroLength || c.distance === 0 || c.chordDistance === 0) ||
                                 (originalCourses && originalCourses.some(c => c.distance === 0 || c.chordDistance === 0)) ||
                                 (initialLegalDescription && /0\.00\s*(?:FEET|FT)/i.test(initialLegalDescription));
      if (hasZeroLengthLines) {
        ctx.save();
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('⚠️ WARNING: 0-LENGTH LINES DETECTED & ASSUMED 10.0 FT FOR CONCEPTUAL SKETCH (VERIFY DEED)', W / 2, 28);
        ctx.restore();
      }

      ctx.restore();
    };

    // eslint-disable-next-line react-hooks/immutability
    draw(canvasElement);
    // eslint-disable-next-line react-hooks/immutability
    draw(printCanvasElement);


    // Use original courses if provided, otherwise fall back to corrected courses
    const origCourses = originalCourses || courses;
    const origPts = computePointsFromCourses(origCourses, pob);
    if (origPts.length < 2) return;

    const canvas = originalCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = 720, H = 480;
    // eslint-disable-next-line react-hooks/immutability
    canvas.width = W * 2;
    canvas.height = H * 2;
    ctx.scale(2, 2);

    // Transparent background so CSS aged graph paper background shows through
    ctx.clearRect(0, 0, W, H);

    // Compute bounds
    const ns = origPts.map(p => p.northing), es = origPts.map(p => p.easting);
    const minN = Math.min(...ns), maxN = Math.max(...ns);
    const minE = Math.min(...es), maxE = Math.max(...es);
    const rangeN = maxN - minN || 1, rangeE = maxE - minE || 1;
    const scaleX = (W - PAD * 2) / rangeE;
    const scaleY = (H - PAD * 2) / rangeN;
    const scale = Math.min(scaleX, scaleY);
    const drawW = rangeE * scale, drawH = rangeN * scale;
    const offsetX = (W - drawW) / 2, offsetY = (H - drawH) / 2;
    const tx = e => offsetX + (e - minE) * scale;
    const ty = n => H - offsetY - (n - minN) * scale;

    // Border frame
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(5, 5, W - 10, H - 10);
    ctx.lineWidth = 0.5;
    ctx.strokeRect(8, 8, W - 16, H - 16);

    // Grid
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 0.5;
    for (let x = 60; x < W; x += 60) {
      ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, H - 10); ctx.stroke();
    }
    for (let y = 60; y < H; y += 60) {
      ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(W - 10, y); ctx.stroke();
    }

    const denseOrigPts = getDensePoints(origPts, origCourses);

    // Draw Original Boundary in DASHED BLACK lines
    ctx.beginPath();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.0;
    ctx.setLineDash([8, 6]);
    ctx.moveTo(tx(denseOrigPts[0].easting), ty(denseOrigPts[0].northing));
    for (let i = 1; i < denseOrigPts.length; i++) {
      ctx.lineTo(tx(denseOrigPts[i].easting), ty(denseOrigPts[i].northing));
    }
    if (!isOpenEnded) {
      ctx.closePath();
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Node markers
    origPts.forEach((p, i) => {
      const x = tx(p.easting), y = ty(p.northing);
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#000000' : '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();

      if (origPts.length <= 35) {
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.fillText(i === 0 ? 'POB' : `${i}`, x + 6, y - 4);
      }
    });

    // North Arrow
    ctx.save();
    ctx.translate(W - 45, 45);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 15px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -22);
    ctx.fillStyle = '#000000';
    ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(7, 8); ctx.lineTo(0, 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#000000'; ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-7, 8); ctx.lineTo(0, 1); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(0, 12); ctx.stroke();
    ctx.restore();

    // "UNCORRECTED" watermark
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-Math.PI / 6);
    ctx.font = 'bold 48px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(200, 0, 0, 0.08)';
    ctx.fillText('UNCORRECTED', 0, 0);
    ctx.restore();

  }, [originalCanvasElement, originalCourses, courses, pob]);

  // Build a unique filename slug: parcel + deed book/page + timestamp
  const buildFileName = (ext) => {
    const parts = [];
    if (parcel)    parts.push(parcel.trim().replace(/\s+/g, '_'));
    if (deedBook)  parts.push(`Bk${deedBook.trim()}`);
    if (deedPage)  parts.push(`Pg${deedPage.trim()}`);
    if (!parts.length) parts.push('boundary_sketch');
    // Append YYYYMMDD_HHmmss for uniqueness
    const now = new Date();
    const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    parts.push(ts);
    return `${parts.join('_')}.${ext}`;
  };

  const handlePrint = () => {
    const prev = document.title;
    document.title = buildFileName('pdf').replace(/\.pdf$/, '');
    window.print();
    // Restore title after a tick (print dialog is synchronous on most browsers)
    setTimeout(() => { document.title = prev; }, 500);
  };

  const handleDownloadDxf = async () => {
    try {
      const body = {
        stations: stations || [],
        adjusted: adjusted || [],
        courses: courses.map(c => ({
          type: c.type ?? 'Line',
          bearing: c.bearing || null,
          distance: c.distance ? parseFloat(c.distance) : null,
          chordBearing: c.chordBearing || null,
          chordDistance: c.chordDistance ? parseFloat(c.chordDistance) : null,
          arcLength: c.arcLength ? parseFloat(c.arcLength) : null,
          delta: c.delta ? parseFloat(c.delta) : null,
          radius: c.radius ? parseFloat(c.radius) : null,
          curveDirection: c.curveDirection || null,
        })),
        parcel: parcel || 'SUBJECT PARCEL',
        county: county || null,
        state: stateVal || null,
        units: units || 'Feet',
        areaAcres: area ? parseFloat(area) : 0,
        perimeter: perimeter ? parseFloat(perimeter) : 0,
        basisOfBearings: basisBrg || null,
      };

      const res = await authFetchRaw('/dxf/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Failed to generate DXF');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildFileName('dxf');
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to download DXF:', e);
      alert('Error generating DXF export: ' + e.message);
    }
  };

  return createPortal(
    <div className={`print-overlay ${isMultiPagePrint ? 'print-multi-layout' : 'print-single-layout'}`}>
      {/* ── Configuration Sidebar (Hidden during Print) ──────────────── */}
      <div className="print-sidebar no-print">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--accent)' }}>📋 Layout Builder</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: '0.25rem 0.5rem', borderRadius: 4 }}>✕ Close</button>
        </div>
        
        <div className="sidebar-scrollable">
          {/* Metadata Section */}
          <div className="sidebar-section">
            <h3 className="section-title">Deed & Plat Metadata</h3>
            <div className="form-group">
              <label className="form-label">County</label>
              <input type="text" placeholder="e.g. Cook County" value={county} onChange={e => setCounty(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">State</label>
              <input type="text" placeholder="e.g. Illinois" value={stateVal} onChange={e => setStateVal(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Parcel / Lot Name</label>
              <input type="text" placeholder="e.g. Lot 14, Block B" value={parcel} onChange={e => setParcel(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Client / Owner Name</label>
              <input type="text" placeholder="e.g. Arthur Pendragon" value={client} onChange={e => setClient(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Basis of Bearings</label>
              <input type="text" placeholder="State Plane Grid" value={basisBrg} onChange={e => setBasisBrg(e.target.value)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Deed Book</label>
                <input
                  type="text"
                  placeholder="e.g. 1234"
                  value={deedBook}
                  onChange={e => setDeedBook(e.target.value)}
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Deed Page</label>
                <input
                  type="text"
                  placeholder="e.g. 456"
                  value={deedPage}
                  onChange={e => setDeedPage(e.target.value)}
                />
              </div>
            </div>
          </div>



          {/* Toggle Map Options */}
          <div className="sidebar-section">
            <h3 className="section-title">Map Overlay Options</h3>
            <label className="checkbox-label">
              <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />
              Show Grid Lines
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} />
              Show Course labels (L1, C1...)
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={showRaw} onChange={e => setShowRaw(e.target.checked)} />
              Show Raw Traverse (Red)
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={showAdjusted} onChange={e => setShowAdjusted(e.target.checked)} />
              Show Adjusted Boundary (Black)
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={showConceptualDetail} onChange={e => setShowConceptualDetail(e.target.checked)} />
              Add Conceptual Detail
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={blueprintTheme} onChange={e => setBlueprintTheme(e.target.checked)} />
              Blueprint Style (Dark Mode)
            </label>
            <div style={{ marginTop: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'rgba(255, 255, 255, 0.7)' }}>Leader Style</label>
                <select
                  value={leaderStyle}
                  onChange={e => setLeaderStyle(e.target.value)}
                  style={{
                    backgroundColor: 'rgba(30, 41, 59, 0.8)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    color: '#ffffff',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  <option value="arc">Arc (Curved)</option>
                  <option value="straight">Straight</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'rgba(255, 255, 255, 0.7)' }}>Label Mode</label>
                <select
                  value={labelContentMode}
                  onChange={e => setLabelContentMode(e.target.value)}
                  style={{
                    backgroundColor: 'rgba(30, 41, 59, 0.8)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    color: '#ffffff',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  <option value="auto">Auto-Table (Full Labels)</option>
                  <option value="tags">Tags Only</option>
                </select>
              </div>
            </div>
          </div>


          {/* Legal Description Block */}
          <div className="sidebar-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <h3 className="section-title" style={{ margin: 0 }}>Legal Description</h3>
              <button 
                className="btn btn-ghost btn-sm" 
                onClick={generateLegal} 
                disabled={loadingLegal}
                style={{ fontSize: '0.68rem', padding: '2px 6px' }}
              >
                {loadingLegal ? 'Writing...' : '✦ Auto-Write'}
              </button>
            </div>
            <textarea
              value={legalDesc}
              onChange={e => setLegalDesc(e.target.value)}
              placeholder="Legal description text to insert on blueprint sketch sheet..."
              style={{ minHeight: 90, fontSize: '0.78rem', resize: 'vertical' }}
            />
          </div>
        </div>

        <div className="sidebar-actions mt-3" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <button className="btn btn-primary" onClick={handlePrint} style={{ width: '100%', justifyContent: 'center' }}>
            🖨 Print Sketch Sheet
          </button>
          <button className="btn btn-success" onClick={handleDownloadDxf} style={{ width: '100%', justifyContent: 'center', background: 'rgba(0, 212, 168, 0.15)', borderColor: 'rgba(0, 212, 168, 0.4)', color: 'var(--success)' }}>
            💾 Download DXF File
          </button>
        </div>
      </div>

      {/* ── Blueprint Print Sheet View (11" x 8.5" Landscape Aspect) ──────────────── */}
      <div className="print-canvas-wrapper">
        {/* 1. Screen View & Print Single-Page (Always visible on screen, hidden during print if multi-page mode is active) */}
        <div className={`blueprint-sheet no-print ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
          {/* Main double-border frame */}
          <div className="blueprint-border-outer">
            <div className="blueprint-border-inner">
              
              {/* LANDSCAPE CONTAINER */}
              <div className="blueprint-grid">
                
                {/* LEFT SIDE: Map Canvas drawing */}
                <div className="blueprint-map-column">
                  <div className="blueprint-section-title">
                    {courses.length > 0 ? 'BOUNDARY SURVEY SKETCH' : 'CONCEPTUAL PLAT SKETCH MAP'}
                  </div>
                  <canvas ref={setCanvasElement} className="blueprint-canvas-element" />
                </div>

                {/* RIGHT SIDE: Information, tables and title block */}
                <div className="blueprint-info-column">
                  
                  {/* Part 1: Legal Description Insert */}
                  <div className="blueprint-desc-panel">
                    <div className="panel-header">LEGAL DESCRIPTION</div>
                    <div className="panel-body font-serif">
                      {legalDesc ? (
                        <p>{legalDesc}</p>
                      ) : (
                        <p className="no-description">
                          [No legal description provided. Click "Auto-Write" in the sidebar editor to generate a professional metes & bounds legal description dynamically.]
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Part 2: Dynamic Line and Curve Tables OR Conceptual Analysis Notes */}
                  {courses.length > 0 ? (
                    <div className="blueprint-tables-panel">
                      {linesList.length > 0 && (
                        <div className="table-block">
                          <div className="panel-header">LINE TABLE</div>
                          <table className="survey-table">
                            <thead>
                              <tr><th>ID</th><th>BEARING</th><th>DISTANCE</th></tr>
                            </thead>
                            <tbody>
                              {linesList.map(line => (
                                <tr key={line.id}>
                                  <td className="bold">{line.id}</td>
                                  <td>{line.bearing}</td>
                                  <td style={line.assumedZeroLength ? { color: '#ef4444', fontWeight: 'bold' } : {}}>
                                    {line.distance !== '—' ? `${line.distance}${line.assumedZeroLength ? '*' : ''}'` : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {curvesList.length > 0 && (
                        <div className="table-block" style={{ marginTop: '0.5rem' }}>
                          <div className="panel-header">CURVE TABLE</div>
                          <table className="survey-table">
                            <thead>
                              <tr>
                                <th>ID</th>
                                <th>RADIUS</th>
                                <th>ARC LEN</th>
                                <th>CHORD BRG</th>
                                <th>CHORD DIST</th>
                              </tr>
                            </thead>
                            <tbody>
                              {curvesList.map(curve => (
                                <tr key={curve.id}>
                                  <td className="bold">{curve.id}</td>
                                  <td>{curve.radius}'</td>
                                  <td style={curve.assumedZeroLength ? { color: '#ef4444', fontWeight: 'bold' } : {}}>
                                    {curve.arcLength !== '—' ? `${curve.arcLength}${curve.assumedZeroLength ? '*' : ''}'` : '—'}
                                  </td>
                                  <td style={{ fontSize: '0.62rem' }}>{curve.chordBearing}</td>
                                  <td style={curve.assumedZeroLength ? { color: '#ef4444', fontWeight: 'bold' } : {}}>
                                    {curve.chordDistance !== '—' ? `${curve.chordDistance}${curve.assumedZeroLength ? '*' : ''}'` : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ) : conceptualAnalysis ? (
                    <div className="blueprint-desc-panel" style={{ maxHeight: '200px', flex: 'none', height: '180px' }}>
                      <div className="panel-header" style={{ background: '#000000', color: '#ffffff' }}>CONCEPTUAL LOT & BLOCK ANALYSIS</div>
                      <div className="panel-body font-sans" style={{ fontSize: '0.68rem', lineHeight: '1.4', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px' }}>
                        <div>
                          <strong>Interpretation:</strong> {conceptualAnalysis.Description || conceptualAnalysis.description}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', borderTop: '0.5px solid #000000', paddingTop: '4px', marginTop: '4px' }}>
                          <div><strong>Parent Tract:</strong> {conceptualAnalysis.ParentTractSizeEstimate || conceptualAnalysis.parentTractSizeEstimate || 'unknown'}</div>
                          <div><strong>Std Lot:</strong> {conceptualAnalysis.LotSizeEstimate || conceptualAnalysis.lotSizeEstimate || '0.15 ac'}</div>
                        </div>
                        <div style={{ fontStyle: 'italic', borderTop: '0.5px solid #000000', paddingTop: '4px', marginTop: '2px' }}>
                          {conceptualAnalysis.RelativeComparison || conceptualAnalysis.relativeComparison}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {/* Part 3: Professional Surveyor Title Block */}
                  {renderTitleBlock()}

                </div>

              </div>

            </div>
          </div>
        </div>

        {/* 2. Print Multi-Page (Always hidden on screen, shown only during print if multi-page mode is active) */}
        <div className="blueprint-multi-container only-print">
          {courses.length > 0 ? (
            <>
              {/* SHEET 1: Main Map, Title Block, and Mapcheck at the Bottom */}
              <div className={`blueprint-sheet ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
                <div className="blueprint-border-outer">
                  <div className="blueprint-border-inner">
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div className="blueprint-section-title">BOUNDARY SURVEY SKETCH</div>
                      
                      {/* Map occupies upper space */}
                      <div style={{ flex: 1, minHeight: 0, position: 'relative', border: '1.5px solid #000000', boxSizing: 'border-box', marginBottom: '12px' }}>
                        <canvas ref={setPrintCanvasElement} className="blueprint-canvas-element" style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }} />
                      </div>

                      {/* Footer with Title Block and Mapcheck */}
                      <div style={{ display: 'flex', gap: '12px', height: '150px', flexShrink: 0 }}>
                        
                        {/* Mapcheck / Closure Box */}
                        <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
                          <div className="panel-header">MAPCHECK / CLOSURE VERIFICATION</div>
                          <div style={{ padding: '8px', fontSize: '0.65rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', flex: 1, alignContent: 'center' }}>
                            <div>
                              <span style={{ fontWeight: 600, color: '#555555' }}>PRECISION RATIO:</span>
                              <div style={{ fontFamily: 'JetBrains Mono', fontSize: '0.8rem', fontWeight: 700, color: computedClosure?.status?.includes('FAIL') || computedClosure?.status?.includes('✗') ? '#cc0000' : '#007700' }}>
                                {computedClosure?.precisionRatio || '1:∞'}
                              </div>
                            </div>
                            <div>
                              <span style={{ fontWeight: 600, color: '#555555' }}>LINEAR CLOSURE ERROR:</span>
                              <div style={{ fontFamily: 'JetBrains Mono', fontSize: '0.8rem', fontWeight: 700 }}>
                                {computedClosure?.linearError ? `${parseFloat(computedClosure.linearError).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}` : '0.0000 FT'}
                              </div>
                            </div>
                            <div>
                              <span style={{ fontWeight: 600, color: '#555555' }}>ERROR NORTHING:</span>
                              <div style={{ fontFamily: 'JetBrains Mono', fontSize: '0.72rem' }}>
                                {computedClosure?.errorNorthing ? `${parseFloat(computedClosure.errorNorthing).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}` : '0.0000 FT'}
                              </div>
                            </div>
                            <div>
                              <span style={{ fontWeight: 600, color: '#555555' }}>ERROR EASTING:</span>
                              <div style={{ fontFamily: 'JetBrains Mono', fontSize: '0.72rem' }}>
                                {computedClosure?.errorEasting ? `${parseFloat(computedClosure.errorEasting).toFixed(4)} ${units === 'Feet' ? 'FT' : 'M'}` : '0.0000 FT'}
                              </div>
                            </div>
                            <div style={{ gridColumn: 'span 2', borderTop: '0.5px solid #ccc', paddingTop: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontWeight: 600, color: '#555555' }}>TRAVERSE AUDIT STATUS:</span>
                              <span style={{ fontWeight: 700, color: computedClosure?.status?.includes('FAIL') || computedClosure?.status?.includes('✗') ? '#cc0000' : '#007700' }}>
                                {computedClosure?.status || 'PASS'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Title Block */}
                        <div style={{ width: '420px', flexShrink: 0 }}>
                          {renderTitleBlock()}
                        </div>

                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* SHEET 2: Original Legal Description */}
              <div className={`blueprint-sheet page-break ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
                <div className="blueprint-border-outer">
                  <div className="blueprint-border-inner">
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div className="blueprint-section-title">ORIGINAL DEED — LEGAL DESCRIPTION (PRE-CORRECTION)</div>
                      
                      <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' }}>
                        <div className="panel-header">ORIGINAL RECORD DESCRIPTION</div>
                        <div className="panel-body font-serif" style={{ fontSize: '0.88rem', lineHeight: '1.7', padding: '24px', overflowY: 'auto' }}>
                          {(originalLegalDescription || legalDesc) ? (
                            <p style={{ textIndent: '2rem' }}>{originalLegalDescription || legalDesc}</p>
                          ) : (
                            <p className="no-description" style={{ fontSize: '0.8rem', textAlign: 'center', marginTop: '2rem' }}>
                              [No original legal description available.]
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Bottom section with Page Notes and Title Block */}
                      <div style={{ display: 'flex', gap: '12px', height: '150px', flexShrink: 0, marginTop: '12px' }}>
                        
                        {/* Left side: Notes and Page Info */}
                        <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '8px' }}>
                          <div className="panel-header" style={{ margin: '-8px -8px 8px -8px' }}>SHEET NOTES</div>
                          <div style={{ fontSize: '0.65rem', color: '#333333', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'center' }}>
                            <div>1. This page contains the original deed legal description as extracted prior to AI-assisted repair.</div>
                            <div>2. Refer to Page 4 for the corrected metes & bounds legal description after traverse closure repair.</div>
                            <div style={{ borderTop: '0.5px solid #ccc', paddingTop: '4px', marginTop: '4px', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                              <span>SHEET IDENTIFIER: ORIGINAL LEGAL DESC</span>
                              <span>PAGE 2 OF 5</span>
                            </div>
                          </div>
                        </div>
                        
                        {/* Right side: Title Block */}
                        <div style={{ width: '420px', flexShrink: 0 }}>
                          {renderTitleBlock()}
                        </div>

                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* SHEET 3: Line & Curve Tables */}
              <div className={`blueprint-sheet page-break ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
                <div className="blueprint-border-outer">
                  <div className="blueprint-border-inner">
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div className="blueprint-section-title">SURVEY COMPILATION — LINE AND CURVE DATA TABLES</div>
                      
                      {/* Tables area occupies upper space */}
                      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', minHeight: 0, overflow: 'hidden' }}>
                        {/* Left Side: Line Table */}
                        <div style={{ border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
                          <div className="panel-header">LINE TABLE</div>
                          <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
                            {linesList.length > 0 ? (
                              <table className="survey-table" style={{ fontSize: '0.78rem' }}>
                                <thead>
                                  <tr><th>ID</th><th>BEARING</th><th>DISTANCE</th></tr>
                                </thead>
                                <tbody>
                                  {linesList.map(line => (
                                    <tr key={line.id}>
                                      <td className="bold" style={{ fontSize: '0.78rem' }}>{line.id}</td>
                                      <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.78rem' }}>{line.bearing}</td>
                                      <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.78rem', color: line.assumedZeroLength ? '#ef4444' : 'inherit', fontWeight: line.assumedZeroLength ? 'bold' : 'normal' }}>
                                        {line.distance !== '—' ? `${line.distance}${line.assumedZeroLength ? '*' : ''}'` : '—'}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <p style={{ fontSize: '0.75rem', color: '#666', fontStyle: 'italic', textAlign: 'center', marginTop: '2rem' }}>No Line Data Available</p>
                            )}
                          </div>
                        </div>

                        {/* Right Side: Curve Table */}
                        <div style={{ border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
                          <div className="panel-header">CURVE TABLE</div>
                          <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
                            {curvesList.length > 0 ? (
                              <table className="survey-table" style={{ fontSize: '0.72rem' }}>
                                <thead>
                                  <tr>
                                    <th>ID</th>
                                    <th>RADIUS</th>
                                    <th>ARC LEN</th>
                                    <th>CHORD BRG</th>
                                    <th>CHORD DIST</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {curvesList.map(curve => (
                                    <tr key={curve.id}>
                                      <td className="bold" style={{ fontSize: '0.72rem' }}>{curve.id}</td>
                                      <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.72rem' }}>{curve.radius}'</td>
                                      <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.72rem', color: curve.assumedZeroLength ? '#ef4444' : 'inherit', fontWeight: curve.assumedZeroLength ? 'bold' : 'normal' }}>
                                        {curve.arcLength !== '—' ? `${curve.arcLength}${curve.assumedZeroLength ? '*' : ''}'` : '—'}
                                      </td>
                                      <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.68rem' }}>{curve.chordBearing}</td>
                                      <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.72rem', color: curve.assumedZeroLength ? '#ef4444' : 'inherit', fontWeight: curve.assumedZeroLength ? 'bold' : 'normal' }}>
                                        {curve.chordDistance !== '—' ? `${curve.chordDistance}${curve.assumedZeroLength ? '*' : ''}'` : '—'}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <p style={{ fontSize: '0.75rem', color: '#666', fontStyle: 'italic', textAlign: 'center', marginTop: '2rem' }}>No Curve Data Available</p>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Bottom section with Page Notes and Title Block */}
                      <div style={{ display: 'flex', gap: '12px', height: '150px', flexShrink: 0, marginTop: '12px' }}>
                        
                        {/* Left side: Notes and Page Info */}
                        <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '8px' }}>
                          <div className="panel-header" style={{ margin: '-8px -8px 8px -8px' }}>DATA TABLE METADATA</div>
                          <div style={{ fontSize: '0.65rem', color: '#333333', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'center' }}>
                            <div>1. Line and curve identifiers match corresponding labels shown on sheet 1.</div>
                            <div>2. Distances and radii are shown in standard survey {units.toLowerCase()}.</div>
                            {courses.some(c => c.assumedZeroLength) && (
                              <div style={{ color: '#ef4444', fontWeight: 'bold' }}>* Assumed segment length (0-length course replaced with 10.0 {units.toLowerCase()} for sketch consistency).</div>
                            )}
                            <div style={{ borderTop: '0.5px solid #ccc', paddingTop: '4px', marginTop: '4px', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                              <span>SHEET IDENTIFIER: COGO TABLES</span>
                              <span>PAGE 3 OF 5</span>
                            </div>
                          </div>
                        </div>
                        
                        {/* Right side: Title Block */}
                        <div style={{ width: '420px', flexShrink: 0 }}>
                          {renderTitleBlock()}
                        </div>

                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* SHEET 4: Corrected Legal Description */}
              <div className={`blueprint-sheet page-break ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
                <div className="blueprint-border-outer">
                  <div className="blueprint-border-inner">
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div className="blueprint-section-title">METES & BOUNDS LEGAL DESCRIPTION</div>
                      
                      <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' }}>
                        <div className="panel-header">CORRECTED RECORD DESCRIPTION</div>
                        <div className="panel-body font-serif" style={{ fontSize: '0.88rem', lineHeight: '1.7', padding: '24px', overflowY: 'auto' }}>
                          {legalDesc ? (
                            <p style={{ textIndent: '2rem' }}>{legalDesc}</p>
                          ) : (
                            <p className="no-description" style={{ fontSize: '0.8rem', textAlign: 'center', marginTop: '2rem' }}>
                              [No legal description provided. Click "Auto-Write" in the sidebar editor to generate a professional metes & bounds legal description dynamically.]
                            </p>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '12px', height: '150px', flexShrink: 0, marginTop: '12px' }}>
                        <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '8px' }}>
                          <div className="panel-header" style={{ margin: '-8px -8px 8px -8px' }}>SHEET NOTES & CERTIFICATION</div>
                          <div style={{ fontSize: '0.65rem', color: '#333333', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'center' }}>
                            <div>1. This legal description represents a mathematical compilation of recorded deed and plat data.</div>
                            <div>2. All coordinate geometry (COGO) calculations computed using standard traverse adjustments.</div>
                            <div style={{ borderTop: '0.5px solid #ccc', paddingTop: '4px', marginTop: '4px', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                              <span>SHEET IDENTIFIER: METES & BOUNDS DESC</span>
                              <span>PAGE 4 OF 5</span>
                            </div>
                          </div>
                        </div>
                        <div style={{ width: '420px', flexShrink: 0 }}>
                          {renderTitleBlock()}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

                {/* SHEET 5: Original Uncorrected Sketch */}
                <div className={`blueprint-sheet page-break ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
                  <div className="blueprint-border-outer">
                    <div className="blueprint-border-inner">
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div className="blueprint-section-title">ORIGINAL DEED — UNCORRECTED BOUNDARY SKETCH</div>
                        
                        <div style={{ flex: 1, minHeight: 0, position: 'relative', border: '1.5px solid #000000', boxSizing: 'border-box', marginBottom: '12px' }}>
                          <canvas ref={setOriginalCanvasElement} className="blueprint-canvas-element" style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }} />
                        </div>

                        <div style={{ display: 'flex', gap: '12px', height: '150px', flexShrink: 0 }}>
                          <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '8px' }}>
                            <div className="panel-header" style={{ margin: '-8px -8px 8px -8px' }}>ORIGINAL SKETCH NOTES</div>
                            <div style={{ fontSize: '0.65rem', color: '#333333', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'center' }}>
                              <div>1. This sketch represents the original boundary geometry as extracted from the deed prior to any AI-assisted corrections.</div>
                              <div>2. Dashed lines indicate uncorrected traverse — compare with the corrected solid-line sketch on Page 1.</div>
                              <div>3. Closure errors and self-intersections (bow-ties) may be present in this original geometry.</div>
                              <div style={{ borderTop: '0.5px solid #ccc', paddingTop: '4px', marginTop: '4px', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                                <span>SHEET IDENTIFIER: UNCORRECTED SKETCH</span>
                                <span>PAGE 5 OF 5</span>
                              </div>
                            </div>
                          </div>
                          <div style={{ width: '420px', flexShrink: 0 }}>
                            {renderTitleBlock()}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : conceptualAnalysis ? (
              <>
                {/* CONCEPTUAL SHEET 1: Conceptual Sketch Map */}
                <div className={`blueprint-sheet ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
                  <div className="blueprint-border-outer">
                    <div className="blueprint-border-inner">
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div className="blueprint-section-title">CONCEPTUAL PLAT SKETCH MAP</div>
                        
                        {/* Map occupies upper space */}
                        <div style={{ flex: 1, minHeight: 0, position: 'relative', border: '1.5px solid #000000', boxSizing: 'border-box', marginBottom: '12px' }}>
                          <canvas ref={setPrintCanvasElement} className="blueprint-canvas-element" style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }} />
                        </div>

                        {/* Footer with Title Block and Conceptual Summary */}
                        <div style={{ display: 'flex', gap: '12px', height: '150px', flexShrink: 0 }}>
                          
                          {/* Conceptual Summary Box */}
                          <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
                            <div className="panel-header">CONCEPTUAL ANALYSIS SUMMARY</div>
                            <div style={{ padding: '8px', fontSize: '0.65rem', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, overflowY: 'auto' }}>
                              <div><strong>Parent Tract Estimate:</strong> {conceptualAnalysis.ParentTractSizeEstimate || conceptualAnalysis.parentTractSizeEstimate || 'unknown'}</div>
                              <div><strong>Standard Lot Size:</strong> {conceptualAnalysis.LotSizeEstimate || conceptualAnalysis.lotSizeEstimate || '0.15 acres'}</div>
                              <div style={{ fontStyle: 'italic', borderTop: '0.5px solid #ccc', paddingTop: '4px', marginTop: '4px' }}>
                                {conceptualAnalysis.RelativeComparison || conceptualAnalysis.relativeComparison}
                              </div>
                            </div>
                          </div>

                          {/* Title Block */}
                          <div style={{ width: '420px', flexShrink: 0 }}>
                            {renderTitleBlock()}
                          </div>

                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* CONCEPTUAL SHEET 2: Legal Description */}
                <div className={`blueprint-sheet page-break ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
                  <div className="blueprint-border-outer">
                    <div className="blueprint-border-inner">
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div className="blueprint-section-title">METES & BOUNDS LEGAL DESCRIPTION</div>
                        
                        {/* Legal description box expands to fill space above the footer */}
                        <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' }}>
                          <div className="panel-header">RECORD DESCRIPTION</div>
                          <div className="panel-body font-serif" style={{ fontSize: '0.88rem', lineHeight: '1.7', padding: '24px', overflowY: 'auto' }}>
                            {legalDesc ? (
                              <p style={{ textIndent: '2rem' }}>{legalDesc}</p>
                            ) : (
                              <p className="no-description" style={{ fontSize: '0.8rem', textAlign: 'center', marginTop: '2rem' }}>
                                [No legal description provided.]
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Bottom section with Page Notes and Title Block */}
                        <div style={{ display: 'flex', gap: '12px', height: '150px', flexShrink: 0, marginTop: '12px' }}>
                          
                          {/* Left side: Notes and Page Info */}
                          <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '8px' }}>
                            <div className="panel-header" style={{ margin: '-8px -8px 8px -8px' }}>SHEET NOTES & CERTIFICATION</div>
                            <div style={{ fontSize: '0.65rem', color: '#333333', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'center' }}>
                              <div>1. This legal description represents a mathematical compilation of recorded deed and plat data.</div>
                              <div>2. No mathematical boundary traverse could be computed due to reference to recorded plat.</div>
                              <div style={{ borderTop: '0.5px solid #ccc', paddingTop: '4px', marginTop: '4px', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                                <span>SHEET IDENTIFIER: RECORD LEGAL DESCRIPTION</span>
                                <span>PAGE 2 OF 3</span>
                              </div>
                            </div>
                          </div>
                          
                          {/* Right side: Title Block */}
                          <div style={{ width: '420px', flexShrink: 0 }}>
                            {renderTitleBlock()}
                          </div>

                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* CONCEPTUAL SHEET 3: Conceptual Lot & Block Analysis */}
                <div className={`blueprint-sheet page-break ${!showGrid ? 'hide-grid' : ''} ${blueprintTheme ? 'theme-blueprint' : ''}`}>
                  <div className="blueprint-border-outer">
                    <div className="blueprint-border-inner">
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div className="blueprint-section-title">CONCEPTUAL LOT & BLOCK ANALYSIS</div>
                        
                        {/* Analysis box expands to fill space above the footer */}
                        <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' }}>
                          <div className="panel-header">LOT & BLOCK ASSUMPTIONS & COMPARATIVE ANALYSIS</div>
                          <div style={{ flex: 1, padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', background: '#f8fafc', color: '#000000' }}>
                            
                            <div>
                              <div style={{ fontWeight: 700, fontSize: '0.82rem', color: '#1a365d', borderBottom: '1.5px solid #cbd5e1', paddingBottom: '3px', textTransform: 'uppercase', marginBottom: '6px' }}>
                                Deed Summary & Interpretation
                              </div>
                              <p style={{ fontSize: '0.8rem', lineHeight: 1.5, color: '#334155', margin: 0, fontFamily: 'sans-serif' }}>
                                {conceptualAnalysis.Description || conceptualAnalysis.description}
                              </p>
                            </div>
                            
                            <div style={{ marginTop: '4px' }}>
                              <div style={{ fontWeight: 700, fontSize: '0.82rem', color: '#1a365d', borderBottom: '1.5px solid #cbd5e1', paddingBottom: '3px', textTransform: 'uppercase', marginBottom: '6px' }}>
                                1. General Assumptions for Lot & Block Sizes
                              </div>
                              <div style={{ fontSize: '0.78rem', lineHeight: 1.45, color: '#334155', display: 'flex', flexDirection: 'column', gap: '6px', fontFamily: 'sans-serif' }}>
                                <p style={{ margin: '0 0 6px 0' }}>
                                  When a deed does not explicitly state dimensions or acreage and instead refers to a subdivision Plat (e.g., "Lot X, Block Y of Subdivision Z"), surveyors and database systems use the following size assumptions:
                                </p>
                                <div>
                                  <strong>Subdivision Lots (Residential):</strong> Standard modern residential lots (like Lot 107 of Westwood Estates mentioned in the deed) typically range between 0.10 to 0.25 acres (approx. 4,350 to 10,000 sq. ft.). A common standard is 0.15 acres (e.g., a 60' × 110' lot, or 6,600 sq. ft.).
                                </div>
                                <div>
                                  <strong>Subdivision Tracts / Blocks (Commercial/Industrial):</strong> "Tracts" or "Blocks" inside replats (like Tract 1 of Peninsular Life Insurance Company's Replat) are generally much larger parcels set aside for commercial use, parks, or future subdivision. These typically range from 1.0 to 5.0+ acres.
                                </div>
                                <div>
                                  <strong>Government Lots:</strong> Fractional sections of land along section boundaries, water bodies, or correction lines (like Government Lot 7 and Government Lot 2) are typically larger parcels ranging from 10 to 50 acres.
                                </div>
                              </div>
                            </div>

                            <div style={{ marginTop: '8px' }}>
                              <div style={{ fontWeight: 700, fontSize: '0.82rem', color: '#1a365d', borderBottom: '1.5px solid #cbd5e1', paddingBottom: '3px', textTransform: 'uppercase', marginBottom: '6px' }}>
                                2. Relative Size Breakdown for the Provided Deed Example
                              </div>
                              <p style={{ fontSize: '0.78rem', color: '#334155', margin: '0 0 6px 0', fontFamily: 'sans-serif' }}>
                                Using the specific dimensions and descriptions given in the image, we can estimate and compare the relative sizes of the properties in question:
                              </p>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', fontSize: '0.76rem', fontFamily: 'sans-serif', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '10px' }}>
                                <div>
                                  <strong style={{ color: '#475569', fontSize: '0.68rem', textTransform: 'uppercase' }}>Parent Tract Size Estimate:</strong>
                                  <div style={{ fontSize: '0.9rem', fontWeight: 700, fontFamily: 'monospace', marginTop: '2px', color: '#0f172a' }}>
                                    {conceptualAnalysis.ParentTractSizeEstimate || conceptualAnalysis.parentTractSizeEstimate || 'unknown'}
                                  </div>
                                </div>
                                <div>
                                  <strong style={{ color: '#475569', fontSize: '0.68rem', textTransform: 'uppercase' }}>Standard Lot Size Estimate:</strong>
                                  <div style={{ fontSize: '0.9rem', fontWeight: 700, fontFamily: 'monospace', marginTop: '2px', color: '#0f172a' }}>
                                    {conceptualAnalysis.LotSizeEstimate || conceptualAnalysis.lotSizeEstimate || '0.15 acres'}
                                  </div>
                                </div>
                              </div>
                              <div style={{ fontSize: '0.76rem', color: '#0f172a', fontStyle: 'italic', marginTop: '6px', borderTop: '0.5px solid #e2e8f0', paddingTop: '6px', fontFamily: 'sans-serif', lineHeight: 1.45 }}>
                                {conceptualAnalysis.RelativeComparison || conceptualAnalysis.relativeComparison}
                              </div>
                            </div>

                          </div>
                        </div>

                        {/* Bottom section with Page Notes and Title Block */}
                        <div style={{ display: 'flex', gap: '12px', height: '150px', flexShrink: 0, marginTop: '12px' }}>
                          
                          {/* Left side: Notes and Page Info */}
                          <div style={{ flex: 1, border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '8px' }}>
                            <div className="panel-header" style={{ margin: '-8px -8px 8px -8px' }}>CONCEPTUAL SHEET NOTES</div>
                            <div style={{ fontSize: '0.65rem', color: '#333333', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'center' }}>
                              <div>1. This analysis provides a conceptual representation based on standard lot, block, and tract guidelines.</div>
                              <div>2. True dimensions and boundaries require a professional land survey of the referenced plat map.</div>
                              <div style={{ borderTop: '0.5px solid #ccc', paddingTop: '4px', marginTop: '4px', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                                <span>SHEET IDENTIFIER: CONCEPTUAL ANALYSIS</span>
                                <span>PAGE 3 OF 3</span>
                              </div>
                            </div>
                          </div>
                          
                          {/* Right side: Title Block */}
                          <div style={{ width: '420px', flexShrink: 0 }}>
                            {renderTitleBlock()}
                          </div>

                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
