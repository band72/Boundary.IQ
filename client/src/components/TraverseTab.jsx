import { useState, useEffect } from 'react';
import TraverseMap from './TraverseMap';
import PrintBlueprint from './PrintBlueprint';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { API } from '../config';

const BLANK_COURSE = { type: 'Line', bearing: '', distance: '', curveDirection: 'Right', delta: '', radius: '', arcLength: '', chordBearing: '', chordDistance: '' };
const EXAMPLE_COURSES = [
  { type: 'Line', bearing: "N89-50-00E", distance: '669.80' },
  { type: 'Line', bearing: "S00-35-00E", distance: '669.80' },
  { type: 'Line', bearing: "S89-50-00W", distance: '669.80' },
  { type: 'Line', bearing: "N00-35-00W", distance: '669.80' },
];

// ── Client-side mini-traverser for Typo Assist ───────────────────────────────
/** Parse bearing string like "N45-30-00E" or "N45°30'00\"E" into azimuth radians. */
function parseBearing(b) {
  if (!b) return null;
  const m = b.trim().match(/^([NSns])\s*(\d+)[°\-\s](\d+)['\'\-\s](\d+(?:\.\d+)?)["\"\s]*([EWew])/);
  if (!m) return null;
  const [, ns, deg, min, sec, ew] = m;
  const decDeg = +deg + +min / 60 + +sec / 3600;
  // Convert quadrant bearing to azimuth (0=North, clockwise)
  if (ns.toUpperCase() === 'N' && ew.toUpperCase() === 'E') return decDeg * Math.PI / 180;
  if (ns.toUpperCase() === 'S' && ew.toUpperCase() === 'E') return (180 - decDeg) * Math.PI / 180;
  if (ns.toUpperCase() === 'S' && ew.toUpperCase() === 'W') return (180 + decDeg) * Math.PI / 180;
  if (ns.toUpperCase() === 'N' && ew.toUpperCase() === 'W') return (360 - decDeg) * Math.PI / 180;
  return null;
}

/** Flip the quadrant of a bearing string: N⇔S and E⇔W. */
function flipBearing(b) {
  if (!b) return b;
  return b
    .replace(/^N/i, '_S_').replace(/^S/i, '_N_')
    .replace(/E$/i, '_W_').replace(/W$/i, '_E_')
    .replace(/_S_/, 'S').replace(/_N_/, 'N')
    .replace(/_W_/, 'W').replace(/_E_/, 'E');
}

/** Compute linear closure error (ft) for a list of courses from POB. */
function computeLinearError(courseList, pobN, pobE) {
  let n = pobN, e = pobE;
  for (const c of courseList) {
    if (c.type !== 'Line') continue;
    const az = parseBearing(c.bearing);
    if (az === null || !c.distance) continue;
    const dist = parseFloat(c.distance);
    n += dist * Math.cos(az);
    e += dist * Math.sin(az);
  }
  const errN = pobN - n, errE = pobE - e;
  return Math.sqrt(errN * errN + errE * errE);
}

export default function TraverseTab() {
  const [pob, setPob] = useLocalStorage('boundaryiq_traverse_pob', { northing: '5000.00', easting: '5000.00' });
  const [units, setUnits] = useLocalStorage('boundaryiq_traverse_units', 'Feet');
  const [courses, setCourses] = useLocalStorage('boundaryiq_traverse_courses', EXAMPLE_COURSES.map(c => ({ ...BLANK_COURSE, ...c })));
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPrint, setShowPrint] = useState(false);
  const [isOpenEnded, setIsOpenEnded] = useState(false);
  const [typoHint, setTypoHint] = useState(null); // { index, originalBearing, flippedBearing, improvement }

  // ── Typo Assist: run after every failed result ────────────────────────────────────
  useEffect(() => {
    setTypoHint(null);
    if (!result || result.closure?.status?.startsWith('✓')) return;
    const pobN = parseFloat(pob.northing);
    const pobE = parseFloat(pob.easting);
    const baseError = computeLinearError(courses, pobN, pobE);
    let best = null;
    courses.forEach((c, i) => {
      if (c.type !== 'Line' || !c.bearing) return;
      const flipped = flipBearing(c.bearing);
      const testCourses = courses.map((x, j) => j === i ? { ...x, bearing: flipped } : x);
      const newError = computeLinearError(testCourses, pobN, pobE);
      const improvement = baseError - newError;
      if (improvement > 0.01 && (!best || improvement > best.improvement)) {
        best = { index: i, originalBearing: c.bearing, flippedBearing: flipped, improvement, newError };
      }
    });
    if (best) setTypoHint(best);
  }, [result]);

  const addCourse = () => setCourses(c => [...c, { ...BLANK_COURSE }]);
  const removeCourse = i => setCourses(c => c.filter((_, idx) => idx !== i));
  const updateCourse = (i, field, val) => setCourses(c => c.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const compute = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      const body = {
        pointOfBeginning: { northing: parseFloat(pob.northing), easting: parseFloat(pob.easting) },
        units,
        isOpenEnded,
        courses: courses.map(c => ({
          type: c.type,
          bearing: c.type === 'Line' ? c.bearing : null,
          distance: c.type === 'Line' ? parseFloat(c.distance) : null,
          delta: c.type === 'Curve' ? parseFloat(c.delta) : null,
          radius: c.type === 'Curve' ? parseFloat(c.radius) : null,
          arcLength: c.type === 'Curve' && c.arcLength ? parseFloat(c.arcLength) : null,
          curveDirection: c.type === 'Curve' ? c.curveDirection : null,
          chordBearing: c.type === 'Curve' ? c.chordBearing : null,
          chordDistance: c.type === 'Curve' && c.chordDistance ? parseFloat(c.chordDistance) : null,
        }))
      };
      const res = await fetch(`${API}/traverse/compute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Server error ${res.status}`);
      }
      setResult(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const isPassing = result?.closure?.status?.startsWith('✓');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* ── Setup ───────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">⚙️ Traverse Setup</div>
          <div className="flex-row" style={{ gap: '1.2rem', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', cursor: 'pointer', userSelect: 'none', fontWeight: 500, color: 'var(--text-muted)' }}>
              <input type="checkbox" checked={isOpenEnded} onChange={e => setIsOpenEnded(e.target.checked)} style={{ width: 15, height: 15, cursor: 'pointer' }} />
              <span>Open-Ended (Easement/Centerline)</span>
            </label>
            <select value={units} onChange={e => setUnits(e.target.value)} style={{ width: 100 }}>
              <option>Feet</option>
              <option>Meters</option>
            </select>
          </div>
        </div>
        <div className="grid-2">
          <div className="form-group">
            <label className="form-label">POB Northing</label>
            <input type="number" value={pob.northing} onChange={e => setPob(p => ({ ...p, northing: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">POB Easting</label>
            <input type="number" value={pob.easting} onChange={e => setPob(p => ({ ...p, easting: e.target.value }))} />
          </div>
        </div>
      </div>

      {/* ── Course Entry ─────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">📐 Courses <span className="text-muted" style={{ fontWeight: 400, fontSize: '0.8rem' }}>({courses.length})</span></div>
          <div className="flex-row">
            <button className="btn btn-ghost btn-sm" onClick={() => setCourses(EXAMPLE_COURSES.map(c => ({ ...BLANK_COURSE, ...c })))}>Load Example</button>
            <button className="btn btn-ghost btn-sm" onClick={() => {
              if (window.confirm('Clear all courses?')) setCourses([]);
              setResult(null);
            }}>Clear All</button>
            <button className="btn btn-ghost btn-sm" onClick={() => {
              navigator.clipboard.writeText(JSON.stringify(courses, null, 2));
              alert('Copied courses to clipboard!');
            }}>Copy JSON</button>
            <button className="btn btn-primary btn-sm" onClick={addCourse}>+ Add Course</button>
          </div>
        </div>

        {/* Column headers */}
        <div style={{ display: 'grid', gridTemplateColumns: '32px 80px 1fr 110px 36px', gap: '0.5rem', padding: '0 0.75rem 0.5rem', fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          <span>#</span><span>Type</span><span>Bearing / Chord Brg</span><span>Distance / Arc Len</span><span></span>
        </div>

        <div className="course-list">
          {courses.map((c, i) => (
            <div key={i} className="course-row">
              <span className="course-num">{i + 1}</span>
              <select value={c.type} onChange={e => updateCourse(i, 'type', e.target.value)}>
                <option>Line</option>
                <option>Curve</option>
              </select>
              {c.type === 'Line' ? (
                <>
                  <input type="text" placeholder='N45°30′00″E' value={c.bearing}
                    onChange={e => updateCourse(i, 'bearing', e.target.value)} />
                  <input type="number" placeholder="Distance" value={c.distance}
                    onChange={e => updateCourse(i, 'distance', e.target.value)} />
                </>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
                    <input type="text" placeholder="Chord Bearing" value={c.chordBearing}
                      onChange={e => updateCourse(i, 'chordBearing', e.target.value)} />
                    <input type="number" placeholder="Delta (DMS)" value={c.delta}
                      onChange={e => updateCourse(i, 'delta', e.target.value)} />
                    <input type="number" placeholder="Radius" value={c.radius}
                      onChange={e => updateCourse(i, 'radius', e.target.value)} />
                  </div>
                  <input type="number" placeholder="Chord Dist" value={c.chordDistance}
                    onChange={e => updateCourse(i, 'chordDistance', e.target.value)} />
                </>
              )}
              <button className="btn btn-danger btn-icon btn-sm" onClick={() => removeCourse(i)}>✕</button>
            </div>
          ))}
        </div>

        <div className="mt-2 flex-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={compute} disabled={loading || courses.length === 0}>
            {loading ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Computing…</> : '▶ Compute Traverse'}
          </button>
        </div>
      </div>

      {/* ── Error ────────────────────────────────────────────────────── */}
      {error && <div className="alert alert-error">⚠ {error}</div>}

      {/* ── Results ──────────────────────────────────────────────────── */}
      {result && (
        <>
          {/* Closure Summary */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">📊 Closure Report</div>
              <span className={`status-badge ${isPassing ? 'pass' : 'fail'}`}>
                {isPassing ? '✓ Passes' : '✗ Fails'} &nbsp;{result.closure.precisionRatio}
              </span>
            </div>
            <div className="closure-grid">
              <div className="closure-stat">
                <div className="label">Precision</div>
                <div className={`value ${isPassing ? 'pass' : 'fail'}`}>{result.closure.precisionRatio}</div>
              </div>
              <div className="closure-stat">
                <div className="label">Linear Error</div>
                <div className="value neutral">{result.closure.linearError.toFixed(4)}'</div>
              </div>
              <div className="closure-stat">
                <div className="label">Error Northing</div>
                <div className="value neutral">{result.closure.errorNorthing.toFixed(4)}'</div>
              </div>
              <div className="closure-stat">
                <div className="label">Error Easting</div>
                <div className="value neutral">{result.closure.errorEasting.toFixed(4)}'</div>
              </div>
              <div className="closure-stat">
                <div className="label">Perimeter</div>
                <div className="value neutral">{result.perimeter.toFixed(2)}'</div>
              </div>
              <div className="closure-stat">
                <div className="label">Area</div>
                <div className="value neutral">{result.areaAcres.toFixed(4)} ac</div>
              </div>
            </div>
          </div>

          {/* ── Typo Assist ─────────────────────────────────────────── */}
          {!isPassing && typoHint && (
            <div className="card" style={{ borderColor: '#c97a00', borderWidth: '1.5px' }}>
              <div className="card-header" style={{ background: 'rgba(255,170,0,0.08)' }}>
                <div className="card-title" style={{ color: '#c97a00' }}>🔧 Typo Assist — Most Likely Bearing Error</div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Auto-detected by quadrant-flip analysis</span>
              </div>
              <div style={{ padding: '0.85rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', fontSize: '0.82rem' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Course #</div>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>Course {typoHint.index + 1}</div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Recorded Bearing</div>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', color: '#cc0000', fontWeight: 700 }}>{typoHint.originalBearing}</div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Suggested Fix</div>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', color: '#007700', fontWeight: 700 }}>{typoHint.flippedBearing}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: '0.55rem', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Flipping this bearing reduces linear error by 
                    <strong style={{ color: '#c97a00' }}>{typoHint.improvement.toFixed(4)} ft</strong>
                     (from {result.closure.linearError.toFixed(4)} ft → ≈{typoHint.newError.toFixed(4)} ft)
                  </div>
                  <button
                    className="btn btn-sm"
                    style={{ background: '#c97a00', color: '#fff', border: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}
                    onClick={() => {
                      updateCourse(typoHint.index, 'bearing', typoHint.flippedBearing);
                      setTypoHint(null);
                      setResult(null);
                    }}
                  >
                    ✔ Apply Fix & Recompute
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Map */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">🗺 Traverse Map</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowPrint(true)}>
                🖨 Print Blueprint
              </button>
            </div>
            <TraverseMap stations={result.stations} adjusted={result.adjustedStations} />
          </div>

          {/* Station Table */}
          <div className="card">
            <div className="card-header"><div className="card-title">📋 Station Coordinates</div></div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th><th>Course</th>
                    <th>Raw N</th><th>Raw E</th>
                    <th>Dep ΔN</th><th>Dep ΔE</th>
                    <th>Adj N</th><th>Adj E</th>
                  </tr>
                </thead>
                <tbody>
                  {result.stations.map((s, i) => {
                    const adj = result.adjustedStations[i];
                    return (
                      <tr key={i} className={i === 0 ? 'pob-row' : ''}>
                        <td>{s.seq}</td>
                        <td style={{ fontFamily: 'inherit', fontSize: '0.8rem' }}>{s.course}</td>
                        <td>{s.northing.toFixed(4)}</td>
                        <td>{s.easting.toFixed(4)}</td>
                        <td>{s.depDN.toFixed(4)}</td>
                        <td>{s.depDE.toFixed(4)}</td>
                        <td>{adj?.northing.toFixed(4)}</td>
                        <td>{adj?.easting.toFixed(4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {showPrint && result && (
        <PrintBlueprint
          courses={courses}
          stations={result.stations}
          adjusted={result.adjustedStations}
          units={units}
          area={result.areaAcres}
          perimeter={result.perimeter}
          pob={{ northing: parseFloat(pob.northing), easting: parseFloat(pob.easting) }}
          initialLegalDescription={''}
          closure={result.closure}
          onClose={() => setShowPrint(false)}
        />
      )}
    </div>
  );
}
