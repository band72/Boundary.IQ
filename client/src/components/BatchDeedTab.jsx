import { useState, useRef } from 'react';
import TraverseMap from './TraverseMap';
import { useLocalStorage } from '../hooks/useLocalStorage';

const API = 'http://localhost:5050/api';

export default function BatchDeedTab() {
  const [files, setFiles]       = useState([]);     // File[]
  const [drag, setDrag]         = useState(false);
  const [pobN, setPobN]         = useLocalStorage('boundaryiq_batch_pobn', '5000.00');
  const [pobE, setPobE]         = useLocalStorage('boundaryiq_batch_pobe', '5000.00');
  const [county, setCounty]     = useLocalStorage('boundaryiq_batch_county', '');
  const [stateVal, setStateVal] = useLocalStorage('boundaryiq_batch_state', '');
  const [loading, setLoading]   = useState(false);
  const [results, setResults]   = useState(null);   // BatchDeedResult | null
  const [error, setError]       = useState('');
  const [expanded, setExpanded] = useState({});
  const fileRef = useRef();

  const addFiles = newFiles => {
    const arr = Array.from(newFiles).filter(f => f.type.startsWith('image/'));
    setFiles(prev => {
      const names = new Set(prev.map(f => f.name));
      return [...prev, ...arr.filter(f => !names.has(f.name))].slice(0, 20);
    });
    setResults(null); setError('');
  };

  const removeFile = name => { setFiles(f => f.filter(x => x.name !== name)); setResults(null); };
  const clearCompleted = () => {
    if (!results) return;
    const completedNames = new Set(results.results.map(r => r.fileName));
    setFiles(f => f.filter(x => !completedNames.has(x.name)));
    setResults(null);
  };

  const runBatch = async () => {
    if (!files.length) return;
    setLoading(true); setError(''); setResults(null); setExpanded({});
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('images', f));

      const params = new URLSearchParams({
        pobN, pobE, units: 'Feet',
        ...(county   ? { county }        : {}),
        ...(stateVal ? { state: stateVal } : {}),
      });

      const res  = await fetch(`${API}/batchdeed/process?${params}`, { method: 'POST', body: fd });
      const text = await res.text();

      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Server returned non-JSON: ${text.slice(0, 200)}`); }

      if (!res.ok) throw new Error(data?.error ?? `Server error ${res.status}`);
      setResults(data);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  };

  const toggle = i => setExpanded(e => ({ ...e, [i]: !e[i] }));

  const downloadAll = () => {
    if (!results?.results?.length) return;
    const text = results.results.map((r, i) => {
      const sep = '='.repeat(72);
      if (r.status === 'error') return `${sep}\nFILE ${i + 1}: ${r.fileName}\nERROR: ${r.error}\n${sep}`;
      const prec = r.traverse?.closure?.precisionRatio ?? '—';
      const area = r.traverse?.areaAcres?.toFixed(4) ?? '—';
      const ld   = r.legalDescription?.legalDescription ?? '(no legal description)';
      return `${sep}\nFILE ${i + 1}: ${r.fileName}\nPrecision: ${prec}  |  Area: ${area} ac\n\n${ld}\n${sep}`;
    }).join('\n\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
      download: 'batch-deeds.txt',
    });
    a.click();
  };

  const downloadJson = () => {
    if (!results?.results?.length) return;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([JSON.stringify(results.results, null, 2)], { type: 'application/json' })),
      download: 'batch-results.json',
    });
    a.click();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* ── Setup ─────────────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">📦 Batch Deed Processing</div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Up to 20 plat images · Extract → Compute → Legal Description</span>
        </div>

        <div className="grid-3" style={{ marginBottom: '1rem' }}>
          <div className="form-group">
            <label className="form-label">Default POB Northing</label>
            <input type="number" value={pobN} onChange={e => setPobN(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Default POB Easting</label>
            <input type="number" value={pobE} onChange={e => setPobE(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <div className="form-group">
              <label className="form-label">County</label>
              <input type="text" placeholder="Duval" value={county} onChange={e => setCounty(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">State</label>
              <input type="text" placeholder="FL" value={stateVal} onChange={e => setStateVal(e.target.value)} />
            </div>
          </div>
        </div>

        {/* Drop zone */}
        <div
          className={`drop-zone ${drag ? 'drag-over' : ''}`}
          style={{ padding: '2rem' }}
          onClick={() => fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
        >
          <div className="drop-icon">🗂</div>
          <p>Drop plat images here or <strong>click to browse</strong><br />
            <span className="text-muted" style={{ fontSize: '0.75rem' }}>JPG · PNG · WebP — up to 20 files</span></p>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => addFiles(e.target.files)} />
        </div>

        {/* File queue — always visible once files are added */}
        {files.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <h3>{files.length} file{files.length !== 1 ? 's' : ''} queued</h3>
              {!loading && (
                <div className="flex-row">
                  {results && <button className="btn btn-ghost btn-sm" onClick={clearCompleted}>Clear Completed</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => { setFiles([]); setResults(null); }}>Clear All</button>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {files.map((f, i) => {
                const r = results?.results?.[i];
                const done = !!r;
                const success = r?.status === 'success';
                return (
                  <div key={f.name} style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                    background: 'var(--bg-elevated)', border: `1px solid ${done ? (success ? 'rgba(0,212,168,0.3)' : 'rgba(255,77,109,0.3)') : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem',
                    transition: 'border-color 0.3s',
                  }}>
                    <span style={{ fontSize: '1rem' }}>
                      {loading ? '⚙️' : done ? (success ? '✅' : '✗') : '📄'}
                    </span>
                    <span style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{(f.size / 1024).toFixed(0)} KB</span>
                    {done && r?.traverse && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap', color: r.traverse.closure.status.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>
                        {r.traverse.closure.precisionRatio}
                      </span>
                    )}
                    {done && r?.status === 'error' && (
                      <span style={{ fontSize: '0.72rem', color: 'var(--danger)' }}>Error</span>
                    )}
                    {!loading && !done && (
                      <button onClick={() => removeFile(f.name)} style={{ background: 'rgba(255,77,109,0.12)', border: '1px solid rgba(255,77,109,0.3)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}>✕</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex-row mt-2" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={runBatch} disabled={loading || files.length === 0}>
            {loading
              ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Processing {files.length} file{files.length !== 1 ? 's' : ''}…</>
              : `⚡ Run Batch${files.length > 0 ? ` (${files.length})` : ''}`}
          </button>
        </div>
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────────── */}
      {error && <div className="alert alert-error">⚠ {error}</div>}

      {/* ── Results summary + download ─────────────────────────────────────────── */}
      {results && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">📊 Results — {results.totalProcessed} processed</div>
            <div className="flex-row">
              <span className="status-badge pass">✓ {results.succeeded} OK</span>
              {results.failed > 0 && <span className="status-badge fail">✗ {results.failed} failed</span>}
              <button className="btn btn-ghost btn-sm" onClick={downloadJson}>⬇ Export JSON</button>
              <button className="btn btn-success btn-sm" onClick={downloadAll}>⬇ Download All (.txt)</button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {results.results.map((r, i) => (
              <div key={i} style={{ border: `1px solid ${r.status === 'success' ? 'rgba(0,212,168,0.25)' : 'rgba(255,77,109,0.25)'}`, borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>

                {/* Accordion header */}
                <div onClick={() => toggle(i)} style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.75rem 1rem', cursor: 'pointer',
                  background: 'var(--bg-elevated)', userSelect: 'none',
                }}>
                  <span>{r.status === 'success' ? '✅' : '✗'}</span>
                  <span style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.fileName}</span>
                  {r.extraction && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.extraction.courses.length} courses</span>}
                  {r.traverse && (
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', color: r.traverse.closure.status.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>
                      {r.traverse.closure.precisionRatio}
                    </span>
                  )}
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{expanded[i] ? '▲' : '▼'}</span>
                </div>

                {/* Accordion body */}
                {expanded[i] && (
                  <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', borderTop: '1px solid var(--border)' }}>

                    {r.status === 'error' && (
                      <div className="alert alert-error">⚠ {r.error}</div>
                    )}

                    {/* Closure stats */}
                    {r.traverse && (
                      <div className="closure-grid">
                        {[
                          ['Precision', r.traverse.closure.precisionRatio, r.traverse.closure.status.startsWith('✓') ? 'pass' : 'fail'],
                          ['Linear Error', `${r.traverse.closure.linearError.toFixed(4)}'`, 'neutral'],
                          ['Perimeter',    `${r.traverse.perimeter.toFixed(2)}'`,           'neutral'],
                          ['Area',         `${r.traverse.areaAcres.toFixed(4)} ac`,          'neutral'],
                        ].map(([label, value, cls]) => (
                          <div className="closure-stat" key={label}>
                            <div className="label">{label}</div>
                            <div className={`value ${cls}`}>{value}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Traverse map */}
                    {r.traverse && (
                      <TraverseMap
                        stations={r.traverse.stations}
                        adjusted={r.traverse.adjustedStations}
                      />
                    )}

                    {/* Extracted courses */}
                    {r.extraction?.courses?.length > 0 && (
                      <div>
                        <h3 style={{ marginBottom: '0.5rem' }}>Extracted Courses</h3>
                        <div className="data-table-wrap">
                          <table className="data-table">
                            <thead><tr><th>#</th><th>Type</th><th>Bearing / Chord</th><th>Dist / Arc</th></tr></thead>
                            <tbody>
                              {r.extraction.courses.map((c, j) => (
                                <tr key={j}>
                                  <td>{j + 1}</td>
                                  <td style={{ color: c.type === 'Curve' ? 'var(--warning)' : 'var(--accent)', fontWeight: 500 }}>{c.type}</td>
                                  <td>{c.bearing || c.chordBearing || '—'}</td>
                                  <td>{c.distance ?? c.arcLength ?? c.chordDistance ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Legal description */}
                    {r.legalDescription?.legalDescription && (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                          <h3>Legal Description</h3>
                          <button className="btn btn-ghost btn-sm"
                            onClick={() => navigator.clipboard.writeText(r.legalDescription.legalDescription)}>
                            📋 Copy
                          </button>
                        </div>
                        <pre style={{
                          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)', padding: '1rem',
                          fontFamily: 'Georgia, serif', fontSize: '0.85rem', lineHeight: 1.9,
                          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto',
                        }}>
                          {r.legalDescription.legalDescription}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
