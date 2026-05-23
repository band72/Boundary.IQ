import { useState, useRef, useEffect } from 'react';
import TraverseMap from './TraverseMap';
import PrintBlueprint from './PrintBlueprint';
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
  const [activeIdx, setActiveIdx] = useState(0);
  const [showPrint, setShowPrint] = useState(false);
  
  // Diagnostics Database state
  const [dbQuery, setDbQuery]       = useState('');
  const [dbStatus, setDbStatus]     = useState('');
  const [dbMaxError, setDbMaxError] = useState('');
  const [dbLogs, setDbLogs]         = useState([]);
  const [dbLoading, setDbLoading]   = useState(false);
  const [heuristics, setHeuristics] = useState([]);

  const fetchHeuristics = async () => {
    try {
      const res = await fetch(`${API}/diagnostics/heuristics`);
      if (res.ok) {
        const data = await res.json();
        setHeuristics(data);
      }
    } catch (e) { console.error(e); }
  };

  const searchDatabase = async () => {
    setDbLoading(true);
    try {
      const params = new URLSearchParams();
      if (dbQuery) params.append('query', dbQuery);
      if (dbStatus) params.append('status', dbStatus);
      if (dbMaxError) params.append('maxError', dbMaxError);

      const res = await fetch(`${API}/diagnostics/search?${params}`);
      if (res.ok) {
        const data = await res.json();
        setDbLogs(data);
      }
    } catch (e) { console.error(e); }
    finally { setDbLoading(false); }
  };

  // Initial load
  useEffect(() => {
    fetchHeuristics();
    searchDatabase();
  }, []);

  const fileRef = useRef();

  const addFiles = newFiles => {
    const arr = Array.from(newFiles).filter(f => f.type.startsWith('image/') || f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
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
    setLoading(true); setError(''); setResults(null); setExpanded({}); setActiveIdx(0);
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
          <p>Drop plat files or PDFs here or <strong>click to browse</strong><br />
            <span className="text-muted" style={{ fontSize: '0.75rem' }}>JPG · PNG · WebP · PDF — up to 20 files</span></p>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden onChange={e => addFiles(e.target.files)} />
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
        <div className="card" style={{ maxWidth: '100%' }}>
          <div className="card-header" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div>
              <div className="card-title">📊 Results — {results.totalProcessed} processed</div>
              <span className="text-muted" style={{ fontSize: '0.72rem' }}>Click any file tab below to inspect its detailed split-view</span>
            </div>
            <div className="flex-row">
              <span className="status-badge pass">✓ {results.succeeded} OK</span>
              {results.failed > 0 && <span className="status-badge fail">✗ {results.failed} failed</span>}
              <button className="btn btn-ghost btn-sm" onClick={downloadJson}>⬇ Export JSON</button>
              <button className="btn btn-success btn-sm" onClick={downloadAll}>⬇ Download All (.txt)</button>
            </div>
          </div>

          {/* Horizontal file selector tabs */}
          <div style={{
            display: 'flex',
            gap: '0.5rem',
            overflowX: 'auto',
            paddingBottom: '0.75rem',
            borderBottom: '1px solid var(--border)',
            marginBottom: '1.25rem'
          }}>
            {results.results.map((r, i) => {
              const success = r.status === 'success';
              return (
                <button
                  key={i}
                  className={`btn ${activeIdx === i ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveIdx(i)}
                  style={{
                    whiteSpace: 'nowrap',
                    padding: '0.4rem 0.8rem',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    border: activeIdx === i ? '1px solid var(--accent)' : '1px solid transparent',
                    background: activeIdx === i ? 'var(--accent)' : 'var(--bg-elevated)',
                    color: activeIdx === i ? '#fff' : 'var(--text-secondary)',
                    borderRadius: 'var(--radius-sm)'
                  }}
                >
                  <span>{success ? '✅' : '❌'}</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{r.fileName}</span>
                </button>
              );
            })}
          </div>

          {/* Active Result Split Window */}
          {(() => {
            const r = results.results[activeIdx];
            if (!r) return null;

            return (
              <div className="grid-2" style={{ gap: '1.5rem', alignItems: 'start' }}>
                
                {/* Left Panel: OCR Output */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    padding: '1.25rem'
                  }}>
                    <h3 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                      <span>🔤</span> OCR & Boundary Extraction
                    </h3>
                    
                    {r.status === 'error' && (
                      <div className="alert alert-error">⚠ {r.error}</div>
                    )}

                    {r.extraction?.courses?.length > 0 ? (
                      <div className="data-table-wrap" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Type</th>
                              <th>Bearing / Chord</th>
                              <th>Dist / Arc</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.extraction.courses.map((c, j) => (
                              <tr key={j}>
                                <td>{j + 1}</td>
                                <td style={{ color: c.type === 'Curve' ? 'var(--warning)' : 'var(--accent)', fontWeight: 500 }}>
                                  {c.type}
                                </td>
                                <td>{c.bearing || c.chordBearing || '—'}</td>
                                <td>{c.distance ?? c.arcLength ?? c.chordDistance ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      r.status === 'success' && <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No boundary courses extracted.</div>
                    )}
                  </div>

                  {r.legalDescription?.legalDescription && (
                    <div style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      padding: '1.25rem'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, fontSize: '0.95rem' }}>
                          <span>✍️</span> Generated Legal Description
                        </h3>
                        <button className="btn btn-ghost btn-sm"
                          onClick={() => navigator.clipboard.writeText(r.legalDescription.legalDescription)}>
                          📋 Copy
                        </button>
                      </div>
                      <pre style={{
                        background: 'var(--bg-card)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)', padding: '1rem',
                        fontFamily: 'Georgia, serif', fontSize: '0.85rem', lineHeight: 1.9,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 250, overflowY: 'auto',
                      }}>
                        {r.legalDescription.legalDescription}
                      </pre>
                    </div>
                  )}
                </div>

                {/* Right Panel: Parcel Map & Closure */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {r.extraction?.courses?.length > 0 && (
                    <div style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      padding: '1.25rem'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                          <span>🗺️</span> Parcel Map
                        </h3>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowPrint(true)}>
                          🖨 Print Blueprint
                        </button>
                      </div>
                      <div style={{ borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                        <TraverseMap
                          stations={r.traverse?.stations}
                          adjusted={r.traverse?.adjustedStations}
                          courses={r.extraction?.courses}
                        />
                      </div>
                    </div>
                  )}

                  {r.traverse && (
                    <div style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      padding: '1.25rem'
                    }}>
                      <h3 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                        <span>📊</span> Closure Report
                      </h3>
                      <div className="closure-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                        {[
                          ['Precision', r.traverse.closure.precisionRatio, r.traverse.closure.status.startsWith('✓') ? 'pass' : 'fail'],
                          ['Linear Error', `${r.traverse.closure.linearError.toFixed(4)}'`, 'neutral'],
                          ['Perimeter',    `${r.traverse.perimeter.toFixed(2)}'`,           'neutral'],
                          ['Area',         `${r.traverse.areaAcres.toFixed(4)} ac`,          'neutral'],
                        ].map(([label, value, cls]) => (
                          <div className="closure-stat" key={label} style={{ padding: '0.5rem 0.75rem', background: 'var(--bg-card)' }}>
                            <div className="label" style={{ fontSize: '0.7rem' }}>{label}</div>
                            <div className={`value ${cls}`} style={{ fontSize: '1rem' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

              </div>
            );
          })()}
        </div>
      )}
      {/* ── Diagnostics Database Case Finder & Heuristics Telemetry ─────────── */}
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
          <div className="card-title">🔍 Heuristics & Diagnostics Case Finder</div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Search historical surveyor deeds & monitor AI-driven correction telemetry (SQLite Sync)
          </span>
        </div>

        {/* 1. Heuristics Telemetry Counters */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem'
        }}>
          {heuristics.map(h => (
            <div key={h.id} style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.75rem 1rem',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: '0.2rem'
            }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
                {h.problemName}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                {h.solutionApplied}
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent2)', marginTop: '0.25rem' }}>
                {h.successCount} Solved Cases
              </div>
            </div>
          ))}
        </div>

        <div className="divider" style={{ margin: '1rem 0' }} />

        {/* 2. Advanced Search Form Filters */}
        <div style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          marginBottom: '1.25rem'
        }}>
          <div style={{ flex: 2, minWidth: 200 }}>
            <label className="form-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Search Case File or Region</label>
            <input 
              type="text" 
              placeholder="e.g. Cook County or plat_image.png..."
              value={dbQuery}
              onChange={e => setDbQuery(e.target.value)}
              style={{ width: '100%', padding: '0.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <label className="form-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Status</label>
            <select 
              value={dbStatus} 
              onChange={e => setDbStatus(e.target.value)}
              style={{ width: '100%', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', color: 'var(--text-primary)' }}
            >
              <option value="">All Statuses</option>
              <option value="PASS">PASS (Closed)</option>
              <option value="FAIL">FAIL (Unclosed)</option>
              <option value="ERROR">ERROR</option>
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label className="form-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Max Error Limit (ft)</label>
            <input 
              type="number" 
              step="0.01"
              placeholder="e.g. 0.30"
              value={dbMaxError}
              onChange={e => setDbMaxError(e.target.value)}
              style={{ width: '100%', padding: '0.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
            />
          </div>
          <button className="btn btn-primary" onClick={searchDatabase} style={{ height: '38px', padding: '0 1.25rem' }}>
            {dbLoading ? 'Searching...' : '🔍 Find Cases'}
          </button>
        </div>

        {/* 3. Results Table Grid */}
        <div className="data-table-wrap" style={{ maxHeight: '350px', overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>File Name</th>
                <th>Region / Parcel</th>
                <th>Calls</th>
                <th>Closure Error</th>
                <th>Precision Ratio</th>
                <th>Status</th>
                <th>Heuristic Repair Stage</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {dbLogs.length > 0 ? (
                dbLogs.map(log => (
                  <tr key={log.id}>
                    <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem' }}>{log.fileName}</td>
                    <td>{log.parcelName || '—'}</td>
                    <td>{log.geoCallCount}</td>
                    <td style={{ fontFamily: 'JetBrains Mono' }}>
                      {log.linearError > 900 ? '—' : `${log.linearError.toFixed(4)}'`}
                    </td>
                    <td style={{ fontFamily: 'JetBrains Mono' }}>
                      {log.precisionRatio > 0 ? `1:${log.precisionRatio.toLocaleString()}` : '—'}
                    </td>
                    <td>
                      <span className={`status-badge ${log.status === 'PASS' ? 'pass' : 'fail'}`} style={{ fontSize: '0.65rem', padding: '2px 6px' }}>
                        {log.status}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{log.repairStageUsed || '—'}</td>
                    <td style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{log.timestamp}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="8" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No matching cases found in the diagnostics database. Run new batch extractions to save records.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showPrint && results && (
        (() => {
          const r = results.results[activeIdx];
          if (!r) return null;
          return (
            <PrintBlueprint
              courses={r.extraction?.courses || []}
              stations={r.traverse?.stations || []}
              adjusted={r.traverse?.adjustedStations || []}
              units="Feet"
              area={r.traverse?.areaAcres || 0}
              perimeter={r.traverse?.perimeter || 0}
              pob={{ northing: parseFloat(pobN), easting: parseFloat(pobE) }}
              initialLegalDescription={r.legalDescription?.legalDescription || ''}
              onClose={() => setShowPrint(false)}
            />
          );
        })()
      )}
    </div>
  );
}
