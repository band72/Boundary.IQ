import { useState, useRef, useEffect } from 'react';
import { useToast } from '../hooks/useToast';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { performFrontendOcr } from '../utils/ocr';

import TraverseMap from './TraverseMap';
import PrintBlueprint from './PrintBlueprint';
import { authFetchRaw } from '../api';

export default function PlatTab() {
  const [file, setFile]         = useState(null);
  const [preview, setPreview]   = useState(null);
  const [drag, setDrag]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState(null);   // { extraction, traverse, traverseError }
  const [error, setError]       = useState('');
  const [ocrStatus, setOcrStatus] = useState('');
  const [frontendOcr]           = useLocalStorage('boundaryiq_frontend_ocr', false);
  const [pobN, setPobN]         = useState('5000.00');
  const [pobE, setPobE]         = useState('5000.00');
  const [showPrint, setShowPrint] = useState(false);
  const [jobName, setJobName]     = useState('');
  const [tableFile, setTableFile] = useState(null);
  const [extractLots, setExtractLots] = useState(false);
  const [currentStep, setCurrentStep] = useState(0); // 0: idle, 1: vision, 2: traverse, 3: voting, 4: repair, 5: dxf, 6: done
  const fileRef = useRef();
  const tableFileRef = useRef();
  const { showToast, ToastPortal } = useToast();

  const handleFile = f => {
    if (!f) return;
    setFile(f); setResult(null); setError('');
    // Revoke previous Object URL to prevent memory leak
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(f));
  };

  // Revoke blob Object URL on unmount to release browser memory
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const handleClear = () => {
    setFile(null);
    setPreview(null);
    setTableFile(null);
    setResult(null);
    setCurrentStep(0);
    setError('');
  };

  const run = async () => {
    if (!file) return;
    setLoading(true); setError(''); setOcrStatus(''); setResult(null);
    setCurrentStep(1); // 1: Vision Extraction
    try {
      let processedFile = file;
      if (frontendOcr) {
        setOcrStatus(`Running client-side OCR on ${file.name}...`);
        try {
          const extractedText = await performFrontendOcr(file, (progressMsg) => {
            setOcrStatus(progressMsg);
          });
          const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
          processedFile = new File(
            [extractedText],
            `${baseName}_ocr.txt`,
            { type: 'text/plain' }
          );
        } catch (ocrErr) {
          console.error('Client OCR failed for plat:', ocrErr);
        }
      }
      setOcrStatus('');

      const fd = new FormData();
      fd.append('image', processedFile);
      if (tableFile) {
        fd.append('tableImage', tableFile);
      }

      const path = `/plat/extract-and-compute?pobN=${pobN}&pobE=${pobE}&units=Feet`;
      const res = await authFetchRaw(path, { method: 'POST', body: fd });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

      // Sequence through steps with timing for UX
      setCurrentStep(2); // Traverse Computation
      await new Promise(r => setTimeout(r, 800));

      setCurrentStep(3); // Consensus Voting
      await new Promise(r => setTimeout(r, 800));

      setCurrentStep(4); // AI Misclosure Repair
      await new Promise(r => setTimeout(r, 800));

      setCurrentStep(5); // DXF Generation
      await new Promise(r => setTimeout(r, 800));

      setCurrentStep(6); // Success
      setResult(data);
    } catch (e) {
      setError(e.message);
      setCurrentStep(-1); // Error state
    } finally {
      setLoading(false);
    }
  };

  const ext = result?.extraction;
  const trav = result?.traverse;
  const isPassing = trav?.closure?.status?.startsWith('✓');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Title Header */}
      <div>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0 0 0.5rem 0', color: 'var(--text-primary)', fontSize: '1.5rem' }}>
          🗺️ Plat DXF
        </h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Upload a scanned survey plat image — the vision model extracts the call table and drafts geometry automatically.
        </p>
      </div>

      {/* Main Grid Layout */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: '1.5rem',
        alignItems: 'start'
      }}>
        {/* PLAT IMAGE CARD */}
        <div className="card" style={{ background: 'rgba(9,14,26,0.4)', backdropFilter: 'blur(8px)', border: '1px solid var(--border)', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
          <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
            <div className="card-title">
              🖼️ PLAT IMAGE
            </div>
          </div>
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Job Name */}
            <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label className="form-label">JOB NAME (OPTIONAL)</label>
              <input
                type="text"
                value={jobName}
                onChange={e => setJobName(e.target.value)}
                placeholder="e.g. Lot 12 Block 4"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.55rem 0.85rem',
                  color: 'var(--text-primary)'
                }}
              />
            </div>

            {/* Drop Zone */}
            <div
              className={`drop-zone ${drag ? 'drag-over' : ''}`}
              onClick={() => fileRef.current.click()}
              onDragOver={e => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
              style={{
                border: drag ? '2px dashed var(--accent)' : '2px dashed var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '2rem 1.5rem',
                textAlign: 'center',
                cursor: 'pointer',
                background: 'rgba(255, 255, 255, 0.01)',
                transition: 'all 0.2s',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <div style={{ fontSize: '2.5rem', marginBottom: '0.25rem' }}>📂</div>
              {file ? (
                <div>
                  <p style={{ margin: 0, fontWeight: 600, color: 'var(--text-primary)' }}>{file.name}</p>
                  <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>{(file.size / 1024).toFixed(1)} KB</p>
                </div>
              ) : (
                <div>
                  <p style={{ margin: 0, fontWeight: 600, color: 'var(--text-primary)' }}>Drop plat image here</p>
                  <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>JPG, PNG, WEBP, PDF · Max 25 MB</p>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={e => handleFile(e.target.files[0])} />
            </div>

            {/* Previews */}
            {preview && file && !file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf') && (
              <div style={{ borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                <img src={preview} alt="Plat Preview" style={{ width: '100%', maxHeight: 180, objectFit: 'contain', display: 'block', background: 'var(--bg-elevated)' }} />
              </div>
            )}
            {file && (file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf')) && (
              <div style={{ borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: '1.5rem' }}>📄</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', fontSize: '0.85rem' }}>{file.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>PDF Document</div>
                </div>
              </div>
            )}

            {/* Call Table Image */}
            <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label className="form-label">CALL TABLE IMAGE (OPTIONAL)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <button
                  type="button"
                  onClick={() => tableFileRef.current.click()}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.45rem 1rem',
                    color: 'var(--text-primary)',
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem'
                  }}
                >
                  📎 Attach Table
                </button>
                {tableFile && (
                  <span
                    onClick={() => setTableFile(null)}
                    title="Click to remove"
                    style={{ fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '180px' }}
                  >
                    {tableFile.name} (✕)
                  </span>
                )}
              </div>
              <input ref={tableFileRef} type="file" accept="image/*,application/pdf" hidden onChange={e => setTableFile(e.target.files[0])} />
            </div>

            {/* POB Settings (Collapsible) */}
            <details style={{ marginTop: '0.25rem' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary)', userSelect: 'none', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                📍 POB Coordinates (Default: 5000.00, 5000.00)
              </summary>
              <div className="grid-2" style={{ marginTop: '0.5rem', gap: '0.75rem' }}>
                <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <label className="form-label" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 'normal' }}>POB Northing</label>
                  <input
                    type="number"
                    value={pobN}
                    onChange={e => setPobN(e.target.value)}
                    style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.35rem 0.55rem',
                      color: 'var(--text-primary)'
                    }}
                  />
                </div>
                <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <label className="form-label" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 'normal' }}>POB Easting</label>
                  <input
                    type="number"
                    value={pobE}
                    onChange={e => setPobE(e.target.value)}
                    style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.35rem 0.55rem',
                      color: 'var(--text-primary)'
                    }}
                  />
                </div>
              </div>
            </details>

            {/* Extract Individual Lots Checkbox */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
              <input
                type="checkbox"
                id="extractLots"
                checked={extractLots}
                onChange={e => setExtractLots(e.target.checked)}
                style={{ cursor: 'pointer', width: '15px', height: '15px', accentColor: 'var(--accent)' }}
              />
              <label htmlFor="extractLots" className="form-label" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                🧩 EXTRACT INDIVIDUAL LOTS
              </label>
            </div>

            {/* Submit / Actions */}
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              {file && (
                <button
                  className="btn btn-ghost"
                  onClick={handleClear}
                  style={{ flex: 1, padding: '0.65rem', borderRadius: 'var(--radius-sm)' }}
                >
                  Clear
                </button>
              )}
              <button
                onClick={run}
                disabled={loading || !file}
                style={{
                  flex: 2,
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.65rem',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  cursor: (loading || !file) ? 'not-allowed' : 'pointer',
                  opacity: (loading || !file) ? 0.45 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem'
                }}
              >
                {loading ? (
                  <>
                    <span className="spinner" style={{ width: 14, height: 14 }} />
                    Extracting...
                  </>
                ) : (
                  <>
                    👁️ Extract from Plat
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* PIPELINE CARD */}
        <div className="card" style={{ background: 'rgba(9,14,26,0.4)', backdropFilter: 'blur(8px)', border: '1px solid var(--border)', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
          <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
            <div className="card-title">
              ⚙️ PIPELINE
            </div>
          </div>
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {[
              { step: 1, icon: '👁️', label: 'Vision Extraction' },
              { step: 2, icon: '📐', label: 'Traverse Computation' },
              { step: 3, icon: '⚖️', label: 'Consensus Voting' },
              { step: 4, icon: '🔧', label: 'AI Misclosure Repair' },
              { step: 5, icon: '📋', label: 'DXF Generation' }
            ].map(item => {
              // Determine status style:
              let itemColor = 'var(--text-secondary)';
              let itemWeight = 400;
              let itemBorder = '1px solid var(--border)';
              let rightElement = null;

              if (currentStep === 0) {
                // Idle state
              } else if (currentStep === item.step) {
                // Active state
                itemColor = 'var(--accent)';
                itemWeight = 600;
                itemBorder = '1px solid var(--accent)';
                rightElement = <span className="spinner" style={{ width: 14, height: 14 }} />;
              } else if (currentStep > item.step || (currentStep === 6)) {
                // Success state
                itemColor = 'var(--text-primary)';
                itemWeight = 500;
                rightElement = <span style={{ color: 'var(--success)', fontWeight: 'bold' }}>✓</span>;
              } else if (currentStep === -1) {
                // Error state
                itemColor = 'var(--danger)';
              }

              return (
                <div
                  key={item.step}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: itemBorder,
                    borderRadius: 'var(--radius-md)',
                    padding: '0.85rem 1.2rem',
                    color: itemColor,
                    fontWeight: itemWeight,
                    transition: 'all 0.2s'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontSize: '1.1rem' }}>{item.icon}</span>
                    <span style={{ fontSize: '0.875rem' }}>{item.label}</span>
                  </div>
                  {rightElement}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Error / Status info messages */}
      {ocrStatus && <div className="alert alert-info">⚙️ {ocrStatus}</div>}
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
                showToast('Courses copied to clipboard!');
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

      {/* Traverse Results */}
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
          <TraverseMap
            key={`${trav?.stations?.length || 0}_${trav?.closure?.linearError || 0}_${ext?.courses?.length || 0}`}
            stations={trav?.stations}
            adjusted={trav?.adjustedStations}
            courses={ext?.courses}
          />
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
          key={`${trav?.stations?.length || 0}_${trav?.closure?.linearError || 0}_${ext?.courses?.length || 0}`}
          courses={ext.courses}
          stations={trav?.stations || []}
          adjusted={trav?.adjustedStations || []}
          units="Feet"
          area={trav?.areaAcres || 0}
          perimeter={trav?.perimeter || 0}
          pob={{ northing: parseFloat(pobN), easting: parseFloat(pobE) }}
          initialLegalDescription={''}
          closure={trav?.closure}
          isOpenEnded={ext?.isOpenEnded || false}
          onClose={() => setShowPrint(false)}
        />
      )}
      <ToastPortal />
    </div>
  );
}
