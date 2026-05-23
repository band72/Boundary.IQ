import { useState, useRef } from 'react';
import TraverseMap from './TraverseMap';
import PrintBlueprint from './PrintBlueprint';

const API = 'http://localhost:5050/api';

export default function PlatTab() {
  const [file, setFile]         = useState(null);
  const [preview, setPreview]   = useState(null);
  const [drag, setDrag]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState(null);   // { extraction, traverse, traverseError }
  const [error, setError]       = useState('');
  const [pobN, setPobN]         = useState('5000.00');
  const [pobE, setPobE]         = useState('5000.00');
  const [showPrint, setShowPrint] = useState(false);
  const [mode, setMode]         = useState('extract'); // 'extract' | 'extract-and-compute'
  const fileRef = useRef();

  const handleFile = f => {
    if (!f) return;
    setFile(f); setResult(null); setError('');
    setPreview(URL.createObjectURL(f));
  };

  const run = async () => {
    if (!file) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const fd = new FormData();
      fd.append('image', file);

      let url, res;
      if (mode === 'extract-and-compute') {
        url = `${API}/plat/extract-and-compute?pobN=${pobN}&pobE=${pobE}&units=Feet`;
        res = await fetch(url, { method: 'POST', body: fd });
      } else {
        url = `${API}/plat/extract`;
        res = await fetch(url, { method: 'POST', body: fd });
        // wrap single response to match combined shape
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
        setResult({ extraction: data, traverse: null, traverseError: null });
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const ext = result?.extraction;
  const trav = result?.traverse;
  const isPassing = trav?.closure?.status?.startsWith('✓');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* Header card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">🛰 Plat Image — AI Boundary Extraction</div>
          <div className="flex-row">
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Powered by</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.6rem', fontSize: '0.78rem', fontWeight: 600, color: '#4285f4' }}>
              <span>✦</span> Google Gemini Vision
            </div>
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flex-row" style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 2 }}>
            {[['extract', '🔍 Extract Only'], ['extract-and-compute', '⚡ Extract + Compute']].map(([val, label]) => (
              <button key={val} onClick={() => setMode(val)}
                style={{
                  padding: '0.35rem 0.9rem', border: 'none', borderRadius: 'calc(var(--radius-sm) - 2px)',
                  fontFamily: 'inherit', fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
                  background: mode === val ? 'var(--accent)' : 'transparent',
                  color: mode === val ? '#fff' : 'var(--text-secondary)',
                  transition: 'all 0.15s'
                }}>{label}</button>
            ))}
          </div>
        </div>

        {/* POB (only shown in extract+compute mode) */}
        {mode === 'extract-and-compute' && (
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
        )}

        {/* Drop Zone */}
        <div
          className={`drop-zone ${drag ? 'drag-over' : ''}`}
          onClick={() => fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
        >
          <div className="drop-icon">📡</div>
          {file
            ? <p><strong>{file.name}</strong> &nbsp;·&nbsp; {(file.size / 1024).toFixed(1)} KB</p>
            : <p>Drop a plat file or PDF here or <strong>click to browse</strong><br />
                <span className="text-muted" style={{ fontSize: '0.75rem' }}>JPG · PNG · WebP · PDF — up to 20 MB</span></p>
          }
          <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={e => handleFile(e.target.files[0])} />
        </div>

        {preview && file && !file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf') && (
          <div style={{ marginTop: '0.75rem', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <img src={preview} alt="Plat" style={{ width: '100%', maxHeight: 300, objectFit: 'contain', display: 'block', background: 'var(--bg-elevated)' }} />
          </div>
        )}

        {file && (file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf')) && (
          <div style={{ marginTop: '0.75rem', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border)', padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
            <span style={{ fontSize: '3rem' }}>📄</span>
            <div style={{ marginTop: '0.5rem', fontWeight: 600 }}>{file.name}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>PDF Document</div>
          </div>
        )}

        {file && (
          <div className="flex-row mt-2" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => { setFile(null); setPreview(null); setResult(null); }}>Clear</button>
            <button className="btn btn-primary" onClick={run} disabled={loading}>
              {loading
                ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Analyzing with Gemini…</>
                : mode === 'extract-and-compute' ? '⚡ Extract + Compute' : '🔍 Extract Boundary'}
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && <div className="alert alert-error">⚠ {error}</div>}

      {/* Extraction Results */}
      {ext && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">✅ Extracted Boundary Courses</div>
            <div className="flex-row">
              <span className="status-badge pass">{ext.courses.length} courses</span>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(ext.courses, null, 2));
                alert('Copied courses to clipboard!');
              }}>Copy JSON</button>
            </div>
          </div>
          {ext.message && <div className="alert alert-info" style={{ marginBottom: '1rem', fontSize: '0.8rem' }}>{ext.message}</div>}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>#</th><th>Type</th><th>Bearing / Chord Bearing</th><th>Distance / Arc Len</th><th>Delta</th><th>Radius</th><th>Direction</th></tr>
              </thead>
              <tbody>
                {ext.courses.map((c, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td><span style={{ color: c.type === 'Curve' ? 'var(--warning)' : 'var(--accent)', fontWeight: 500 }}>{c.type}</span></td>
                    <td>{c.bearing || c.chordBearing || '—'}</td>
                    <td>{c.distance ?? c.arcLength ?? c.chordDistance ?? '—'}</td>
                    <td>{c.delta ?? '—'}</td>
                    <td>{c.radius ?? '—'}</td>
                    <td>{c.curveDirection ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Traverse error warning */}
      {result?.traverseError && (
        <div className="alert alert-error">⚠ {result.traverseError}</div>
      )}

      {/* Traverse Results (extract-and-compute mode) */}
      {trav && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">📊 Closure Report</div>
            <span className={`status-badge ${isPassing ? 'pass' : 'fail'}`}>
              {isPassing ? '✓ Passes' : '✗ Fails'} &nbsp;{trav.closure.precisionRatio}
            </span>
          </div>
          <div className="closure-grid">
            {[
              ['Precision', trav.closure.precisionRatio, isPassing ? 'pass' : 'fail'],
              ['Linear Error', `${trav.closure.linearError.toFixed(4)}'`, 'neutral'],
              ['Error N', `${trav.closure.errorNorthing.toFixed(4)}'`, 'neutral'],
              ['Error E', `${trav.closure.errorEasting.toFixed(4)}'`, 'neutral'],
              ['Perimeter', `${trav.perimeter.toFixed(2)}'`, 'neutral'],
              ['Area', `${trav.areaAcres.toFixed(4)} ac`, 'neutral'],
            ].map(([label, value, cls]) => (
              <div className="closure-stat" key={label}>
                <div className="label">{label}</div>
                <div className={`value ${cls}`}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {ext?.courses?.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">🗺 Traverse Map</div>
             <button className="btn btn-ghost btn-sm" onClick={() => setShowPrint(true)}>
               🖨 Print Blueprint
             </button>
          </div>
          <TraverseMap stations={trav?.stations} adjusted={trav?.adjustedStations} courses={ext?.courses} />
        </div>
      )}

      {/* Raw Gemini JSON (collapsible) */}
      {ext?.rawJson && (
        <details style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            🔤 Raw Gemini JSON Output
          </summary>
          <pre style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-mono)', overflowX: 'auto', whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto' }}>
            {ext.rawJson}
          </pre>
        </details>
      )}
      {showPrint && ext?.courses?.length > 0 && (
        <PrintBlueprint
          courses={ext.courses}
          stations={trav?.stations || []}
          adjusted={trav?.adjustedStations || []}
          units="Feet"
          area={trav?.areaAcres || 0}
          perimeter={trav?.perimeter || 0}
          pob={{ northing: parseFloat(pobN), easting: parseFloat(pobE) }}
          initialLegalDescription={''}
          onClose={() => setShowPrint(false)}
        />
      )}
    </div>
  );
}
