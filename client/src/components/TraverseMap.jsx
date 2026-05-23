import { useState, useEffect } from 'react';

const PAD = 40;

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
    let angleRad = 0;
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

    // Grid lines
    ctx.strokeStyle = 'rgba(31,46,77,0.5)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const x = PAD + i * (W - PAD * 2) / 5;
      const y = PAD + i * (H - PAD * 2) / 5;
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    }

    // Fill polygon
    ctx.beginPath();
    ctx.moveTo(tx(pts[0].easting), ty(pts[0].northing));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i].easting), ty(pts[i].northing));
    ctx.closePath();
    ctx.fillStyle = 'rgba(61,127,255,0.07)';
    ctx.fill();

    // Draw traverse lines
    ctx.beginPath();
    ctx.strokeStyle = '#3d7fff';
    ctx.lineWidth = 2;
    ctx.moveTo(tx(pts[0].easting), ty(pts[0].northing));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i].easting), ty(pts[i].northing));
    ctx.closePath();
    ctx.stroke();

    // Closure line (if not perfectly closed)
    const last = pts[pts.length - 1];
    const first = pts[0];
    const closeGap = Math.hypot(last.northing - first.northing, last.easting - first.easting);
    if (closeGap > 0.01) {
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 1.5;
      ctx.moveTo(tx(last.easting), ty(last.northing));
      ctx.lineTo(tx(first.easting), ty(first.northing));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Points
    pts.forEach((p, i) => {
      const x = tx(p.easting), y = ty(p.northing);
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#00d4a8' : '#3d7fff';
      ctx.fill();
      ctx.strokeStyle = '#090e1a';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Labels
      if (pts.length <= 20) {
        ctx.fillStyle = i === 0 ? '#00d4a8' : '#a8c4ff';
        ctx.font = '11px JetBrains Mono, monospace';
        ctx.fillText(i === 0 ? 'POB' : `${i}`, x + 7, y - 5);
      }
    });

    // North arrow
    ctx.save();
    ctx.translate(W - 30, 50);
    ctx.fillStyle = '#3d7fff';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -16);
    ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(4, 0); ctx.lineTo(0, -4); ctx.lineTo(-4, 0); ctx.closePath();
    ctx.fill();
    ctx.restore();

  }, [canvasElement, pts]);

  return (
    <div className="map-container" style={{ height: 340 }}>
      <canvas ref={setCanvasElement} className="map-canvas" width={700} height={340} />
      <div className="map-legend">
        <span style={{ color: 'var(--success)' }}>● POB</span>
        {'  '}
        <span style={{ color: 'var(--accent)' }}>● Station</span>
        {'  '}
        <span style={{ color: 'var(--danger)' }}>- - Error</span>
      </div>
    </div>
  );
}

