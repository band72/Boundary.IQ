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
    ctx.beginPath();
    ctx.strokeStyle = '#3d7fff';
    ctx.lineWidth = 2.5;
    ctx.moveTo(tx(densePts[0].easting), ty(densePts[0].northing));
    for (let i = 1; i < densePts.length; i++) ctx.lineTo(tx(densePts[i].easting), ty(densePts[i].northing));
    ctx.closePath();
    ctx.stroke();
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
      showConceptualDetail: false
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
      ctx.fillText(`Error: ${closeGap.toFixed(3)}'`, (xLast + xFirst) / 2 + 8, (yLast + yFirst) / 2 - 4);
    }

    // Corner pin node drawing
    pts.forEach((p, i) => {
      const x = tx(p.easting), y = ty(p.northing);
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 6.5 : 4.5, 0, Math.PI * 2);
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
          ctx.lineTo(intersection.x, intersection.y);
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
          ctx.lineTo(intersection.x, intersection.y);
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

    courses.forEach(c => {
      let dist = parseFloat(c.distance ?? c.chordDistance ?? c.arcLength ?? 0);
      if (dist <= 0) return;

      const isCurve = (c.type || '').toLowerCase() === 'curve';
      if (isCurve) {
        curvesList.push({
          tag: `C${curveIndex++}`,
          radius: c.radius != null && c.radius !== '' ? `${parseFloat(c.radius).toFixed(2)}'` : '-',
          arcLength: c.arcLength != null && c.arcLength !== '' ? `${parseFloat(c.arcLength).toFixed(2)}'` : (c.distance != null && c.distance !== '' ? `${parseFloat(c.distance).toFixed(2)}'` : '-'),
          chordBearing: c.chordBearing || c.bearing || '-',
          chordDistance: c.chordDistance != null && c.chordDistance !== '' ? `${parseFloat(c.chordDistance).toFixed(2)}'` : '-',
          delta: c.delta || '-'
        });
      } else {
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
