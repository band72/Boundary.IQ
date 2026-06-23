import { useState, useEffect, useMemo } from 'react';
import { useToast } from '../hooks/useToast';
import TraverseMap from './TraverseMap';
import PrintBlueprint from './PrintBlueprint';
import ExportModal from './ExportModal';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { API } from '../config';
import { previewDeedText, deedPreviewSummary } from '../utils/deedParser.js';

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
  const m = b.trim().match(/^([NSns])\s*(\d+)[°\-\s](\d+)['\-\s](\d+(?:\.\d+)?)["\s]*([EWew])/);
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
    if (c.type !== 'Line' && c.type !== 'Squiggle') continue;
    const az = parseBearing(c.bearing);
    if (az === null || !c.distance) continue;
    const dist = parseFloat(c.distance);
    n += dist * Math.cos(az);
    e += dist * Math.sin(az);
  }
  const errN = pobN - n, errE = pobE - e;
  return Math.sqrt(errN * errN + errE * errE);
}

function CourseDrawer({ index, courses, onSave, onDelete, onClose }) {
  const course = courses[index];
  const [type, setType] = useState('Line');
  const [bearing, setBearing] = useState('');
  const [distance, setDistance] = useState('');
  const [curveDirection, setCurveDirection] = useState('Right');
  const [delta, setDelta] = useState('');
  const [radius, setRadius] = useState('');
  const [arcLength, setArcLength] = useState('');
  const [chordBearing, setChordBearing] = useState('');
  const [chordDistance, setChordDistance] = useState('');

  useEffect(() => {
    if (course) {
      setType(course.type || 'Line');
      setBearing(course.bearing || '');
      setDistance(course.distance != null ? String(course.distance) : '');
      setCurveDirection(course.curveDirection || 'Right');
      setDelta(course.delta != null ? String(course.delta) : '');
      setRadius(course.radius != null ? String(course.radius) : '');
      setArcLength(course.arcLength != null ? String(course.arcLength) : '');
      setChordBearing(course.chordBearing || '');
      setChordDistance(course.chordDistance != null ? String(course.chordDistance) : '');
    }
  }, [course, index]);

  if (index === null || !course) return null;

  const handleSave = () => {
    const updated = [...courses];
    const isLineOrSquiggle = type === 'Line' || type === 'Squiggle';
    updated[index] = {
      ...BLANK_COURSE,
      type,
      bearing: isLineOrSquiggle ? bearing : null,
      distance: isLineOrSquiggle && distance !== '' ? distance : null,
      curveDirection: type === 'Curve' ? curveDirection : null,
      delta: type === 'Curve' && delta !== '' ? delta : null,
      radius: type === 'Curve' && radius !== '' ? radius : null,
      arcLength: type === 'Curve' && arcLength !== '' ? arcLength : null,
      chordBearing: type === 'Curve' ? chordBearing : null,
      chordDistance: type === 'Curve' && chordDistance !== '' ? chordDistance : null,
    };
    onSave(updated);
  };

  return (
    <>
      <div className="course-drawer-backdrop open" onClick={onClose} />
      <div className="course-drawer open">
        <div className="course-drawer-header">
          <h3>✏️ Edit Course #{index + 1}</h3>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} style={{ color: '#fff', fontSize: '1.2rem' }}>✕</button>
        </div>
        <div className="course-drawer-body">
          <div className="form-group">
            <label className="form-label">Course Type</label>
            <select value={type} onChange={e => setType(e.target.value)} style={{ width: '100%', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
              <option value="Line">Line</option>
              <option value="Curve">Curve</option>
              <option value="Squiggle">Squiggle</option>
            </select>
          </div>

          {type === 'Line' || type === 'Squiggle' ? (
            <>
              <div className="form-group">
                <label className="form-label">Bearing</label>
                <input
                  type="text"
                  value={bearing}
                  onChange={e => setBearing(e.target.value)}
                  placeholder={"e.g. N45°22'10\"E"}
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Distance</label>
                <input
                  type="number"
                  value={distance}
                  onChange={e => setDistance(e.target.value)}
                  placeholder="Distance in feet/meters"
                />
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">Curve Direction</label>
                <select value={curveDirection} onChange={e => setCurveDirection(e.target.value)} style={{ width: '100%', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
                  <option value="Left">Left</option>
                  <option value="Right">Right</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Radius</label>
                <input
                  type="number"
                  value={radius}
                  onChange={e => setRadius(e.target.value)}
                  placeholder="Radius"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Delta (DMS or Degrees)</label>
                <input
                  type="text"
                  value={delta}
                  onChange={e => setDelta(e.target.value)}
                  placeholder={"e.g. 93°12'00\" or 93.2"}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Arc Length</label>
                <input
                  type="number"
                  value={arcLength}
                  onChange={e => setArcLength(e.target.value)}
                  placeholder="Arc Length"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Chord Bearing</label>
                <input
                  type="text"
                  value={chordBearing}
                  onChange={e => setChordBearing(e.target.value)}
                  placeholder={"e.g. S16°38'52\"E"}
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Chord Distance</label>
                <input
                  type="number"
                  value={chordDistance}
                  onChange={e => setChordDistance(e.target.value)}
                  placeholder="Chord Distance"
                />
              </div>
            </>
          )}
        </div>
        <div className="course-drawer-footer">
          <button className="btn btn-danger btn-sm" onClick={() => onDelete(index)} style={{ marginRight: 'auto' }}>
            🗑 Delete Course
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSave}>
            Save &amp; Compute
          </button>
        </div>
      </div>
    </>
  );
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
  const [typoHint, setTypoHint] = useState(null);
  const { showToast, ToastPortal } = useToast();

  // ── Segment Selection/Hovering & Active Tract ────────────────────────────────
  const [selectedCourseIndex, setSelectedCourseIndex] = useState(null);
  const [hoveredCourseIndex, setHoveredCourseIndex] = useState(null);
  const [activeTractIndex, setActiveTractIndex] = useState(0);

  // ── Fix Deed Text state ────────────────────────────────────────────────────
  const [fixDeedText, setFixDeedText] = useState('');
  const [fixDeedLoading, setFixDeedLoading] = useState(false);
  const [fixDeedResult, setFixDeedResult] = useState(null);
  const [fixDeedError, setFixDeedError] = useState('');
  const [fixDeedOpen, setFixDeedOpen] = useState(false);
  // AI auto-correction: when regex parse fails, escalate to LLM solver
  const [useAIFallback, setUseAIFallback] = useLocalStorage('boundaryiq_deed_ai_fallback', false);
  const [fixDeedUsedAI, setFixDeedUsedAI] = useState(false);

  // ── Feature 1: Bowditch Adjustment Toggle ─────────────────────────────────
  const [showAdjusted, setShowAdjusted] = useState(true);

  // ── Feature 3: Georeferencing ─────────────────────────────────────────────
  const [georef, setGeoref] = useLocalStorage('boundaryiq_georef', {
    pobLat: '', pobLng: '', rotationDeg: '0', scaleFactor: '1.000',
  });
  const [georefOpen, setGeorefOpen] = useState(false);

  // ── Feature 5: Export Modal ───────────────────────────────────────────────
  const [showExport, setShowExport] = useState(false);

  // ── Live deed preview (Feature 2) ─────────────────────────────────────────
  const deedPreview = useMemo(() => previewDeedText(fixDeedText), [fixDeedText]);
  const deedPreviewStr = useMemo(() => deedPreviewSummary(deedPreview), [deedPreview]);

  // ── Typo Assist: run after every failed result ────────────────────────────────────
  useEffect(() => {
    setTypoHint(null);
    if (!result || result.closure?.status?.startsWith('✓')) return;
    const pobN = parseFloat(pob.northing);
    const pobE = parseFloat(pob.easting);
    const baseError = computeLinearError(courses, pobN, pobE);
    let best = null;
    courses.forEach((c, i) => {
      if ((c.type !== 'Line' && c.type !== 'Squiggle') || !c.bearing) return;
      const flipped = flipBearing(c.bearing);
      const testCourses = courses.map((x, j) => j === i ? { ...x, bearing: flipped } : x);
      const newError = computeLinearError(testCourses, pobN, pobE);
      const improvement = baseError - newError;
      if (improvement > 0.01 && (!best || improvement > best.improvement)) {
        best = { index: i, originalBearing: c.bearing, flippedBearing: flipped, improvement, newError };
      }
    });
    if (best) setTypoHint(best);
  }, [result, courses, pob]);


  const addCourse = () => setCourses(c => [...c, { ...BLANK_COURSE }]);
  const removeCourse = i => setCourses(c => c.filter((_, idx) => idx !== i));
  const updateCourse = (i, field, val) => setCourses(c => c.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const compute = async (overrideCourses) => {
    setLoading(true); setError('');
    try {
      const targetCourses = Array.isArray(overrideCourses) ? overrideCourses : courses;
      const body = {
        pointOfBeginning: { northing: parseFloat(pob.northing), easting: parseFloat(pob.easting) },
        units,
        isOpenEnded,
        courses: targetCourses.map(c => {
          const isLineOrSquiggle = c.type === 'Line' || c.type === 'Squiggle';
          return {
            type: c.type,
            bearing: isLineOrSquiggle ? c.bearing : null,
            distance: isLineOrSquiggle && c.distance ? parseFloat(c.distance) : null,
            delta: c.type === 'Curve' && c.delta ? parseFloat(c.delta) : null,
            radius: c.type === 'Curve' && c.radius ? parseFloat(c.radius) : null,
            arcLength: c.type === 'Curve' && c.arcLength ? parseFloat(c.arcLength) : null,
            curveDirection: c.type === 'Curve' ? c.curveDirection : null,
            chordBearing: c.type === 'Curve' ? c.chordBearing : null,
            chordDistance: c.type === 'Curve' && c.chordDistance ? parseFloat(c.chordDistance) : null,
          };
        })
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
      const data = await res.json();
      
      if (result && result.tracts && result.tracts.length > 0) {
        const updatedTracts = [...result.tracts];
        updatedTracts[activeTractIndex] = {
          ...updatedTracts[activeTractIndex],
          originalCourses: [...body.courses],
          repairedCourses: targetCourses.map(c => ({ ...c })),
          traverse: data,
          status: data.closure?.linearError < 10.0 ? 'PASS' : 'FAIL',
        };
        setResult({
          ...result,
          ...updatedTracts[activeTractIndex],
          tracts: updatedTracts,
          stations: data.stations || [],
          adjustedStations: data.adjustedStations || [],
          closure: data.closure || null,
          perimeter: data.perimeter || 0,
          areaAcres: data.areaAcres || 0,
        });
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Fix Deed Text ──────────────────────────────────────────────────────────
  const handleFixDeed = async () => {
    if (!fixDeedText.trim()) return;
    setFixDeedLoading(true);
    setFixDeedError('');
    setFixDeedResult(null);
    setFixDeedUsedAI(false);
    try {
      // Step 1: Try fast regex solver
      const res = await fetch(`${API}/deed/solve-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deedText: fixDeedText,
          pobNorthing: parseFloat(pob.northing) || 5000,
          pobEasting:  parseFloat(pob.easting)  || 5000,
          units,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

      const isPass = data.status === 'PASS' || data.status === 'MEANDER';

      // Step 2: If regex failed and AI fallback is enabled, escalate to LLM solver
      if (!isPass && useAIFallback) {
        const aiRes = await fetch(`${API}/deed/solve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deedText: fixDeedText,
            pobNorthing: parseFloat(pob.northing) || 5000,
            pobEasting:  parseFloat(pob.easting)  || 5000,
            units,
          })
        });
        if (aiRes.ok) {
          const aiData = await aiRes.json();
          const aiIsPass = aiData.status === 'PASS' || aiData.status === 'MEANDER';
          // Accept AI result if it's better (PASS, or lower error)
          const regexErr = data.traverse?.closure?.linearError ?? Infinity;
          const aiErr    = aiData.traverse?.closure?.linearError ?? Infinity;
          if (aiIsPass || aiErr < regexErr) {
            setFixDeedUsedAI(true);
            setFixDeedResult(aiData);
            return;
          }
        }
      }

      setFixDeedResult(data);
    } catch (e) {
      setFixDeedError(e.message);
    } finally {
      setFixDeedLoading(false);
    }
  };

  const applyFixedCourses = () => {
    if (!fixDeedResult) return;
    
    if (fixDeedResult.tracts && fixDeedResult.tracts.length > 0) {
      setResult(fixDeedResult);
      setActiveTractIndex(0);
      const firstT = fixDeedResult.tracts[0];
      setCourses((firstT.originalCourses || firstT.courses || []).map(c => ({
        ...BLANK_COURSE,
        ...c,
        distance: c.distance != null ? String(c.distance) : '',
        radius: c.radius != null ? String(c.radius) : '',
        arcLength: c.arcLength != null ? String(c.arcLength) : '',
        chordDistance: c.chordDistance != null ? String(c.chordDistance) : '',
      })));
      if (firstT.pob) {
        setPob({ northing: String(firstT.pob.northing), easting: String(firstT.pob.easting) });
      }
    } else {
      const newCourses = (fixDeedResult.repairedCourses || []).map(c => ({
        ...BLANK_COURSE,
        ...c,
        distance: c.distance != null ? String(c.distance) : '',
        radius: c.radius != null ? String(c.radius) : '',
        arcLength: c.arcLength != null ? String(c.arcLength) : '',
        chordDistance: c.chordDistance != null ? String(c.chordDistance) : '',
      }));
      setCourses(newCourses);
      if (fixDeedResult.pob) {
        setPob({ northing: String(fixDeedResult.pob.northing), easting: String(fixDeedResult.pob.easting) });
      }
      setResult(null);
    }
    setFixDeedOpen(false);
    setFixDeedResult(null);
    setFixDeedText('');
  };

  const isPassing = result?.closure?.status?.startsWith('✓');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* ── Tract Switcher ────────────────────────────────────────────── */}
      {result && result.tracts && result.tracts.length > 1 && (
        <div className="card" style={{ padding: '0.75rem 1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>📍 Active Tract:</span>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {result.tracts.map((tract, idx) => {
                const isActive = idx === activeTractIndex;
                const isTractPassing = tract.status === 'PASS' || (tract.traverse?.closure?.linearError != null && tract.traverse.closure.linearError < 10.0);
                return (
                  <button
                    key={idx}
                    className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-ghost'}`}
                    style={{
                      fontWeight: 600,
                      border: isActive ? 'none' : '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                    }}
                    onClick={() => {
                      setActiveTractIndex(idx);
                      const targetTract = result.tracts[idx];
                      const newCourses = (targetTract.repairedCourses || targetTract.originalCourses || targetTract.courses || []).map(c => ({
                        ...BLANK_COURSE,
                        ...c,
                        distance: c.distance != null ? String(c.distance) : '',
                        radius: c.radius != null ? String(c.radius) : '',
                        arcLength: c.arcLength != null ? String(c.arcLength) : '',
                        chordDistance: c.chordDistance != null ? String(c.chordDistance) : '',
                      }));
                      setCourses(newCourses);
                      if (targetTract.pob) {
                        setPob({ northing: String(targetTract.pob.northing), easting: String(targetTract.pob.easting) });
                      }
                      setIsOpenEnded(targetTract.isOpenEnded ?? false);
                      setResult(prev => ({
                        ...prev,
                        ...targetTract,
                      }));
                    }}
                  >
                    <span>{tract.name || `Tract ${idx + 1}`}</span>
                    <span style={{
                      fontSize: '0.7rem',
                      padding: '1px 5px',
                      borderRadius: '4px',
                      background: isTractPassing ? 'rgba(0, 200, 80, 0.2)' : 'rgba(255, 80, 80, 0.2)',
                      color: isTractPassing ? 'var(--success)' : 'var(--danger)',
                    }}>
                      {isTractPassing ? '✓' : '✗'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="split-layout" style={{ alignItems: 'start' }}>
        {/* Left Column: Input Panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', alignSelf: 'start' }}>
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

          {/* ── Fix Deed Text (Feature 2: enhanced with live preview) ─────── */}
          <div className="card" style={{ borderColor: fixDeedOpen ? 'var(--accent)' : undefined }}>
            <div className="card-header" style={{ cursor: 'pointer' }} onClick={() => setFixDeedOpen(o => !o)}>
              <div className="card-title">🔧 Deed Text Parser</div>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                {deedPreviewStr && fixDeedOpen && (
                  <span style={{
                    fontSize: '0.72rem', fontWeight: 600,
                    padding: '2px 8px', borderRadius: 4,
                    background: 'rgba(61,127,255,0.12)',
                    color: 'var(--accent)', border: '1px solid rgba(61,127,255,0.25)',
                  }}>
                    {deedPreviewStr}
                  </span>
                )}
                {/* AI Fallback toggle — stop propagation so clicking it doesn't collapse the card */}
                <label
                  onClick={e => e.stopPropagation()}
                  title={useAIFallback ? 'AI Auto-Correct is ON — if regex parse fails, LLM solver is tried automatically' : 'AI Auto-Correct is OFF — click to enable cloud AI fallback on failed parses'}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                    cursor: 'pointer', userSelect: 'none',
                    padding: '3px 8px', borderRadius: 20,
                    background: useAIFallback ? 'rgba(130,80,255,0.15)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${useAIFallback ? 'rgba(130,80,255,0.45)' : 'rgba(255,255,255,0.12)'}`,
                    transition: 'all 0.2s',
                  }}
                >
                  {/* Custom pill toggle */}
                  <span
                    onClick={() => setUseAIFallback(v => !v)}
                    style={{
                      display: 'inline-block', position: 'relative',
                      width: 28, height: 16, borderRadius: 8, flexShrink: 0,
                      background: useAIFallback ? 'linear-gradient(135deg,#8250ff 0%,#b47bff 100%)' : 'rgba(255,255,255,0.15)',
                      border: `1px solid ${useAIFallback ? 'rgba(130,80,255,0.6)' : 'rgba(255,255,255,0.2)'}`,
                      boxShadow: useAIFallback ? '0 0 8px rgba(130,80,255,0.5)' : 'none',
                      transition: 'all 0.2s',
                    }}
                  >
                    <span style={{
                      position: 'absolute', top: 2,
                      left: useAIFallback ? 13 : 2,
                      width: 10, height: 10, borderRadius: '50%',
                      background: '#fff',
                      transition: 'left 0.2s',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                    }} />
                  </span>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: useAIFallback ? '#c4a0ff' : 'var(--text-muted)' }}>
                    🤖 AI Auto-Correct
                  </span>
                </label>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Paste raw deed text — auto-corrects errors &amp; loads courses
                </span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{fixDeedOpen ? '▲' : '▼'}</span>
              </div>
            </div>

            {fixDeedOpen && (
              <div style={{ padding: '0 1rem 1rem' }}>
                <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                  <label className="form-label">Paste Legal Description</label>
                  <textarea
                    value={fixDeedText}
                    onChange={e => setFixDeedText(e.target.value)}
                    placeholder={`BEGINNING at a point, having coordinates of Northing 5000.00, Easting 5000.00;\n\nTHENCE North 45°22'10" East, a distance of 150.25 feet;\nTHENCE South 45°22'10" West, a distance of 150.25 feet;\nTHENCE South 45°22'10" East, a distance of 150.25 feet;\nTHENCE North / West, a distance of 0.00 feet to the Point of Beginning.`}
                    style={{
                      width: '100%', minHeight: 160, resize: 'vertical',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.8rem',
                      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)', padding: '0.75rem',
                      color: 'var(--text-primary)', lineHeight: 1.6, boxSizing: 'border-box',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginBottom: '0.75rem', alignItems: 'center' }}>
                  {useAIFallback && (
                    <span style={{ fontSize: '0.7rem', color: 'rgba(196,160,255,0.8)', fontStyle: 'italic' }}>
                      AI fallback enabled — will escalate to LLM if regex fails
                    </span>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => { setFixDeedText(''); setFixDeedResult(null); setFixDeedError(''); }}>
                    Clear
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleFixDeed}
                    disabled={fixDeedLoading || !fixDeedText.trim()}
                    style={useAIFallback ? { background: 'linear-gradient(135deg, #3d7fff 0%, #8250ff 100%)', border: '1px solid rgba(130,80,255,0.5)' } : {}}
                  >
                    {fixDeedLoading
                      ? <><span className="spinner" style={{ width: 14, height: 14 }} /> {useAIFallback ? 'Solving (AI)…' : 'Solving…'}</>
                      : useAIFallback ? '🤖⚡ Solve with AI' : '⚡ Solve Deed'}
                  </button>
                </div>

                {fixDeedError && (
                  <div className="alert alert-error" style={{ marginBottom: '0.75rem' }}>⚠ {fixDeedError}</div>
                )}

                {fixDeedResult && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

                    {/* Status banner */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
                      padding: '0.65rem 0.9rem',
                      background: fixDeedResult.status === 'PASS' ? 'rgba(0,200,100,0.08)' : 'rgba(255,80,80,0.08)',
                      border: `1px solid ${fixDeedResult.status === 'PASS' ? 'var(--success)' : 'var(--danger)'}`,
                      borderRadius: 'var(--radius-md)',
                    }}>
                      <span style={{
                        fontWeight: 700, fontSize: '0.9rem',
                        color: fixDeedResult.status === 'PASS' ? 'var(--success)' : 'var(--danger)',
                      }}>
                        {fixDeedResult.status === 'PASS' ? '✓ SOLVED' : '⚠ UNCLOSED'}
                      </span>
                      {/* AI badge shown when LLM was used */}
                      {fixDeedUsedAI && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                          padding: '2px 8px', borderRadius: 12, fontSize: '0.7rem', fontWeight: 700,
                          background: 'linear-gradient(135deg,rgba(130,80,255,0.25) 0%,rgba(180,123,255,0.15) 100%)',
                          border: '1px solid rgba(130,80,255,0.5)',
                          color: '#c4a0ff',
                          boxShadow: '0 0 8px rgba(130,80,255,0.25)',
                        }}>
                          🤖 AI-Corrected
                        </span>
                      )}
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        Trust: <strong style={{ color: fixDeedResult.trustScore >= 80 ? 'var(--success)' : fixDeedResult.trustScore >= 55 ? '#c97a00' : 'var(--danger)' }}>
                          {fixDeedResult.trustScore}/100 {fixDeedResult.trustLevel}
                        </strong>
                      </span>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        Method: <strong>{fixDeedResult.primaryHypothesis?.replace(/_/g, ' ')}</strong>
                      </span>
                      {fixDeedResult.traverse?.closure && (
                        <>
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            Precision: <strong>{fixDeedResult.traverse.closure.precisionRatio}</strong>
                          </span>
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            Area: <strong>{fixDeedResult.traverse.areaAcres?.toFixed(4)} ac</strong>
                          </span>
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            Perimeter: <strong>{fixDeedResult.traverse.perimeter?.toFixed(2)} ft</strong>
                          </span>
                        </>
                      )}
                    </div>

                    {/* Correction table */}
                    {/* Build per-type sequential counters for L# / C# labels */}
                    {(() => {
                      let lineIdx = 1, curveIdx = 1;
                      const rows = fixDeedResult.correctionTable?.map((c, i) => {
                        const isCurve   = (c.type || '').toLowerCase() === 'curve';
                        const tag       = isCurve ? `C${curveIdx++}` : `L${lineIdx++}`;
                        const isFixed   = c.status === 'CORRECTED';
                        const isSolved  = c.status === 'SOLVED-BY-INVERSE';
                        const rowColor  = isFixed ? 'rgba(255,170,0,0.10)' : isSolved ? 'rgba(0,180,255,0.10)' : undefined;

                        // Main display value — bearing+dist for lines, R= / arc= for curves
                        const mainDisplay = isCurve
                          ? [
                              c.radius   != null ? `R=${c.radius.toFixed(2)}'`   : null,
                              c.arcLength != null ? `arc=${c.arcLength.toFixed(2)}'` : (c.distance != null ? `arc=${c.distance.toFixed(2)}'` : null),
                            ].filter(Boolean).join('  ')
                          : (c.bearing || '??');

                        const distDisplay = isCurve
                          ? (c.arcLength != null ? `${c.arcLength.toFixed(2)}'` : c.distance != null ? `${c.distance.toFixed(2)}'` : '??')
                          : (c.distance  != null ? `${c.distance.toFixed(2)}'`  : '??');

                        return (
                          <tr key={i} style={{ background: rowColor }}>
                            <td style={{ fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
                              <span style={{
                                display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: '0.72rem',
                                background: isCurve ? 'rgba(0,180,255,0.15)' : 'rgba(100,100,255,0.12)',
                                color: isCurve ? '#007acc' : 'var(--text-secondary)',
                                fontWeight: 700,
                              }}>{tag}</span>
                            </td>
                            <td>
                              <span style={{
                                padding: '2px 7px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700,
                                background: isFixed ? 'rgba(255,140,0,0.2)' : isSolved ? 'rgba(0,140,255,0.2)' : 'rgba(0,200,80,0.2)',
                                color: isFixed ? '#c97a00' : isSolved ? '#007acc' : 'var(--success)',
                              }}>
                                {isFixed ? '✎ CORRECTED' : isSolved ? '⊕ SOLVED' : '✓ OK'}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: isFixed ? '#c97a00' : isSolved ? '#007acc' : undefined }}>
                              {isCurve
                                ? <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{mainDisplay || '??'}</span>
                                : (c.bearing || <span style={{ color: 'var(--text-muted)' }}>??</span>)
                              }
                            </td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                              {distDisplay === '??' ? <span style={{ color: 'var(--text-muted)' }}>??</span> : distDisplay}
                            </td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace', color: isFixed ? 'var(--danger)' : 'var(--text-muted)', textDecoration: isFixed ? 'line-through' : undefined, fontSize: '0.75rem' }}>
                              {isCurve
                                ? <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>curve</span>
                                : (c.originalBearing || (c.status === 'SOLVED-BY-INVERSE' ? <em>unknown</em> : '—'))
                              }
                            </td>
                          </tr>
                        );
                      });
                      return (
                        <div style={{ overflowX: 'auto' }}>
                          <table className="data-table" style={{ fontSize: '0.8rem' }}>
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Status</th>
                                <th>Bearing / Curve</th>
                                <th>Distance / Arc</th>
                                <th>Original Bearing</th>
                              </tr>
                            </thead>
                            <tbody>{rows}</tbody>
                          </table>
                        </div>
                      );
                    })()}

                    {/* Apply button */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setFixDeedResult(null)}>Dismiss</button>
                      <button
                        className="btn btn-primary"
                        onClick={applyFixedCourses}
                        style={{ fontWeight: 700 }}
                      >
                        ✔ Apply Corrected Courses to Traverse
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Feature 3: Georeferencing Panel ──────────────────────────── */}
          <div className="card" style={{ borderColor: georefOpen ? 'rgba(0,212,168,0.5)' : undefined }}>
            <div
              className="card-header"
              style={{ cursor: 'pointer' }}
              onClick={() => setGeorefOpen(o => !o)}
            >
              <div className="card-title">🌐 Georeference</div>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                {georef.pobLat && georef.pobLng ? (
                  <span style={{
                    fontSize: '0.72rem', fontWeight: 600,
                    padding: '2px 8px', borderRadius: 4,
                    background: 'rgba(0,212,168,0.1)',
                    color: '#00d4a8', border: '1px solid rgba(0,212,168,0.3)',
                  }}>
                    ✓ Georeferenced
                  </span>
                ) : (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Set real-world position, rotation &amp; scale
                  </span>
                )}
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{georefOpen ? '▲' : '▼'}</span>
              </div>
            </div>

            {georefOpen && (
              <div style={{ padding: '0 1rem 1rem' }}>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.75rem' }}>
                  Enter the WGS84 coordinates of your POB to produce real-world GeoJSON/KML output.
                  Rotation offsets grid-north to true-north; scale corrects ground-to-grid distortion.
                </p>
                <div className="grid-2" style={{ gap: '0.75rem' }}>
                  <div className="form-group">
                    <label className="form-label">POB Latitude</label>
                    <input
                      id="georef-pob-lat"
                      type="number" step="0.000001" placeholder="e.g. 30.267153"
                      value={georef.pobLat}
                      onChange={e => setGeoref(g => ({ ...g, pobLat: e.target.value }))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">POB Longitude</label>
                    <input
                      id="georef-pob-lng"
                      type="number" step="0.000001" placeholder="e.g. -97.743061"
                      value={georef.pobLng}
                      onChange={e => setGeoref(g => ({ ...g, pobLng: e.target.value }))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Rotation Offset (°)</label>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <input
                        id="georef-rotation"
                        type="range" min="-180" max="180" step="0.1"
                        value={georef.rotationDeg}
                        onChange={e => setGeoref(g => ({ ...g, rotationDeg: e.target.value }))}
                        style={{ flex: 1 }}
                      />
                      <input
                        type="number" step="0.1" min="-180" max="180"
                        value={georef.rotationDeg}
                        onChange={e => setGeoref(g => ({ ...g, rotationDeg: e.target.value }))}
                        style={{ width: 72 }}
                      />
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>°</span>
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Scale Factor</label>
                    <input
                      id="georef-scale"
                      type="number" step="0.00001" min="0.0001" max="100"
                      value={georef.scaleFactor}
                      onChange={e => setGeoref(g => ({ ...g, scaleFactor: e.target.value }))}
                      placeholder="1.000000"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setGeoref({ pobLat: '', pobLng: '', rotationDeg: '0', scaleFactor: '1.000' })}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
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
                  showToast('Courses copied to clipboard!');
                }}>Copy JSON</button>
                <button className="btn btn-primary btn-sm" onClick={addCourse}>+ Add Course</button>
              </div>
            </div>

            {/* Column headers */}
            <div style={{ display: 'grid', gridTemplateColumns: '32px 80px 1fr 110px 72px', gap: '0.5rem', padding: '0 0.75rem 0.5rem', fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <span>#</span><span>Type</span><span>Bearing / Chord Brg</span><span>Distance / Arc Len</span><span>Actions</span>
            </div>

            <div className="course-list">
              {courses.map((c, i) => (
                <div
                  key={i}
                  className={`course-row${selectedCourseIndex === i ? ' active' : ''}${hoveredCourseIndex === i ? ' hovered' : ''}`}
                  onMouseEnter={() => setHoveredCourseIndex(i)}
                  onMouseLeave={() => setHoveredCourseIndex(null)}
                >
                  <span className="course-num">{i + 1}</span>
                  <select value={c.type} onChange={e => updateCourse(i, 'type', e.target.value)}>
                    <option>Line</option>
                    <option>Curve</option>
                    <option>Squiggle</option>
                  </select>
                  {c.type === 'Line' || c.type === 'Squiggle' ? (
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
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <button
                      className="btn btn-ghost btn-icon btn-sm"
                      title="Edit in Drawer"
                      onClick={() => setSelectedCourseIndex(i)}
                      style={{ fontSize: '0.85rem', width: 28, height: 28, minWidth: 28, padding: 0 }}
                    >
                      ✏️
                    </button>
                    <button
                      className="btn btn-danger btn-icon btn-sm"
                      onClick={() => removeCourse(i)}
                      style={{ width: 28, height: 28, minWidth: 28, padding: 0 }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-2 flex-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={compute} disabled={loading || courses.length === 0}>
                {loading ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Computing…</> : '▶ Compute Traverse'}
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Dynamic Map, Error & Results */}
        <div className="sticky-column" style={{ alignSelf: 'start' }}>
          {/* Map — Always visible if there are courses! */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">🗺️ Traverse Map</div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {result?.adjustedStations?.length > 0 && (
                  <span style={{ fontSize: '0.72rem', color: showAdjusted ? '#00d4a8' : 'var(--text-muted)' }}>
                    {showAdjusted ? 'Adjusted' : 'Raw'}
                  </span>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => setShowPrint(true)} disabled={!result}>
                  🖨 Print Blueprint
                </button>
              </div>
            </div>
            <TraverseMap
              key={`${activeTractIndex}_${result?.stations?.length || 0}_${result?.closure?.linearError || 0}_${showAdjusted}_${courses.length}`}
              stations={result?.stations}
              adjusted={showAdjusted ? result?.adjustedStations : []}
              courses={courses}
              pob={{ northing: parseFloat(pob.northing) || 5000, easting: parseFloat(pob.easting) || 5000 }}
              hoveredCourseIndex={hoveredCourseIndex}
              setHoveredCourseIndex={setHoveredCourseIndex}
              selectedCourseIndex={selectedCourseIndex}
              setSelectedCourseIndex={setSelectedCourseIndex}
              activeTractIndex={activeTractIndex}
              tracts={result?.tracts || []}
            />
          </div>

          {/* Error */}
          {error && <div className="alert alert-error">⚠ {error}</div>}

          {/* Results: Closure, Typo Assist, Station Table */}
          {result && (
            <>
              {/* Closure Summary */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">📊 Closure Report</div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    {result.adjustedStations?.length > 0 && (
                      <button
                        id="bowditch-toggle-btn"
                        className={`btn btn-sm ${showAdjusted ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setShowAdjusted(v => !v)}
                        title={showAdjusted ? 'Showing Compass-Rule adjusted traverse' : 'Showing raw unadjusted traverse'}
                        style={{ fontSize: '0.72rem', fontWeight: 600 }}
                      >
                        {showAdjusted ? '🧭 Bowditch ON' : '🧭 Bowditch OFF'}
                      </button>
                    )}
                    {isPassing && (
                      <button
                        id="export-btn"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowExport(true)}
                        style={{ fontSize: '0.72rem' }}
                      >
                        📤 Export
                      </button>
                    )}
                    <span className={`status-badge ${isPassing ? 'pass' : 'fail'}`}>
                      {isPassing ? '✓ Passes' : '✗ Fails'} &nbsp;{result.closure.precisionRatio}
                    </span>
                  </div>
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
                {showAdjusted && result.adjustedStations?.length > 0 && result.stations?.length > 0 && (
                  <details style={{ padding: '0 1rem 0.75rem' }}>
                    <summary style={{ fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none', marginBottom: '0.5rem' }}>
                      ▸ Bowditch Corrections per course
                    </summary>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="data-table" style={{ fontSize: '0.76rem' }}>
                        <thead>
                          <tr>
                            <th>#</th><th>Course</th>
                            <th>ΔN raw</th><th>ΔE raw</th>
                            <th>ΔN adj</th><th>ΔE adj</th>
                            <th>ΔN corr</th><th>ΔE corr</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.stations.map((s, i) => {
                            const adj = result.adjustedStations[i];
                            if (!adj) return null;
                            const rawN = s.northing - (result.stations[i - 1]?.northing ?? parseFloat(pob.northing));
                            const rawE = s.easting  - (result.stations[i - 1]?.easting  ?? parseFloat(pob.easting));
                            const adjN = adj.northing - (result.adjustedStations[i - 1]?.northing ?? parseFloat(pob.northing));
                            const adjE = adj.easting  - (result.adjustedStations[i - 1]?.easting  ?? parseFloat(pob.easting));
                            const corrN = adjN - rawN;
                            const corrE = adjE - rawE;
                            if (i === 0) return null; // skip POB itself
                            return (
                              <tr key={i}>
                                <td>{i}</td>
                                <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem' }}>{s.course || `L${i}`}</td>
                                <td>{rawN.toFixed(4)}</td>
                                <td>{rawE.toFixed(4)}</td>
                                <td>{adjN.toFixed(4)}</td>
                                <td>{adjE.toFixed(4)}</td>
                                <td style={{ color: Math.abs(corrN) > 0.0001 ? '#c97a00' : 'var(--text-muted)' }}>{corrN >= 0 ? '+' : ''}{corrN.toFixed(5)}</td>
                                <td style={{ color: Math.abs(corrE) > 0.0001 ? '#c97a00' : 'var(--text-muted)' }}>{corrE >= 0 ? '+' : ''}{corrE.toFixed(5)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </div>

              {/* Typo Assist */}
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
                        Flipping this bearing reduces linear error by {' '}
                        <strong style={{ color: '#c97a00' }}>{typoHint.improvement.toFixed(4)} ft</strong>
                        {' '}(from {result.closure.linearError.toFixed(4)} ft → ≈{typoHint.newError.toFixed(4)} ft)
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
        </div>
      </div>
      {showPrint && result && (
        <PrintBlueprint
          key={`${result.stations?.length || 0}_${result.closure?.linearError || 0}`}
          courses={courses}
          stations={result.stations}
          adjusted={result.adjustedStations}
          units={units}
          area={result.areaAcres}
          perimeter={result.perimeter}
          pob={{ northing: parseFloat(pob.northing), easting: parseFloat(pob.easting) }}
          initialLegalDescription={''}
          closure={result.closure}
          isOpenEnded={isOpenEnded}
          onClose={() => setShowPrint(false)}
        />
      )}
      {/* Feature 5: Export Modal */}
      {showExport && result && (
        <ExportModal
          stations={showAdjusted && result.adjustedStations?.length ? result.adjustedStations : result.stations}
          courses={courses}
          meta={{
            parcel: pob.parcel || 'Subject Parcel',
            county: result.county || '',
            state: result.state || '',
            units,
            areaAcres: result.areaAcres,
            perimeter: result.perimeter,
            precisionRatio: result.closure?.precisionRatio,
          }}
          geoRef={georef.pobLat && georef.pobLng ? {
            ...georef,
            pobNorthing: parseFloat(pob.northing),
            pobEasting:  parseFloat(pob.easting),
            units,
          } : null}
          onClose={() => setShowExport(false)}
        />
      )}
      <CourseDrawer
        index={selectedCourseIndex}
        courses={courses}
        onSave={(updatedCourses) => {
          setCourses(updatedCourses);
          compute(updatedCourses);
          setSelectedCourseIndex(null);
        }}
        onDelete={(idx) => {
          const updated = courses.filter((_, i) => i !== idx);
          setCourses(updated);
          compute(updated);
          setSelectedCourseIndex(null);
        }}
        onClose={() => setSelectedCourseIndex(null)}
      />
      <ToastPortal />
    </div>
  );
}
