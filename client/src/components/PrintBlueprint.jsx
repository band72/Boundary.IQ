import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const API = 'http://localhost:5050/api';
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

export default function PrintBlueprint({
  courses = [],
  stations = [],
  adjusted = [],
  units = 'Feet',
  area = 0,
  perimeter = 0,
  pob = { northing: 5000, easting: 5000 },
  initialLegalDescription = '',
  onClose
}) {
  const [canvasElement, setCanvasElement] = useState(null);
  const [printCanvasElement, setPrintCanvasElement] = useState(null);
  
  // Title block metadata state
  const [county, setCounty] = useState('');
  const [stateVal, setStateVal] = useState('');
  const [parcel, setParcel] = useState('');
  const [client, setClient] = useState('');
  const [basisBrg, setBasisBrg] = useState('DEED OF RECORD');
  const [legalDesc, setLegalDesc] = useState(initialLegalDescription);
  
  // Customizer options
  const [showGrid, setShowGrid] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showRaw, setShowRaw] = useState(true);
  const [showAdjusted, setShowAdjusted] = useState(true);
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

      const res = await fetch(`${API}/writer/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setLegalDesc(data.legalDescription ?? data.LegalDescription ?? '');
      }
    } catch (e) {
      console.error('Failed to generate legal description:', e);
    } finally {
      setLoadingLegal(false);
    }
  };

  // Generate lists of Lines and Curves for the tables
  const linesList = [];
  const curvesList = [];
  
  courses.forEach((c, idx) => {
    if (c.type === 'Curve') {
      curvesList.push({
        id: `C${curvesList.length + 1}`,
        idx,
        radius: c.radius || '—',
        delta: c.delta || '—',
        arcLength: c.arcLength || '—',
        chordBearing: c.chordBearing || '—',
        chordDistance: c.chordDistance || '—',
      });
    } else {
      linesList.push({
        id: `L${linesList.length + 1}`,
        idx,
        bearing: c.bearing || '—',
        distance: c.distance || '—',
      });
    }
  });

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
  useEffect(() => {
    const draw = (canvas) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');

      const W = 720;
      const H = 480;
      canvas.width = W * 2;
      canvas.height = H * 2;
      ctx.scale(2, 2);

      // White blueprint background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // Map drawing points selection
      const rawPts = stations?.length 
        ? (stations.map(s => ({ northing: s.northing, easting: s.easting })) || [])
        : (courses?.length ? computePointsFromCourses(courses, pob) : []);
      const adjPts = adjusted?.length ? adjusted : rawPts;
      
      if (rawPts.length < 2) return;

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
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(5, 5, W - 10, H - 10);
      ctx.lineWidth = 0.5;
      ctx.strokeRect(8, 8, W - 16, H - 16);

      // 1. Grid Lines
      if (showGrid) {
        ctx.strokeStyle = 'rgba(0,0,0,0.06)';
        ctx.lineWidth = 0.5;
        const step = 60;
        for (let x = step; x < W; x += step) {
          ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, H - 10); ctx.stroke();
        }
        for (let y = step; y < H; y += step) {
          ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(W - 10, y); ctx.stroke();
        }
      }

      // 2. Draw Raw (Unadjusted) Boundary (if requested and exists)
      if (showRaw && rawPts.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = '#e63946'; // Surveyor red for raw
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 4]);
        ctx.moveTo(tx(rawPts[0].easting), ty(rawPts[0].northing));
        for (let i = 1; i < rawPts.length; i++) {
          ctx.lineTo(tx(rawPts[i].easting), ty(rawPts[i].northing));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 3. Draw Adjusted Boundary (Solid Black)
      if (showAdjusted && adjPts.length > 1) {
        // Draw closed shaded polygon first
        ctx.beginPath();
        ctx.moveTo(tx(adjPts[0].easting), ty(adjPts[0].northing));
        for (let i = 1; i < adjPts.length; i++) {
          ctx.lineTo(tx(adjPts[i].easting), ty(adjPts[i].northing));
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.03)';
        ctx.fill();

        // Draw boundary line stroke
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

      // 4. Draw Stations and Course Labels (L1, C1...)
      const labeledPts = showAdjusted ? adjPts : rawPts;
      labeledPts.forEach((p, i) => {
        const x = tx(p.easting), y = ty(p.northing);
        
        // Node marker
        ctx.beginPath();
        ctx.arc(x, y, i === 0 ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#000000' : '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();

        // Vertex Number / Label
        if (labeledPts.length <= 35) {
          ctx.fillStyle = '#000000';
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          ctx.fillText(i === 0 ? 'POB' : `${i}`, x + 6, y - 4);
        }
      });

      // 5. Draw Segment Labels next to lines (L1, L2, C1...)
      if (showLabels && courses.length > 0) {
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 9px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        courses.forEach((c, i) => {
          const p1 = labeledPts[i];
          const p2 = labeledPts[i + 1] || labeledPts[0];
          if (!p1 || !p2) return;

          // Find midpoint
          const mx = (tx(p1.easting) + tx(p2.easting)) / 2;
          const my = (ty(p1.northing) + ty(p2.northing)) / 2;

          // Calculate perpendicular offset
          const cdx = tx(p2.easting) - tx(p1.easting);
          const cdy = ty(p2.northing) - ty(p1.northing);
          const clen = Math.hypot(cdx, cdy) || 1;
          const cpx = -cdy / clen;
          const cpy = cdx / clen;

          // Find matching label ID
          let labelId = '';
          if (c.type === 'Curve') {
            const cMatch = curvesList.find(item => item.idx === i);
            labelId = cMatch ? cMatch.id : '';
          } else {
            const lMatch = linesList.find(item => item.idx === i);
            labelId = lMatch ? lMatch.id : '';
          }

          if (labelId) {
            // Offset text by 12 pixels perpendicular
            const lx = mx + cpx * 12;
            const ly = my + cpy * 12;

            // Draw small white badge behind label for legibility if grid is enabled
            ctx.save();
            ctx.fillStyle = '#ffffff';
            const txtWidth = ctx.measureText(labelId).width;
            ctx.fillRect(lx - txtWidth / 2 - 2, ly - 6, txtWidth + 4, 12);
            ctx.restore();

            ctx.fillStyle = '#000000';
            ctx.fillText(labelId, lx, ly);
          }
        });
      }

      // 6. Draw North Arrow
      ctx.save();
      ctx.translate(W - 45, 45);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 15px "Inter", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('N', 0, -22);

      // Right half (solid black)
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(7, 8);
      ctx.lineTo(0, 1);
      ctx.closePath();
      ctx.fill();

      // Left half (white/hollow)
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(-7, 8);
      ctx.lineTo(0, 1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Vertical line
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

      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.25;

      // Segment 1 (solid black)
      ctx.fillStyle = '#000000';
      ctx.fillRect(bx, by, wHalf, bh);
      ctx.strokeRect(bx, by, wHalf, bh);

      // Segment 2 (white/hollow)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx + wHalf, by, wHalf, bh);
      ctx.strokeRect(bx + wHalf, by, wHalf, bh);

      // Label markings
      ctx.fillStyle = '#000000';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('0', bx, by - 4);
      ctx.fillText(`${bestD / 2}`, bx + wHalf, by - 4);
      ctx.fillText(`${bestD} ${units}`, bx + scaleBarPxWidth, by - 4);

      // Text scale description
      ctx.font = 'italic 8px "Inter", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`Scale: 1 in = ${Math.round(96 / scale)} ${units.toLowerCase()}`, bx, by + bh + 12);
      ctx.restore();
    };

    draw(canvasElement);
    draw(printCanvasElement);

  }, [canvasElement, printCanvasElement, courses, stations, adjusted, units, showGrid, showLabels, showRaw, showAdjusted]);

  const handlePrint = () => {
    window.print();
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

        <div className="sidebar-actions mt-3">
          <button className="btn btn-primary" onClick={handlePrint} style={{ width: '100%', justifyContent: 'center' }}>
            🖨 Print Sketch Sheet
          </button>
        </div>
      </div>

      {/* ── Blueprint Print Sheet View (11" x 8.5" Landscape Aspect) ──────────────── */}
      <div className="print-canvas-wrapper">
        {/* 1. Screen View & Print Single-Page (Always visible on screen, hidden during print if multi-page mode is active) */}
        <div className="blueprint-sheet no-print">
          {/* Main double-border frame */}
          <div className="blueprint-border-outer">
            <div className="blueprint-border-inner">
              
              {/* LANDSCAPE CONTAINER */}
              <div className="blueprint-grid">
                
                {/* LEFT SIDE: Map Canvas drawing */}
                <div className="blueprint-map-column">
                  <div className="blueprint-section-title">BOUNDARY SURVEY SKETCH</div>
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

                  {/* Part 2: Dynamic Line and Curve Tables */}
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
                                <td>{line.distance}'</td>
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
                                <td>{curve.arcLength}'</td>
                                <td style={{ fontSize: '0.62rem' }}>{curve.chordBearing}</td>
                                <td>{curve.chordDistance}'</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Part 3: Professional Surveyor Title Block */}
                  {renderTitleBlock()}

                </div>

              </div>

            </div>
          </div>
        </div>

        {/* 2. Print Multi-Page (Always hidden on screen, shown only during print if multi-page mode is active) */}
        <div className="blueprint-multi-container only-print">
          {/* SHEET 1: Main Map and Title Block */}
          <div className="blueprint-sheet">
            <div className="blueprint-border-outer">
              <div className="blueprint-border-inner">
                <div className="blueprint-grid">
                  
                  {/* LEFT SIDE: Map Canvas */}
                  <div className="blueprint-map-column">
                    <div className="blueprint-section-title">BOUNDARY SURVEY SKETCH</div>
                    <canvas ref={setPrintCanvasElement} className="blueprint-canvas-element" />
                  </div>

                  {/* RIGHT SIDE: Notes and Title Block */}
                  <div className="blueprint-info-column">
                    <div className="blueprint-desc-panel" style={{ height: '320px' }}>
                      <div className="panel-header">SURVEYOR NOTES & CERTIFICATION</div>
                      <div className="panel-body" style={{ fontSize: '0.7rem', color: '#333333' }}>
                        <p style={{ fontWeight: 600, marginBottom: '0.4rem' }}>GENERAL COMPILATION NOTES:</p>
                        <ol style={{ paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.3rem', listStyleType: 'decimal' }}>
                          <li>This sketch sheet represents a mathematical compilation of recorded deed and plat data.</li>
                          <li>All coordinate geometry (COGO) calculations computed using standard traverse adjustments.</li>
                          <li>Linear closures and precision ratios are audited and verified.</li>
                          <li>No property corners have been physically set as part of this mathematical traverse compilation.</li>
                        </ol>
                        <div style={{ marginTop: '1.2rem', paddingTop: '1rem', borderTop: '0.5px dashed #000000', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <div style={{ width: '120px', height: '60px', border: '1px solid #000000', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', color: '#777777', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            SURVEYOR SEAL AREA
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {renderTitleBlock()}
                  </div>

                </div>
              </div>
            </div>
          </div>

          {/* SHEET 2: Legal Description */}
          <div className="blueprint-sheet page-break">
            <div className="blueprint-border-outer">
              <div className="blueprint-border-inner">
                <div className="blueprint-section-title" style={{ borderBottom: '2px solid #000000', paddingBottom: '8px', marginBottom: '16px' }}>
                  METES & BOUNDS LEGAL DESCRIPTION
                </div>
                <div style={{ border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', flex: 1, boxSizing: 'border-box', overflow: 'hidden' }}>
                  <div className="panel-header">RECORD DESCRIPTION</div>
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
                {/* Decorative bottom title bar */}
                <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', fontSize: '0.62rem', fontWeight: 600, borderTop: '1px solid #000000', paddingTop: '6px' }}>
                  <span>BOUNDARY.IQ PLATFORM</span>
                  <span>PAGE 2 OF 3</span>
                </div>
              </div>
            </div>
          </div>

          {/* SHEET 3: Line & Curve Tables */}
          <div className="blueprint-sheet page-break">
            <div className="blueprint-border-outer">
              <div className="blueprint-border-inner">
                <div className="blueprint-section-title" style={{ borderBottom: '2px solid #000000', paddingBottom: '8px', marginBottom: '16px' }}>
                  SURVEY COMPILATION — LINE AND CURVE DATA TABLES
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', flex: 1, overflow: 'hidden' }}>
                  {/* Left Side: Line Table */}
                  <div style={{ border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
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
                                <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.78rem' }}>{line.distance}'</td>
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
                  <div style={{ border: '1.5px solid #000000', display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
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
                                <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.72rem' }}>{curve.arcLength}'</td>
                                <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.68rem' }}>{curve.chordBearing}</td>
                                <td style={{ fontFamily: 'JetBrains Mono', fontSize: '0.72rem' }}>{curve.chordDistance}'</td>
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
                {/* Decorative bottom title bar */}
                <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', fontSize: '0.62rem', fontWeight: 600, borderTop: '1px solid #000000', paddingTop: '6px' }}>
                  <span>BOUNDARY.IQ PLATFORM</span>
                  <span>PAGE 3 OF 3</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
