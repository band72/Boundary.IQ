import { useState, useEffect } from 'react';
import { resolveLabels, getLeaderIntersection } from '../utils/labelLayout';

const PAD = 50;

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

function getDensePoints(pts, coursesList) {
  if (!pts || pts.length === 0) return pts;
  if (!coursesList || coursesList.length === 0) return pts;
  const dense = [];
  dense.push(pts[0]);
  for (let i = 0; i < coursesList.length; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1] || pts[0];
    const c = coursesList[i];
    if (p1 && p2 && c && (c.type?.toLowerCase() === 'curve' || c.Type?.toLowerCase() === 'curve')) {
      const curvePts = getCurvePoints(p1, p2, c, 20);
      for (let j = 1; j < curvePts.length; j++) {
        dense.push(curvePts[j]);
      }
    } else if (p2) {
      dense.push(p2);
    }
  }
  return dense;
}

function parseDmsToDecimal(dms) {
  if (dms == null) return 0;
  const clean = dms.toString().trim();
  const match = clean.match(/^(-?\d+(?:\.\d+)?)\s*[°º\*^d]?$/)
    || clean.match(/^(-?\d+)\s*[°º\*^d]?\s*(\d+)\s*['’‘`]?\s*(\d+(?:\.\d+)?)\s*["”“']{0,2}$/)
    || clean.match(/^(-?\d+)\s*[°º\*^d]?\s*(\d+(?:\.\d+)?)\s*['’‘`]?$/);

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
  const clean = b.toUpperCase().trim().replace(/[^0-9NSEW°'"\-\.\s]/g, '');
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

export default function TraverseMap({ stations, adjusted, courses, pob }) {
  const [canvasElement, setCanvasElement] = useState(null);
  
  const getPts = () => {
    if (adjusted?.length) return adjusted;
    if (stations?.length) return stations.map(s => ({ northing: s.northing, easting: s.easting }));
    if (courses?.length) return computePointsFromCourses(courses, pob);
    return [];
  };

  const pts = getPts();

  useEffect(() => {
    if (!canvasElement || !pts || pts.length < 2) return;
    const canvas = canvasElement;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // Compute bounds
    const ns = pts.map(p => p.northing), es = pts.map(p => p.easting);
    const minN = Math.min(...ns), maxN = Math.max(...ns);
    const minE = Math.min(...es), maxE = Math.max(...es);
    const rangeN = maxN - minN || 1, rangeE = maxE - minE || 1;

    const scaleX = (W - PAD * 2) / rangeE;
    const scaleY = (H - PAD * 2) / rangeN;
    const scale = Math.min(scaleX, scaleY);

    const tx = e => PAD + (e - minE) * scale;
    const ty = n => H - PAD - (n - minN) * scale;

    // Grid lines (Surveyor Draft grid)
    ctx.strokeStyle = 'rgba(31, 46, 77, 0.4)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const x = PAD + i * (W - PAD * 2) / 5;
      const y = PAD + i * (H - PAD * 2) / 5;
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    }

    const densePts = getDensePoints(pts, courses);

    // Fill polygon interior
    ctx.beginPath();
    ctx.moveTo(tx(densePts[0].easting), ty(densePts[0].northing));
    for (let i = 1; i < densePts.length; i++) ctx.lineTo(tx(densePts[i].easting), ty(densePts[i].northing));
    ctx.closePath();
    ctx.fillStyle = 'rgba(61,127,255,0.06)';
    ctx.fill();

    // Draw boundary lines
    ctx.strokeStyle = '#3d7fff';
    ctx.lineWidth = 2.5;
    ctx.moveTo(tx(densePts[0].easting), ty(densePts[0].northing));
    for (let i = 1; i < densePts.length; i++) ctx.lineTo(tx(densePts[i].easting), ty(densePts[i].northing));
    ctx.closePath();
    ctx.stroke();

    const leaderStyle = localStorage.getItem('boundaryiq_leader_style') || 'arc';
    const labelContentMode = localStorage.getItem('boundaryiq_label_content_mode') || 'auto';

    // Compute resolved non-overlapping positions for labels
    const resolvedPoints = pts.map(p => ({ x: tx(p.easting), y: ty(p.northing) }));
    const resolvedLabels = resolveLabels(ctx, resolvedPoints, courses, W, H, {
      stationFont: 'bold 10px Inter, sans-serif',
      segmentFont: 'bold 9px "JetBrains Mono", monospace',
      stationPadding: 3,
      segmentPaddingX: 4,
      segmentPaddingY: 2,
      vertexRadius: 4.5,
      showStations: pts.length <= 30,
      showSegments: true,
      showConceptualDetail: false,
      leaderStyle,
      labelContentMode
    });

    // Visual Error / Misclosure gap dashed red line
    const last = pts[pts.length - 1];
    const first = pts[0];
    const closeGap = Math.hypot(last.northing - first.northing, last.easting - first.easting);
    if (closeGap > 0.05) {
      const xLast = tx(last.easting), yLast = ty(last.northing);
      const xFirst = tx(first.easting), yFirst = ty(first.northing);

      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 1.5;
      ctx.moveTo(xLast, yLast);
      ctx.lineTo(xFirst, yFirst);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label the misclosure line
      ctx.fillStyle = '#ff4d6d';
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`Misclosure: ${closeGap.toFixed(2)} ft`, Math.max(10, Math.min(xLast, xFirst) + 5), Math.max(10, Math.min(yLast, yFirst) - 5));
    }

    // Draw station nodes
    pts.forEach((p, i) => {
      const px = tx(p.easting), py = ty(p.northing);
      ctx.beginPath();
      ctx.arc(px, py, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#00d4a8' : '#3d7fff';
      ctx.fill();
      ctx.strokeStyle = '#090e1a';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    });

    // Draw all resolved labels (both stations and segments resolved without overlaps)
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
          ctx.strokeStyle = 'rgba(168, 196, 255, 0.6)';
          ctx.lineWidth = 0.8;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(lbl.anchorX, lbl.anchorY, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(168, 196, 255, 0.6)';
          ctx.fill();

          ctx.save();
          ctx.font = 'bold 10px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(9, 14, 26, 0.85)';
          ctx.strokeStyle = 'rgba(168, 196, 255, 0.4)';
          ctx.lineWidth = 0.8;
          const rx = lbl.x - lbl.width / 2;
          const ry = lbl.y - lbl.height / 2;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(rx, ry, lbl.width, lbl.height, 2);
          else ctx.rect(rx, ry, lbl.width, lbl.height);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = lbl.text === 'POB' ? '#00d4a8' : '#ffffff';
          ctx.fillText(lbl.text, lbl.x, lbl.y);
          ctx.restore();
        } else {
          ctx.save();
          ctx.font = 'bold 10px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.strokeStyle = 'rgba(9, 14, 26, 0.85)';
          ctx.lineWidth = 2.5;
          ctx.strokeText(lbl.text, lbl.x, lbl.y);
          ctx.fillStyle = lbl.text === 'POB' ? '#00d4a8' : '#ffffff';
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
          ctx.strokeStyle = 'rgba(168, 196, 255, 0.6)';
          ctx.lineWidth = 0.8;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(lbl.anchorX, lbl.anchorY, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(168, 196, 255, 0.6)';
          ctx.fill();
        }

        ctx.save();
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(lbl.x, lbl.y);
        if (lbl.rotated) {
          ctx.rotate(lbl.angle);
        }

        ctx.fillStyle = 'rgba(9, 14, 26, 0.85)';
        ctx.strokeStyle = lbl.isCurve ? 'rgba(255, 159, 67, 0.7)' : 'rgba(168, 196, 255, 0.7)';
        ctx.lineWidth = 1;

        const rx = -lbl.width / 2;
        const ry = -lbl.height / 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(rx, ry, lbl.width, lbl.height, 3);
        else ctx.rect(rx, ry, lbl.width, lbl.height);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = lbl.isCurve ? '#ff9f43' : '#a8c4ff';
        ctx.fillText(lbl.text, 0, 0);
        ctx.restore();
      }
    });


    // North arrow graphic
    ctx.save();
    ctx.translate(W - 35, 55);
    ctx.fillStyle = '#3d7fff';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -18);
    ctx.beginPath(); 
    ctx.moveTo(0, -15); 
    ctx.lineTo(4.5, 0); 
    ctx.lineTo(0, -4); 
    ctx.lineTo(-4.5, 0); 
    ctx.closePath();
    ctx.fill();
    ctx.restore();

  }, [canvasElement, pts, courses]);

  const getTablesData = () => {
    const linesList = [];
    const curvesList = [];
    if (!courses) return { lines: linesList, curves: curvesList };

    let lineIndex = 1;
    let curveIndex = 1;
    let prevAzimuthDeg = null;

    courses.forEach(c => {
      const isCurve = (c.type || '').toLowerCase() === 'curve';
      if (isCurve) {
        const resolvedCurve = resolveCurvePropertiesClient(c, prevAzimuthDeg);
        
        if (resolvedCurve.radius === null && resolvedCurve.arcLength === null && resolvedCurve.chordDistance === null) {
          return;
        }

        curvesList.push({
          tag: `C${curveIndex++}`,
          radius: resolvedCurve.radius != null ? `${resolvedCurve.radius.toFixed(2)}'` : '-',
          arcLength: resolvedCurve.arcLength != null ? `${resolvedCurve.arcLength.toFixed(2)}'` : '-',
          chordBearing: resolvedCurve.chordBearing || '-',
          chordDistance: resolvedCurve.chordDistance != null ? `${resolvedCurve.chordDistance.toFixed(2)}'` : '-',
          delta: resolvedCurve.delta != null ? `${resolvedCurve.delta.toFixed(4)}°` : '-'
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
        let dist = parseFloat(c.distance ?? 0);
        if (dist <= 0) return;

        const bearingStr = c.bearing || '';
        const parsed = parseBearingToDegrees(bearingStr);
        if (parsed !== null) {
          prevAzimuthDeg = parsed;
        }

        linesList.push({
          tag: `L${lineIndex++}`,
          bearing: c.bearing || '-',
          distance: c.distance != null && c.distance !== '' ? `${parseFloat(c.distance).toFixed(2)}'` : '-'
        });
      }
    });

    return { lines: linesList, curves: curvesList };
  };

  const { lines, curves } = getTablesData();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="map-container" style={{ height: 340 }}>
        <canvas ref={setCanvasElement} className="map-canvas" width={700} height={340} />
        <div className="map-legend">
          <span style={{ color: 'var(--success)', fontWeight: 600 }}>● POB</span>
          {'  '}
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>● Station</span>
          {'  '}
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>- - Misclosure Error</span>
        </div>
      </div>

      {(lines.length > 0 || curves.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
          {lines.length > 0 && (
            <div className="card" style={{ padding: '1.25rem', border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.75rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                📐 Line Table
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '50px' }}>Tag</th>
                      <th>Bearing</th>
                      <th>Distance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, idx) => (
                      <tr key={idx}>
                        <td style={{ fontWeight: 'bold', color: 'var(--accent)' }}>{l.tag}</td>
                        <td>{l.bearing}</td>
                        <td>{l.distance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {curves.length > 0 && (
            <div className="card" style={{ padding: '1.25rem', border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.75rem', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                🍊 Curve Table
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '50px' }}>Tag</th>
                      <th>Radius</th>
                      <th>Length</th>
                      <th>Chord Brg</th>
                      <th>Chord Dist</th>
                    </tr>
                  </thead>
                  <tbody>
                    {curves.map((c, idx) => (
                      <tr key={idx}>
                        <td style={{ fontWeight: 'bold', color: 'var(--warning)' }}>{c.tag}</td>
                        <td>{c.radius}</td>
                        <td>{c.arcLength}</td>
                        <td>{c.chordBearing}</td>
                        <td>{c.chordDistance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
