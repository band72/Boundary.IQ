import { useState, useEffect } from 'react';

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

export default function TraverseMap({ stations, adjusted, courses }) {
  const [canvasElement, setCanvasElement] = useState(null);
  
  const getPts = () => {
    if (adjusted?.length) return adjusted;
    if (stations?.length) return stations.map(s => ({ northing: s.northing, easting: s.easting }));
    if (courses?.length) return computePointsFromCourses(courses);
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

    // Fill polygon interior
    ctx.beginPath();
    ctx.moveTo(tx(pts[0].easting), ty(pts[0].northing));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i].easting), ty(pts[i].northing));
    ctx.closePath();
    ctx.fillStyle = 'rgba(61,127,255,0.06)';
    ctx.fill();

    // Draw boundary lines
    ctx.beginPath();
    ctx.strokeStyle = '#3d7fff';
    ctx.lineWidth = 2.5;
    ctx.moveTo(tx(pts[0].easting), ty(pts[0].northing));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i].easting), ty(pts[i].northing));
    ctx.closePath();
    ctx.stroke();

    // Draw visual midpoint labels aligned parallel to segments
    if (courses && courses.length > 0 && pts.length >= 2) {
      for (let i = 0; i < courses.length; i++) {
        const course = courses[i];
        const p1 = pts[i];
        const p2 = pts[i + 1] || pts[0];
        if (!p1 || !p2) continue;

        const x1 = tx(p1.easting), y1 = ty(p1.northing);
        const x2 = tx(p2.easting), y2 = ty(p2.northing);

        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;

        const isCurve = (course.type || '').toLowerCase() === 'curve';
        const distVal = course.distance ?? course.arcLength ?? course.chordDistance;
        const distStr = distVal != null ? `${distVal.toFixed(1)}'` : '';
        const rawBrg = course.bearing || course.chordBearing || '';
        const brgStr = rawBrg ? rawBrg.replace(/\s+/g, '') : '';
        const label = isCurve ? `C${i + 1} R=${course.radius || 0} L=${distStr}` : `${brgStr} ${distStr}`;

        // Compute angle of segment in canvas space
        const dx = x2 - x1;
        const dy = y2 - y1;
        let angRad = Math.atan2(dy, dx);

        // Normalize text rotation so it is never upside down
        if (angRad > Math.PI / 2) angRad -= Math.PI;
        else if (angRad < -Math.PI / 2) angRad += Math.PI;

        ctx.save();
        ctx.translate(midX, midY);
        ctx.rotate(angRad);
        
        ctx.fillStyle = isCurve ? '#ff9f43' : '#a8c4ff';
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        // Draw with small 4px perpendicular offset
        ctx.fillText(label, 0, -4);
        ctx.restore();
      }
    }

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

      // Corner point labels
      if (pts.length <= 30) {
        ctx.fillStyle = i === 0 ? '#00d4a8' : '#fff';
        ctx.font = 'bold 10px Inter, sans-serif';
        // Offset label from the node center so it doesn't clash
        ctx.fillText(i === 0 ? 'POB' : `${i}`, x + 7, y - 6);
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

  return (
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
  );
}
