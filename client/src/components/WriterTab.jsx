import { useState } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { authFetch } from '../api';
import { useToast } from '../hooks/useToast';
import TraverseMap from './TraverseMap';

const BLANK = { type: 'Line', bearing: '', distance: '', chordBearing: '', chordDistance: '', arcLength: '', delta: '', radius: '', curveDirection: 'Right', description: '', subConnector: '', subFeature: '', subDirection: '' };
const EXAMPLE = [
  { ...BLANK, bearing: 'N89-50-00E', distance: '669.80' },
  { ...BLANK, bearing: 'S00-35-00E', distance: '669.80' },
  { ...BLANK, bearing: 'S89-50-00W', distance: '669.80' },
  { ...BLANK, bearing: 'N00-35-00W', distance: '669.80' },
];

export default function WriterTab() {
  const [courses, setCourses]     = useLocalStorage('boundaryiq_writer_courses', EXAMPLE);
  const [pobN, setPobN]           = useLocalStorage('boundaryiq_writer_pobN', '5000.00');
  const [pobE, setPobE]           = useLocalStorage('boundaryiq_writer_pobE', '5000.00');
  const [parcel, setParcel]       = useLocalStorage('boundaryiq_writer_parcel', '');
  const [county, setCounty]       = useLocalStorage('boundaryiq_writer_county', '');
  const [stateVal, setStateVal]   = useLocalStorage('boundaryiq_writer_state', '');
  const [units, setUnits]         = useLocalStorage('boundaryiq_writer_units', 'feet');
  const [basisBrg, setBasisBrg]   = useLocalStorage('boundaryiq_writer_basisBrg', '');
  const [areaAcres, setAreaAcres] = useLocalStorage('boundaryiq_writer_area', '');
  const [perimeter, setPerimeter] = useLocalStorage('boundaryiq_writer_perimeter', '');
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
        if (data.pob) {
          setPobN(String(data.pob.northing));
          setPobE(String(data.pob.easting));
        }
        setInputMode('form');
        showToast(`Successfully extracted ${newCourses.length} courses from text!`);
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

  // ── Generate ────────────────────────────────────────────────────────────────
  const generate = async () => {
    setLoading(true); setError(''); setResult('');
    let finalCourses = courses;
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
        pobNorthing: parseFloat(pobN) || 5000,
        pobEasting:  parseFloat(pobE) || 5000,
        parcelDescription: parcel  || null,
        county:   county    || null,
        state:    stateVal  || null,
        units,
        basisOfBearings: basisBrg || null,
        bearingSystem: 'grid bearings',
        areaAcres:  areaAcres  ? parseFloat(areaAcres)  : null,
        perimeter:  perimeter  ? parseFloat(perimeter)  : null,
      };

      const data = await authFetch('/writer/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(data.legalDescription ?? data.LegalDescription ?? JSON.stringify(data));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setLoading(false);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      <div className="split-layout" style={{ alignItems: 'stretch' }}>
        {/* Left Column: Form entry card */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', alignSelf: 'stretch' }}>
          {/* ── Main card ─────────────────────────────────────────────────────────── */}
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="card-header">
              <div className="card-title">✍️ Legal Description Writer</div>
              <div className="flex-row">
                <div style={{ display: 'flex', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 2 }}>
                  {[['form', '📋 Form Input'], ['text', '📝 Paste Text'], ['paste', '📌 Paste JSON']].map(([v, label]) => (
                    <button key={v} onClick={() => setInputMode(v)} style={{
                      padding: '0.35rem 0.9rem', border: 'none', fontFamily: 'inherit', fontSize: '0.8rem',
                      fontWeight: 500, cursor: 'pointer', borderRadius: 'calc(var(--radius-sm) - 2px)',
                      background: inputMode === v ? 'var(--accent)' : 'transparent',
                      color: inputMode === v ? '#fff' : 'var(--text-secondary)', transition: 'all 0.15s',
                    }}>{label}</button>
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
                <div style={{ display: 'grid', gridTemplateColumns: '28px 150px 1fr 120px 32px', gap: '0.5rem', padding: '0 0.5rem 0.4rem', fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <span>#</span><span>Type</span><span>Details / Bearing</span><span>Distance / Coordinates</span><span></span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
                  {courses.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.85rem', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border)' }}>
                      No courses yet — click <strong>+ Add</strong> or <strong>Load Example</strong>
                    </div>
                  )}
                  {courses.map((c, i) => (
                    <div key={i}
                      onMouseEnter={() => setHoveredCourseIndex(i)}
                      onMouseLeave={() => setHoveredCourseIndex(null)}
                      onClick={() => setSelectedCourseIndex(i === selectedCourseIndex ? null : i)}
                      style={{
                        display: 'flex', flexDirection: 'column', gap: '0.5rem',
                        background: selectedCourseIndex === i ? 'var(--accent-glow)' : 'var(--bg-elevated)',
                        border: `1px solid ${selectedCourseIndex === i ? 'var(--accent)' : hoveredCourseIndex === i ? 'var(--accent2)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.75rem',
                        cursor: 'pointer',
                        transition: 'all 0.15s'
                      }}
                    >
                      {/* Main Input Row */}
                      <div style={{ display: 'grid', gridTemplateColumns: '28px 150px 1fr 120px 32px', gap: '0.5rem', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center' }}>{i + 1}</span>
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
                            <input type="text" placeholder="Bearing (e.g. N45°30'00&quot;E)" value={c.bearing} onChange={e => update(i, 'bearing', e.target.value)} />
                            <input type="number" placeholder="Distance" value={c.distance} onChange={e => update(i, 'distance', e.target.value)} />
                          </>
                        )}

                        {c.type === 'Curve' && (
                          <>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
                              <input type="text" placeholder="Chord Bearing" value={c.chordBearing} onChange={e => update(i, 'chordBearing', e.target.value)} />
                              <input type="number" placeholder="Delta (DMS)" value={c.delta} onChange={e => update(i, 'delta', e.target.value)} />
                              <input type="number" placeholder="Radius" value={c.radius} onChange={e => update(i, 'radius', e.target.value)} />
                            </div>
                            <input type="number" placeholder="Chord Dist" value={c.chordDistance} onChange={e => update(i, 'chordDistance', e.target.value)} />
                          </>
                        )}

                        {['Point of Beginning', 'Point of Reference', 'Point', 'Point of Terminus'].includes(c.type) && (
                          <>
                            <input type="text" placeholder="Description / Details (Optional)" value={c.description || ''} style={{ gridColumn: 'span 2' }} onChange={e => update(i, 'description', e.target.value)} />
                          </>
                        )}

                        <button onClick={() => removeCourse(i)} style={{ background: 'rgba(255,77,109,0.15)', border: '1px solid rgba(255,77,109,0.3)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: '0.25rem 0.4rem', fontSize: '0.75rem', height: '100%' }}>✕</button>
                      </div>

                      {/* Sub-item Row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', paddingLeft: '33px', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '0.4rem' }} onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, marginRight: '0.25rem' }}>Support Call:</span>
                        
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
                            style={{ flexGrow: 1, fontSize: '0.75rem', padding: '0.2rem 0.4rem', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
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
                if(window.confirm('Clear all metadata fields?')) {
                  setCounty(''); setStateVal(''); setParcel('');
                  setBasisBrg(''); setAreaAcres(''); setPerimeter('');
                }
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

            <div className="flex-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={generate} disabled={loading}>
                {loading ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Generating…</> : '✍️ Generate Legal Description'}
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Sticky live map and results */}
        <div className="sticky-column" style={{ alignSelf: 'stretch' }}>
          {/* Live Map - Always visible! */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">🗺️ Boundary Map (Draft)</div>
            </div>
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

          {/* Error */}
          {error && <div className="alert alert-error">⚠ {error}</div>}

          {/* Output: Legal Description result */}
          {result && (
            <div className="card">
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
