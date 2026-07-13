import { useState, useEffect } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { authFetch } from '../api';
import { useToast } from '../hooks/useToast';
import TraverseMap from './TraverseMap';
import './WriterTab.css';

const BLANK = { type: 'Line', bearing: '', distance: '', chordBearing: '', chordDistance: '', arcLength: '', delta: '', radius: '', curveDirection: 'Right', description: '', subConnector: '', subFeature: '', subDirection: '' };
const EXAMPLE = [
  { ...BLANK, bearing: 'N89-50-00E', distance: '669.80' },
  { ...BLANK, bearing: 'S00-35-00E', distance: '669.80' },
  { ...BLANK, bearing: 'S89-50-00W', distance: '669.80' },
  { ...BLANK, bearing: 'N00-35-00W', distance: '669.80' },
];

function validateBearing(bearing) {
  if (!bearing) return false;
  const clean = bearing.trim();
  if (/^(N|S|E|W|NORTH|SOUTH|EAST|WEST)$/i.test(clean)) return true;
  const regex = /^[NSns]\s*\d+([\s°\-\d'"’.\u2032\u2033\u2034\u02B9\u02BA\uF0B0\uF0B2\uFEFF\u00BA\u02DA]*)\s*[EWew]?$/;
  return regex.test(clean);
}

function checkBearingWarning(bearing) {
  if (!bearing) return null;
  const clean = bearing.trim().toUpperCase();
  
  if (/^[MHPF]/.test(clean) || /[MHPF]$/.test(clean)) {
    return 'Fuzzy OCR characters detected (e.g., M/H/P/F). Will be auto-corrected in backend.';
  }
  
  const dmsMatch = clean.match(/^[NS]\s*(\d+(?:\.\d+)?)/);
  if (dmsMatch) {
    const deg = parseFloat(dmsMatch[1]);
    if (deg === 0 || deg === 90) {
      return `Cardinal directions (0° or 90°) should not have quadrant letters.`;
    }
  }

  if (/^[NSns]\s*\d{5,6}(?:\.\d+)?\s*[EWew]?$/i.test(clean)) {
    return 'Smashed digits detected. Will be parsed as DMS.';
  }

  if (/^[NSns]\s*\d+\.\d{4,}\s*[EWew]?$/i.test(clean)) {
    return 'Packed DMS format detected. Ensure digits represent DD.MMSS.';
  }

  return null;
}

export default function WriterTab() {
  // Use local state for performance, persisting to local storage with a 1-second debounce
  const [courses, setCourses] = useState(() => {
    try {
      const item = window.localStorage.getItem('boundaryiq_writer_courses');
      return item ? JSON.parse(item) : EXAMPLE;
    } catch {
      return EXAMPLE;
    }
  });

  useEffect(() => {
    const handler = setTimeout(() => {
      try {
        window.localStorage.setItem('boundaryiq_writer_courses', JSON.stringify(courses));
      } catch (err) {
        console.debug('Failed to write courses to localStorage', err);
      }
    }, 1000);
    return () => clearTimeout(handler);
  }, [courses]);

  const [pobN, setPobN]           = useLocalStorage('boundaryiq_writer_pobN', '5000.00');
  const [pobE, setPobE]           = useLocalStorage('boundaryiq_writer_pobE', '5000.00');
  const [parcel, setParcel]       = useLocalStorage('boundaryiq_writer_parcel', '');
  const [county, setCounty]       = useLocalStorage('boundaryiq_writer_county', '');
  const [stateVal, setStateVal]   = useLocalStorage('boundaryiq_writer_state', '');
  const [units, setUnits]         = useLocalStorage('boundaryiq_writer_units', 'feet');
  const [basisBrg, setBasisBrg]   = useLocalStorage('boundaryiq_writer_basisBrg', '');
  const [areaAcres, setAreaAcres] = useLocalStorage('boundaryiq_writer_area', '');
  const [perimeter, setPerimeter] = useLocalStorage('boundaryiq_writer_perimeter', '');
  const [bearingDecimals, setBearingDecimals] = useLocalStorage('boundaryiq_writer_bearingDecimals', '0');
  const [pasteJson, setPasteJson] = useLocalStorage('boundaryiq_writer_paste', '');
  const [pasteText, setPasteText] = useLocalStorage('boundaryiq_writer_paste_text', '');
  const [inputMode, setInputMode] = useLocalStorage('boundaryiq_writer_mode', 'form');

  const [result, setResult]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [copied, setCopied]   = useState(false);
  const [hoveredCourseIndex, setHoveredCourseIndex] = useState(null);
  const [selectedCourseIndex, setSelectedCourseIndex] = useState(null);

  const { showToast, ToastPortal } = useToast();

  const moveCourseUp = (i) => {
    if (i === 0) return;
    setCourses(prev => {
      const next = [...prev];
      const temp = next[i];
      next[i] = next[i - 1];
      next[i - 1] = temp;
      return next;
    });
  };

  const moveCourseDown = (i) => {
    setCourses(prev => {
      if (i === prev.length - 1) return prev;
      const next = [...prev];
      const temp = next[i];
      next[i] = next[i + 1];
      next[i + 1] = temp;
      return next;
    });
  };

  const handleExtractText = async () => {
    if (!pasteText.trim()) { setError('Paste some legal description text first.'); return; }
    setLoading(true); setError('');
    try {
      const data = await authFetch('/deed/solve-text', {
        method: 'POST',
        body: JSON.stringify({
          deedText: pasteText,
          pobNorthing: parseFloat(pobN) || 5000,
          pobEasting:  parseFloat(pobE)  || 5000,
          units,
        })
      });
      
      if (data.repairedCourses) {
        const newCourses = data.repairedCourses.map(c => ({
          ...BLANK,
          type: (c.type === 'Meandering Line' || c.type === 'meandering line') ? 'Squiggle' : (c.type || 'Line'),
          bearing: c.bearing || '',
          distance: c.distance != null ? String(c.distance) : '',
          chordBearing: c.chordBearing || '',
          chordDistance: c.chordDistance != null ? String(c.chordDistance) : '',
          arcLength: c.arcLength != null ? String(c.arcLength) : '',
          delta: c.delta != null ? String(c.delta) : '',
          radius: c.radius != null ? String(c.radius) : '',
          curveDirection: c.curveDirection || 'Right',
          description: c.description || '',
          subConnector: c.subConnector || '',
          subFeature: c.subFeature || '',
          subDirection: c.subDirection || '',
        }));
        setCourses(newCourses);
        let finalPobN = pobN;
        let finalPobE = pobE;
        if (data.pob) {
          finalPobN = String(data.pob.northing);
          finalPobE = String(data.pob.easting);
          setPobN(finalPobN);
          setPobE(finalPobE);
        }
        setInputMode('form');
        showToast(`Successfully extracted ${newCourses.length} courses from text!`);
        await generate(newCourses, finalPobN, finalPobE);
      } else {
        throw new Error('No courses could be extracted from this text.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Course editor helpers ────────────────────────────────────────────────────
  const addCourse = () => setCourses(c => [...c, { ...BLANK }]);
  const removeCourse = i => setCourses(c => c.filter((_, idx) => idx !== i));
  const update = (i, field, val) => setCourses(c => c.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const areCoursesValid = (arr) => {
    return arr.every(c => {
      const type = (c.type || 'Line').toLowerCase();
      if (type === 'line' || type === 'squiggle') {
        if (!c.bearing || !validateBearing(c.bearing)) return false;
        if (!c.distance || isNaN(parseFloat(c.distance))) return false;
      } else if (type === 'curve') {
        if (!c.radius || isNaN(parseFloat(c.radius))) return false;
        if (!c.arcLength || isNaN(parseFloat(c.arcLength))) return false;
      }
      return true;
    });
  };

  // ── Generate ────────────────────────────────────────────────────────────────
  const generate = async (customCourses, customPobN, customPobE, isAutoRun = false) => {
    if (!isAutoRun) {
      setLoading(true); setError(''); setResult('');
    }
    let finalCourses = customCourses || courses;
    const finalPobN = customPobN !== undefined ? customPobN : pobN;
    const finalPobE = customPobE !== undefined ? customPobE : pobE;
    if (inputMode === 'text' && !customCourses) {
      if (!pasteText.trim()) { setError('Paste some legal description text first.'); setLoading(false); return; }
      try {
        const data = await authFetch('/deed/solve-text', {
          method: 'POST',
          body: JSON.stringify({
            deedText: pasteText,
            pobNorthing: parseFloat(finalPobN) || 5000,
            pobEasting:  parseFloat(finalPobE)  || 5000,
            units,
          })
        });
        if (data.repairedCourses) {
          finalCourses = data.repairedCourses.map(c => ({
            ...BLANK,
            type: (c.type === 'Meandering Line' || c.type === 'meandering line') ? 'Squiggle' : (c.type || 'Line'),
            bearing: c.bearing || '',
            distance: c.distance != null ? String(c.distance) : '',
            chordBearing: c.chordBearing || '',
            chordDistance: c.chordDistance != null ? String(c.chordDistance) : '',
            arcLength: c.arcLength != null ? String(c.arcLength) : '',
            delta: c.delta != null ? String(c.delta) : '',
            radius: c.radius != null ? String(c.radius) : '',
            curveDirection: c.curveDirection || 'Right',
            description: c.description || '',
            subConnector: c.subConnector || '',
            subFeature: c.subFeature || '',
            subDirection: c.subDirection || '',
          }));
          setCourses(finalCourses);
          if (data.pob) {
            setPobN(String(data.pob.northing));
            setPobE(String(data.pob.easting));
          }
          setInputMode('form');
        } else {
          setError('No courses could be extracted from this text.');
          setLoading(false);
          return;
        }
      } catch (e) {
        setError('Extraction failed: ' + e.message);
        setLoading(false);
        return;
      }
    }
    if (inputMode === 'paste') {
      if (!pasteJson.trim()) { setError('Paste a JSON array of courses first.'); setLoading(false); return; }
      try { finalCourses = JSON.parse(pasteJson); }
      catch { setError('Invalid JSON — check format and try again.'); setLoading(false); return; }
    }
    if (!finalCourses.length) { setError('Add at least one course.'); setLoading(false); return; }

    try {
      const body = {
        courses: finalCourses.map(c => ({
          type: (c.type === 'Meandering Line' || c.type === 'meandering line') ? 'Squiggle' : (c.type ?? 'Line'),
          bearing: c.bearing || null,
          distance: c.distance ? parseFloat(c.distance) : null,
          chordBearing: c.chordBearing || null,
          chordDistance: c.chordDistance ? parseFloat(c.chordDistance) : null,
          arcLength: c.arcLength ? parseFloat(c.arcLength) : null,
          delta: c.delta ? parseFloat(c.delta) : null,
          radius: c.radius ? parseFloat(c.radius) : null,
          curveDirection: c.curveDirection || null,
          description: c.description || null,
          subConnector: c.subConnector || null,
          subFeature: c.subFeature || null,
          subDirection: c.subDirection || null,
        })),
        pobNorthing: parseFloat(finalPobN) || 5000,
        pobEasting:  parseFloat(finalPobE) || 5000,
        parcelDescription: parcel  || null,
        county:   county    || null,
        state:    stateVal  || null,
        units,
        basisOfBearings: basisBrg || null,
        bearingSystem: 'grid bearings',
        areaAcres:  areaAcres  ? parseFloat(areaAcres)  : null,
        perimeter:  perimeter  ? parseFloat(perimeter)  : null,
        bearingSecondsDecimals: parseInt(bearingDecimals, 10),
      };

      const data = await authFetch('/writer/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(data.legalDescription ?? data.LegalDescription ?? JSON.stringify(data));
      if (isAutoRun) setError('');
    } catch (e) {
      if (!isAutoRun) {
        setError(String(e.message));
      }
    } finally {
      if (!isAutoRun) {
        setLoading(false);
      }
    }
  };

  const copy = () => { navigator.clipboard.writeText(result); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const download = () => {
    const blob = new Blob([result], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'legal-description.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (!result) return;
    if (!areCoursesValid(courses)) return;
    const handler = setTimeout(() => {
      generate(undefined, undefined, undefined, true);
    }, 1000);
    return () => clearTimeout(handler);
  }, [courses, pobN, pobE, parcel, county, stateVal, units, basisBrg, areaAcres, perimeter, bearingDecimals]);

  return (
    <div className="writer-container">
      {/* Title Header */}
      <div>
        <h1 className="writer-header-title">
          ✍️ Deed Writer
        </h1>
        <p className="writer-header-subtitle">
          Generate professional registry legal text
        </p>
      </div>

      <div className="split-layout" style={{ alignItems: 'stretch' }}>
        {/* Left Column: Form entry card */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', alignSelf: 'stretch' }}>
          {/* ── Main card ─────────────────────────────────────────────────────────── */}
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="card-header">
              <div className="card-title">✍️ Legal Description Writer</div>
              <div className="flex-row">
                <div className="writer-mode-selector">
                  {[['form', '📋 Form Input'], ['text', '📝 Paste Text'], ['paste', '📌 Paste JSON']].map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setInputMode(v)}
                      className={`writer-mode-btn ${inputMode === v ? 'active' : ''}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <select value={units} onChange={e => setUnits(e.target.value)} style={{ width: 90 }}>
                  <option value="feet">Feet</option>
                  <option value="meters">Meters</option>
                </select>
              </div>
            </div>

            {/* POB */}
            <div className="grid-2" style={{ marginBottom: '1rem' }}>
              <div className="form-group">
                <label className="form-label">POB Northing</label>
                <input type="number" value={pobN} onChange={e => setPobN(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">POB Easting</label>
                <input type="number" value={pobE} onChange={e => setPobE(e.target.value)} />
              </div>
            </div>

            {/* ── FORM MODE: editable course list ───────────────────────────────── */}
            {inputMode === 'form' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <h3>Courses ({courses.length})</h3>
                  <div className="flex-row">
                    <button className="btn btn-ghost btn-sm" onClick={() => setCourses(EXAMPLE)}>Load Example</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => {
                      if(window.confirm('Clear all courses?')) setCourses([]);
                    }}>Clear All</button>
                    <button className="btn btn-primary btn-sm" onClick={addCourse}>+ Add</button>
                  </div>
                </div>

                {/* Column headers */}
                <div className="writer-course-headers">
                  <span>#</span><span>Type</span><span>Details / Bearing</span><span>Distance / Coordinates</span><span>Order</span><span></span>
                </div>

                <div className="writer-course-list">
                  {courses.length === 0 && (
                    <div className="writer-course-empty">
                      No courses yet — click <strong>+ Add</strong> or <strong>Load Example</strong>
                    </div>
                  )}
                  {courses.map((c, i) => (
                    <div key={i}
                      onMouseEnter={() => setHoveredCourseIndex(i)}
                      onMouseLeave={() => setHoveredCourseIndex(null)}
                      onClick={() => setSelectedCourseIndex(i === selectedCourseIndex ? null : i)}
                      className={`writer-course-item ${selectedCourseIndex === i ? 'selected' : ''}`}
                    >
                      {/* Main Input Row */}
                      <div className="writer-course-row" onClick={e => e.stopPropagation()}>
                        <span className="writer-course-num">{i + 1}</span>
                        <select value={(c.type === 'Meandering Line' || c.type === 'meandering line') ? 'Squiggle' : (c.type || 'Line')} onChange={e => update(i, 'type', e.target.value)} style={{ fontSize: '0.8rem' }}>
                          <option value="Line">Line</option>
                          <option value="Curve">Curve</option>
                          <option value="Point of Beginning">Point of Beginning</option>
                          <option value="Point of Reference">Point of Reference</option>
                          <option value="Point">Point</option>
                          <option value="Squiggle">Squiggle</option>
                          <option value="Point of Terminus">Point of Terminus</option>
                        </select>

                        {(c.type === 'Line' || c.type === 'Squiggle') && (
                          <>
                            <div className="writer-bearing-input-wrapper">
                              <input
                                type="text"
                                placeholder="Bearing (e.g. N45°30'00&quot;E)"
                                value={c.bearing}
                                onChange={e => update(i, 'bearing', e.target.value)}
                              />
                              {c.bearing && (() => {
                                const warning = checkBearingWarning(c.bearing);
                                const isValid = validateBearing(c.bearing) || warning;
                                if (warning) {
                                  return (
                                    <span
                                      className="writer-bearing-validation-icon warning"
                                      title={warning}
                                      style={{ color: '#ffb400', cursor: 'help' }}
                                    >
                                      ⚠️
                                    </span>
                                  );
                                }
                                return (
                                  <span className={`writer-bearing-validation-icon ${isValid ? 'valid' : 'invalid'}`}>
                                    {isValid ? '✓' : '✗'}
                                  </span>
                                );
                              })()}
                            </div>
                            <input type="number" placeholder="Distance" value={c.distance} onChange={e => update(i, 'distance', e.target.value)} />
                          </>
                        )}

                        {c.type === 'Curve' && (
                          <>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
                              <div className="writer-bearing-input-wrapper">
                                <input
                                  type="text"
                                  placeholder="Chord Bearing"
                                  value={c.chordBearing}
                                  onChange={e => update(i, 'chordBearing', e.target.value)}
                                />
                                {c.chordBearing && (() => {
                                  const warning = checkBearingWarning(c.chordBearing);
                                  const isValid = validateBearing(c.chordBearing) || warning;
                                  if (warning) {
                                    return (
                                      <span
                                        className="writer-bearing-validation-icon warning"
                                        title={warning}
                                        style={{ color: '#ffb400', cursor: 'help' }}
                                      >
                                        ⚠️
                                      </span>
                                    );
                                  }
                                  return (
                                    <span className={`writer-bearing-validation-icon ${isValid ? 'valid' : 'invalid'}`}>
                                      {isValid ? '✓' : '✗'}
                                    </span>
                                  );
                                })()}
                              </div>
                              <input
                                type="number"
                                placeholder="Delta (DMS)"
                                value={c.delta}
                                onChange={e => {
                                  const val = e.target.value;
                                  const r = parseFloat(c.radius);
                                  const d = parseFloat(val);
                                  if (!isNaN(r) && r > 0 && !isNaN(d) && d > 0 && !c.chordDistance) {
                                    const computedChord = 2 * r * Math.sin((d * Math.PI) / 180 / 2);
                                    setCourses(courses.map((row, idx) => idx === i ? { ...row, delta: val, chordDistance: computedChord.toFixed(2) } : row));
                                  } else {
                                    update(i, 'delta', val);
                                  }
                                }}
                              />
                              <input
                                type="number"
                                placeholder="Radius"
                                value={c.radius}
                                onChange={e => {
                                  const val = e.target.value;
                                  const r = parseFloat(val);
                                  const d = parseFloat(c.delta);
                                  if (!isNaN(r) && r > 0 && !isNaN(d) && d > 0 && !c.chordDistance) {
                                    const computedChord = 2 * r * Math.sin((d * Math.PI) / 180 / 2);
                                    setCourses(courses.map((row, idx) => idx === i ? { ...row, radius: val, chordDistance: computedChord.toFixed(2) } : row));
                                  } else {
                                    update(i, 'radius', val);
                                  }
                                }}
                              />
                            </div>
                            <input
                              type="number"
                              placeholder="Chord Dist"
                              value={c.chordDistance}
                              onChange={e => {
                                const val = e.target.value;
                                const r = parseFloat(c.radius);
                                const ch = parseFloat(val);
                                if (!isNaN(r) && r > 0 && !isNaN(ch) && ch > 0 && ch <= 2 * r && !c.delta) {
                                  const deltaRad = 2 * Math.asin(ch / (2 * r));
                                  const computedDelta = deltaRad * 180 / Math.PI;
                                  setCourses(courses.map((row, idx) => idx === i ? { ...row, chordDistance: val, delta: computedDelta.toFixed(4) } : row));
                                } else {
                                  update(i, 'chordDistance', val);
                                }
                              }}
                            />
                          </>
                        )}

                        {['Point of Beginning', 'Point of Reference', 'Point', 'Point of Terminus'].includes(c.type) && (
                          <>
                            <input type="text" placeholder="Description / Details (Optional)" value={c.description || ''} style={{ gridColumn: 'span 2' }} onChange={e => update(i, 'description', e.target.value)} />
                          </>
                        )}

                        {/* Reorder controls */}
                        <div className="writer-reorder-group">
                          <button
                            className="writer-reorder-btn"
                            disabled={i === 0}
                            onClick={() => moveCourseUp(i)}
                            title="Move Up"
                          >
                            ▲
                          </button>
                          <button
                            className="writer-reorder-btn"
                            disabled={i === courses.length - 1}
                            onClick={() => moveCourseDown(i)}
                            title="Move Down"
                          >
                            ▼
                          </button>
                        </div>

                        <button onClick={() => removeCourse(i)} className="writer-course-delete-btn">✕</button>
                      </div>

                      {/* Sub-item Row */}
                      <div className="writer-sub-item-row" onClick={e => e.stopPropagation()}>
                        <span className="writer-sub-item-label">Support Call:</span>
                        
                        <select value={c.subConnector || ''} onChange={e => update(i, 'subConnector', e.target.value)} style={{ width: '130px', fontSize: '0.75rem', padding: '0.2rem' }}>
                          <option value="">(None)</option>
                          <option value="To:">To:</option>
                          <option value="Along:">Along:</option>
                          <option value="Intersection with:">Intersection with:</option>
                        </select>

                        <select value={c.subDirection || ''} onChange={e => update(i, 'subDirection', e.target.value)} style={{ width: '110px', fontSize: '0.75rem', padding: '0.2rem' }}>
                          <option value="">(None)</option>
                          <option value="NE">NE</option>
                          <option value="NW">NW</option>
                          <option value="SE">SE</option>
                          <option value="SW">SW</option>
                          <option value="S'ly">S'ly</option>
                          <option value="N'ly">N'ly</option>
                        </select>

                        <select value={c.subFeature || ''} onChange={e => update(i, 'subFeature', e.target.value)} style={{ width: '170px', fontSize: '0.75rem', padding: '0.2rem' }}>
                          <option value="">(None)</option>
                          <option value="Right of Way">Right of Way</option>
                          <option value="Road">Road</option>
                          <option value="Edge of Water">Edge of Water</option>
                          <option value="Meandering Line">Meandering Line</option>
                          <option value="Easement">Easement</option>
                          <option value="Traverse Line">Traverse Line</option>
                        </select>

                        {!['Point of Beginning', 'Point of Reference', 'Point', 'Point of Terminus'].includes(c.type) && (
                          <input
                            type="text"
                            placeholder="Custom Description (e.g. along river bank)"
                            value={c.description || ''}
                            onChange={e => update(i, 'description', e.target.value)}
                            className="writer-custom-desc-input"
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ── PASTE TEXT MODE ────────────────────────────────────────────────── */}
            {inputMode === 'text' && (
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label">Paste Legal Description Text</label>
                <textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  placeholder={`BEGINNING at a point... thence North 45°22'10" East, 150.25 feet...`}
                  style={{
                    width: '100%', minHeight: 140, resize: 'vertical',
                    fontFamily: 'inherit', fontSize: '0.85rem', lineHeight: 1.6,
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)', padding: '0.75rem',
                    color: 'var(--text-primary)', boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleExtractText}
                    disabled={loading || !pasteText.trim()}
                  >
                    {loading ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Extracting...</> : '⚡ Extract Courses from Text'}
                  </button>
                </div>
                <div className="alert alert-info" style={{ fontSize: '0.78rem', marginTop: '0.75rem' }}>
                  💡 Paste a raw legal description text here. The system will parse it and load the courses directly into the form.
                </div>
              </div>
            )}

            {/* ── PASTE JSON MODE ────────────────────────────────────────────────── */}
            {inputMode === 'paste' && (
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label">Paste Courses JSON Array</label>
                <textarea
                  value={pasteJson}
                  onChange={e => setPasteJson(e.target.value)}
                  placeholder='[ { "type": "Line", "bearing": "N89-50-00E", "distance": 669.80 }, ... ]'
                  style={{ minHeight: 130, resize: 'vertical', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.8rem' }}
                />
                <div className="alert alert-info" style={{ fontSize: '0.78rem', marginTop: '0.5rem' }}>
                  💡 Run <strong>Traverse Compute</strong> or <strong>Plat Extraction</strong>, copy the raw JSON from the station table, and paste it here.
                </div>
              </div>
            )}

            {/* ── Deed Metadata ──────────────────────────────────────────────────── */}
            <div className="divider" />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>Deed Metadata (Optional)</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                setCounty(''); setStateVal(''); setParcel(''); setBasisBrg(''); setAreaAcres(''); setPerimeter(''); setBearingDecimals('0');
              }}>Clear Metadata</button>
            </div>
            <div className="grid-3" style={{ marginBottom: '0.75rem' }}>
              <div className="form-group">
                <label className="form-label">County</label>
                <input type="text" placeholder="Duval County" value={county} onChange={e => setCounty(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">State</label>
                <input type="text" placeholder="Florida" value={stateVal} onChange={e => setStateVal(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Parcel Description</label>
                <input type="text" placeholder="Lot 12, Block 4…" value={parcel} onChange={e => setParcel(e.target.value)} />
              </div>
            </div>
            <div className="grid-3" style={{ marginBottom: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Basis of Bearings</label>
                <input type="text" placeholder="State Plane Grid" value={basisBrg} onChange={e => setBasisBrg(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Area (acres)</label>
                <input type="number" placeholder="10.298" value={areaAcres} onChange={e => setAreaAcres(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Perimeter (ft)</label>
                <input type="number" placeholder="2679.20" value={perimeter} onChange={e => setPerimeter(e.target.value)} />
              </div>
            </div>
            <div className="grid-2" style={{ marginBottom: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Bearing Seconds Format</label>
                <select value={bearingDecimals} onChange={e => setBearingDecimals(e.target.value)}>
                  <option value="0">S79°37'05"E (Whole Seconds)</option>
                  <option value="1">S79°37'05.7"E (1 Decimal Place)</option>
                  <option value="2">S79°37'05.72"E (2 Decimal Places)</option>
                </select>
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" onClick={generate} disabled={loading} style={{ width: '100%', height: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {loading ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Generating…</> : '✍️ Generate Legal Description'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Sticky live map and results */}
        <div className="sticky-column" style={{ alignSelf: 'stretch' }}>
          {/* Live Map - Always visible! */}
          <div className="card" style={!result ? { flex: 1, display: 'flex', flexDirection: 'column' } : {}}>
            <div className="card-header">
              <div className="card-title">🗺️ Boundary Map (Draft)</div>
            </div>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <TraverseMap
                key={`${courses.length}_${pobN}_${pobE}_${units}`}
                courses={courses}
                pob={{
                  northing: parseFloat(pobN) || 5000,
                  easting: parseFloat(pobE) || 5000
                }}
                hoveredCourseIndex={hoveredCourseIndex}
                setHoveredCourseIndex={setHoveredCourseIndex}
                selectedCourseIndex={selectedCourseIndex}
                setSelectedCourseIndex={setSelectedCourseIndex}
              />
            </div>
          </div>

          {/* Error */}
          {error && <div className="alert alert-error">⚠ {error}</div>}

          {/* Output: Legal Description result */}
          {result && (
            <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div className="card-header">
                <div className="card-title">📄 Legal Description</div>
                <div className="flex-row">
                  <button className="btn btn-ghost btn-sm" onClick={copy}>{copied ? '📋 Copy' : '📋 Copy'}</button>
                  <button className="btn btn-success btn-sm" onClick={download}>⬇ Download .txt</button>
                </div>
              </div>
              <pre style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', padding: '1.25rem',
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: '0.9rem', lineHeight: 2.0, color: 'var(--text-primary)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                flex: 1, overflowY: 'auto'
              }}>
                {result}
              </pre>
            </div>
          )}
        </div>
      </div>

      <ToastPortal />
    </div>
  );
}
