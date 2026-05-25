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
  const [concurrentAgents]      = useLocalStorage('boundaryiq_concurrent_agents', 5);
  const [loading, setLoading]   = useState(false);
  const [results, setResults]   = useState(null);   // BatchDeedResult | null
  const [error, setError]       = useState('');
  const [expanded, setExpanded] = useState({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [showPrint, setShowPrint] = useState(false);
  
  const [dbQuery, setDbQuery]       = useState('');
  const [dbStatus, setDbStatus]     = useState('');
  const [dbMaxError, setDbMaxError] = useState('');
  const [dbLogs, setDbLogs]         = useState([]);
  const [dbLoading, setDbLoading]   = useState(false);
  const [heuristics, setHeuristics] = useState([]);

  // Folder Scan state
  const [folderPath, setFolderPath] = useLocalStorage('boundaryiq_folder_path', '/home/friend/Downloads/TrainPDF/Regency-Title');
  const [folderManifest, setFolderManifest] = useState(null);
  const [folderScanLoading, setFolderScanLoading] = useState(false);
  const [folderBatchLoading, setFolderBatchLoading] = useState(false);
  const [folderBatchProgress, setFolderBatchProgress] = useState(null); // {current, total, results[], startTime}
  const [batchStatuses, setBatchStatuses] = useState([]); // per-batch: {idx, status, count, error}
  const [folderError, setFolderError] = useState('');
  const [parallelBatches] = useLocalStorage('boundaryiq_parallel_batches', 1);

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

  // Recursively convert PascalCase keys to camelCase (DB stores PascalCase, UI expects camelCase)
  const toCamel = (obj) => {
    if (Array.isArray(obj)) return obj.map(toCamel);
    if (obj !== null && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [
          k.charAt(0).toLowerCase() + k.slice(1),
          toCamel(v),
        ])
      );
    }
    return obj;
  };

  // Load a historical deed log back into the active results view
  const loadFromDb = async (log) => {
    try {
      const rawExtraction = log.extractionJson ? JSON.parse(log.extractionJson) : null;
      const rawTraverse   = log.traverseJson   ? JSON.parse(log.traverseJson)   : null;
      if (!rawExtraction) { alert('No extraction data saved for this entry.'); return; }

      // Convert PascalCase → camelCase so the React views can read them
      const extraction = toCamel(rawExtraction);
      const traverse   = rawTraverse ? toCamel(rawTraverse) : null;

      // Regenerate legal description from the stored courses
      let legalDescription = null;
      const rawCourses = rawExtraction.Courses || rawExtraction.courses || [];
      if (rawCourses.length > 0) {
        try {
          const writeRes = await fetch(`${API}/writer/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              courses: rawCourses,
              pobNorthing: parseFloat(pobN),
              pobEasting: parseFloat(pobE),
              parcelDescription: null,
              county: county || null,
              state: stateVal || null,
              units: 'feet',
              basisOfBearings: null,
              bearingSystem: null,
              areaAcres: traverse?.areaAcres ?? rawTraverse?.AreaAcres ?? 0,
              perimeter: traverse?.perimeter ?? rawTraverse?.Perimeter ?? 0,
            }),
          });
          if (writeRes.ok) {
            const writeData = await writeRes.json();
            legalDescription = writeData;
          }
        } catch (e) {
          console.warn('Failed to regenerate legal description:', e);
        }
      }

      const fakeResult = {
        fileName: log.fileName,
        status: 'success',
        extraction,
        traverse,
        legalDescription,
        traverseError: null,
      };

      setResults({ results: [fakeResult], total: 1, succeeded: 1, failed: 0 });
      setActiveIdx(0);
      setExpanded({ 0: true });

      // Scroll to results
      setTimeout(() => {
        const el = document.getElementById('batch-results-card');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    } catch (e) {
      alert('Error loading saved data: ' + e.message);
    }
  };

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
        concurrency: concurrentAgents,
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

  const scanFolder = async () => {
    const path = (folderPath ?? '').trim();
    if (!path) { setFolderError('Please enter a folder path.'); return; }
    setFolderScanLoading(true); setFolderError(''); setFolderManifest(null);
    try {
      const res = await fetch(`${API}/folderscan/scan?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setFolderManifest(data);
    } catch (e) {
      setFolderError(String(e.message));
    } finally {
      setFolderScanLoading(false);
    }
  };

  const runFolderBatches = async () => {
    if (!folderManifest) return;
    const total = folderManifest.batchesNeeded;
    if (total === 0) { setFolderError('No processable deed PDFs in this folder.'); return; }

    // Initialise per-batch status array
    const initStatuses = Array.from({ length: total }, (_, i) => ({ idx: i, status: 'queued', count: 0, error: null }));
    setBatchStatuses(initStatuses);
    setFolderBatchLoading(true);
    setFolderBatchProgress({ current: 0, total, results: [], startTime: Date.now() });
    setFolderError('');

    const baseParams = new URLSearchParams({
      path: folderPath.trim(), pobN, pobE, units: 'Feet',
      concurrency: concurrentAgents,
      ...(county   ? { county }          : {}),
      ...(stateVal ? { state: stateVal } : {}),
    });

    // Shared mutable accumulator (safe because JS is single-threaded for state)
    let allResults = [];
    let completedBatches = 0;

    const runBatchIndex = async (i) => {
      setBatchStatuses(prev => prev.map(b => b.idx === i ? { ...b, status: 'running' } : b));
      try {
        const p = new URLSearchParams(baseParams);
        p.set('batchIndex', i);
        const res  = await fetch(`${API}/folderscan/process-batch?${p}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `Batch ${i} error ${res.status}`);

        const batchResults = data.results?.results ?? [];
        allResults = [...allResults, ...batchResults];
        completedBatches++;

        setBatchStatuses(prev => prev.map(b => b.idx === i ? { ...b, status: 'done', count: batchResults.length } : b));
        setFolderBatchProgress(prev => ({
          ...prev,
          current: completedBatches,
          results: allResults,
        }));
      } catch (e) {
        completedBatches++;
        setBatchStatuses(prev => prev.map(b => b.idx === i ? { ...b, status: 'error', error: e.message } : b));
        setFolderBatchProgress(prev => ({ ...prev, current: completedBatches }));
        setFolderError(prev => prev ? `${prev} | Batch ${i + 1}: ${e.message}` : `Batch ${i + 1}: ${e.message}`);
      }
    };

    // Rolling parallel pool — never more than parallelBatches streams at once
    const poolSize = Math.max(1, Math.min(parallelBatches, total));
    const indices  = Array.from({ length: total }, (_, i) => i);
    const queue    = [...indices];

    const worker = async () => {
      while (queue.length > 0) {
        const idx = queue.shift();
        if (idx === undefined) break;
        await runBatchIndex(idx);
      }
    };

    await Promise.all(Array.from({ length: poolSize }, worker));

    // All done
    const succeeded = allResults.filter(r => r.status === 'success').length;
    setResults({ results: allResults, total: allResults.length, succeeded, failed: allResults.length - succeeded });
    setFolderBatchLoading(false);
    searchDatabase();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* ── Folder Scan ─────────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">📁 Folder Scan — Process Entire Directory</div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Point to a server-side folder · Auto-classifies · Skips non-boundary docs</span>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="/home/user/Downloads/TrainPDF/Regency-Title"
            value={folderPath}
            onChange={e => { setFolderPath(e.target.value); setFolderManifest(null); }}
            style={{
              flex: 1, minWidth: '320px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.9rem',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.82rem'
            }}
            onKeyDown={e => e.key === 'Enter' && scanFolder()}
          />
          <button className="btn btn-ghost" onClick={scanFolder} disabled={folderScanLoading}>
            {folderScanLoading ? '⏳ Scanning…' : '🔍 Scan Folder'}
          </button>
        </div>

        {folderError && <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>⚠ {folderError}</div>}

        {folderManifest && (
          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {/* Stats row */}
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="status-badge pass">✓ {folderManifest.toProcess} processable</span>
              <span className="status-badge fail">⊘ {folderManifest.toSkip} skipped</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{folderManifest.batchesNeeded} batch{folderManifest.batchesNeeded !== 1 ? 'es' : ''} of 20</span>
              {parallelBatches > 1 && !folderBatchLoading && (
                <span style={{ fontSize: '0.78rem', color: '#c97a00', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  ⚡ Turbo: {parallelBatches} parallel streams × {concurrentAgents} agents
                </span>
              )}
              <button
                className="btn btn-primary btn-sm"
                onClick={runFolderBatches}
                disabled={folderBatchLoading || folderManifest.toProcess === 0}
                style={{ marginLeft: 'auto', background: parallelBatches > 1 ? 'linear-gradient(135deg,#c97a00,#e8a000)' : undefined }}
              >
                {folderBatchLoading
                  ? `⚙ Processing… (${folderBatchProgress?.current ?? 0}/${folderBatchProgress?.total ?? 0})`
                  : parallelBatches > 1
                    ? `⚡ Turbo-Process ${folderManifest.toProcess} Deeds`
                    : `▶ Process All ${folderManifest.toProcess} Deeds`}
              </button>
            </div>

            {/* ── Turbo Progress Panel ─────────────────────────────────── */}
            {(folderBatchLoading || batchStatuses.length > 0) && folderBatchProgress && (() => {
              const elapsed   = (Date.now() - (folderBatchProgress.startTime ?? Date.now())) / 1000;
              const doneCount = folderBatchProgress.results.length;
              const rate      = elapsed > 2 ? (doneCount / elapsed).toFixed(2) : '…';
              const remaining = folderBatchProgress.total - folderBatchProgress.current;
              const etaSec    = elapsed > 2 && doneCount > 0
                ? Math.round((elapsed / doneCount) * (folderManifest.toProcess - doneCount))
                : null;
              const etaStr    = etaSec != null
                ? etaSec > 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s`
                : '…';
              const pct       = Math.round((folderBatchProgress.current / folderBatchProgress.total) * 100);
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                  {/* Stat pills */}
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.78rem' }}>
                    <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', padding: '0.15rem 0.65rem', color: 'var(--text-muted)' }}>
                      📄 <strong style={{ color: 'var(--text-primary)' }}>{doneCount}</strong> deeds done
                    </span>
                    <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', padding: '0.15rem 0.65rem', color: 'var(--text-muted)' }}>
                      🚀 <strong style={{ color: 'var(--success)' }}>{rate}</strong> deeds/sec
                    </span>
                    <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', padding: '0.15rem 0.65rem', color: 'var(--text-muted)' }}>
                      ⏱ ETA <strong style={{ color: '#c97a00' }}>{etaStr}</strong>
                    </span>
                    <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', padding: '0.15rem 0.65rem', color: 'var(--text-muted)' }}>
                      📦 {remaining} batch{remaining !== 1 ? 'es' : ''} remaining
                    </span>
                  </div>
                  {/* Main progress bar */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      <span>Batch {folderBatchProgress.current} of {folderBatchProgress.total}</span>
                      <span style={{ fontWeight: 600, color: pct === 100 ? 'var(--success)' : 'var(--text-primary)' }}>{pct}%</span>
                    </div>
                    <div style={{ height: '8px', background: 'var(--bg-elevated)', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: '4px',
                        background: parallelBatches > 1
                          ? 'linear-gradient(90deg, #c97a00, #e8a000, var(--success))'
                          : 'linear-gradient(90deg, var(--accent), var(--success))',
                        width: `${pct}%`,
                        transition: 'width 0.4s ease',
                        boxShadow: parallelBatches > 1 ? '0 0 8px rgba(201,122,0,0.5)' : undefined,
                      }} />
                    </div>
                  </div>
                  {/* Per-batch status grid */}
                  {batchStatuses.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', maxHeight: '120px', overflowY: 'auto' }}>
                      {batchStatuses.map(b => {
                        const colors = {
                          queued:  { bg: 'var(--bg-elevated)',        border: 'var(--border)',              color: 'var(--text-muted)' },
                          running: { bg: 'rgba(201,122,0,0.12)',       border: 'rgba(201,122,0,0.45)',        color: '#c97a00'           },
                          done:    { bg: 'rgba(0,212,168,0.1)',        border: 'rgba(0,212,168,0.35)',        color: 'var(--success)'    },
                          error:   { bg: 'rgba(220,50,50,0.1)',        border: 'rgba(220,50,50,0.35)',        color: '#dc3232'           },
                        }[b.status] ?? {};
                        const icon = { queued: '○', running: '⚙', done: '✓', error: '✗' }[b.status] ?? '?';
                        return (
                          <div key={b.idx} title={b.error ?? `Batch ${b.idx + 1}: ${b.status}`} style={{
                            padding: '0.2rem 0.55rem', borderRadius: '6px', fontSize: '0.7rem', fontWeight: 600,
                            fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap',
                            background: colors.bg, border: `1px solid ${colors.border}`, color: colors.color,
                            animation: b.status === 'running' ? 'pulse 1.2s ease-in-out infinite' : undefined,
                          }}>
                            {icon} B{b.idx + 1}{b.count > 0 ? ` · ${b.count}` : ''}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* File manifest table */}
            <div className="data-table-wrap" style={{ maxHeight: '280px', overflowY: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>File</th><th>Type</th><th>Size</th><th>Action</th></tr></thead>
                <tbody>
                  {folderManifest.files.map((f, i) => (
                    <tr key={i} style={{ opacity: f.willProcess ? 1 : 0.45 }}>
                      <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}>{f.fileName}</td>
                      <td>
                        <span style={{
                          padding: '0.1rem 0.45rem', borderRadius: '3px', fontSize: '0.72rem',
                          background: f.willProcess ? 'var(--accent)22' : 'var(--bg-card)',
                          color: f.willProcess ? 'var(--accent)' : 'var(--text-muted)',
                          fontWeight: 600
                        }}>{f.docType}</span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{f.sizeMb} MB</td>
                      <td style={{ fontSize: '0.78rem' }}>
                        {f.willProcess
                          ? <span style={{ color: 'var(--success)' }}>✓ Process</span>
                          : <span style={{ color: 'var(--text-muted)' }}>⊘ {f.skipReason}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

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
          <p>Drop plat files, PDFs, or Word docs here or <strong>click to browse</strong><br />
            <span className="text-muted" style={{ fontSize: '0.75rem' }}>JPG · PNG · WebP · PDF · DOC · DOCX — up to 20 files</span></p>
          <input ref={fileRef} type="file" accept="image/*,application/pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple hidden onChange={e => addFiles(e.target.files)} />
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
        <div id="batch-results-card" className="card" style={{ maxWidth: '100%' }}>
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
                        <button className="btn btn-primary btn-sm" onClick={() => { setActiveIdx(activeIdx); setShowPrint(true); }}>
                          📐 Open Survey Map & Print
                        </button>
                      </div>
                      <div style={{ borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                        <TraverseMap
                          stations={r.traverse?.stations}
                          adjusted={r.traverse?.adjustedStations}
                          courses={r.extraction?.courses || []}
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
                          ['Precision', r.traverse.closure?.precisionRatio, r.traverse.closure?.status?.startsWith('✓') ? 'pass' : 'fail'],
                          ['Linear Error', `${(r.traverse.closure?.linearError ?? 0).toFixed(4)}'`, 'neutral'],
                          ['Perimeter',    `${(r.traverse.perimeter ?? 0).toFixed(2)}'`,           'neutral'],
                          ['Area',         `${(r.traverse.areaAcres ?? 0).toFixed(4)} ac`,          'neutral'],
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
                <th style={{ textAlign: 'center' }}>Action</th>
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
                    <td style={{ textAlign: 'center' }}>
                      {log.extractionJson ? (
                        <button
                          className="btn btn-sm"
                          onClick={() => loadFromDb(log)}
                          style={{
                            padding: '0.15rem 0.55rem', fontSize: '0.7rem', fontWeight: 600,
                            background: 'rgba(0,212,168,0.1)', border: '1px solid rgba(0,212,168,0.35)',
                            color: 'var(--success)', borderRadius: '4px', cursor: 'pointer',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          📐 Load
                        </button>
                      ) : (
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="9" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
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
          const courses  = (r.extraction?.courses || []);
          const stations = (r.traverse?.stations || []);
          const adjusted = (r.traverse?.adjustedStations || []);
          return (
            <PrintBlueprint
              courses={courses}
              stations={stations}
              adjusted={adjusted}
              units="Feet"
              area={r.traverse?.areaAcres ?? 0}
              perimeter={r.traverse?.perimeter ?? 0}
              pob={{ northing: parseFloat(pobN), easting: parseFloat(pobE) }}
              initialLegalDescription={r.legalDescription?.legalDescription || ''}
              originalCourses={r.originalExtraction?.courses || null}
              originalLegalDescription={''}
              closure={r.traverse?.closure}
              onClose={() => setShowPrint(false)}
            />
          );
        })()
      )}
    </div>
  );
}
