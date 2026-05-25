import { useState, useEffect, useCallback } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';

const API = 'http://localhost:5050/api';

export default function SettingsTab() {
  const [concurrentAgents, setConcurrentAgents] = useLocalStorage('boundaryiq_concurrent_agents', 5);
  const [parallelBatches, setParallelBatches]   = useLocalStorage('boundaryiq_parallel_batches', 1);
  const [maxFileSize, setMaxFileSize]           = useLocalStorage('boundaryiq_max_file_size', 51);
  const [retentionDays, setRetentionDays]       = useLocalStorage('boundaryiq_retention_days', 90);
  const [autoOutput, setAutoOutput]             = useLocalStorage('boundaryiq_auto_output', false);

  // Database stats
  const [dbStats, setDbStats]       = useState(null);
  const [dbLoading, setDbLoading]   = useState(false);
  const [dbMessage, setDbMessage]   = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/diagnostics/stats`);
      if (res.ok) setDbStats(await res.json());
    } catch (e) { console.error('Failed to fetch DB stats:', e); }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const dbAction = async (url, label) => {
    setDbLoading(true); setDbMessage('');
    try {
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json();
      setDbMessage(data.message || `${label}: deleted ${data.deleted} records.`);
      if (data.stats) setDbStats(data.stats); else fetchStats();
    } catch (e) { setDbMessage(`Error: ${e.message}`); }
    finally { setDbLoading(false); setConfirmClear(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* ── Title block with slick layout & gradient ───────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(31, 46, 77, 0.4) 0%, rgba(9, 14, 26, 0.6) 100%)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '2rem',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
          <div style={{
            background: 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)',
            width: '42px',
            height: '42px',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            alignItems: 'center',
            justify: 'center',
            fontSize: '1.5rem',
            boxShadow: '0 0 16px rgba(0, 212, 168, 0.4)',
            color: '#fff',
            justifyContent: 'center',
          }}>
            ⚙️
          </div>
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, letterSpacing: '-0.02em', background: 'linear-gradient(to right, #ffffff, #8899bb)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              System Configuration
            </h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Fine-tune the parallel execution and cognitive agent pipelines.
            </p>
          </div>
        </div>
      </div>

      {/* ── Agent Settings Section ─────────────────────────────────── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            🤖 Agent Processing Configuration
          </div>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="form-label" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>
                Number of Concurrent Agents
              </label>
              <div style={{
                fontFamily: 'JetBrains Mono, monospace',
                background: 'rgba(0, 212, 168, 0.1)',
                border: '1px solid rgba(0, 212, 168, 0.3)',
                color: 'var(--success)',
                padding: '0.2rem 0.6rem',
                borderRadius: '99px',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}>
                {concurrentAgents} {concurrentAgents === 1 ? 'Agent' : 'Agents'}
              </div>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
              <input
                type="range"
                min="1"
                max="20"
                value={concurrentAgents}
                onChange={e => setConcurrentAgents(parseInt(e.target.value))}
                style={{
                  flex: 1,
                  accentColor: 'var(--success)',
                  height: '6px',
                  borderRadius: '3px',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              />
              <input
                type="number"
                min="1"
                max="20"
                value={concurrentAgents}
                onChange={e => {
                  let val = parseInt(e.target.value);
                  if (isNaN(val)) val = 5;
                  if (val < 1) val = 1;
                  if (val > 20) val = 20;
                  setConcurrentAgents(val);
                }}
                style={{
                  width: '70px',
                  textAlign: 'center',
                  fontFamily: 'JetBrains Mono, monospace',
                  borderColor: 'var(--border)',
                  background: 'var(--bg-elevated)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.875rem',
                  padding: '0.4rem',
                }}
              />
            </div>
            
            <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Defines the maximum number of computational vision and geometric translation agents operating simultaneously. Increasing this value speeds up batch deed conversions but might exceed API quota and throughput rate limits.
            </p>
          </div>

          <div className="divider" style={{ margin: '0.5rem 0' }} />

          {/* Telemetry info */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            fontSize: '0.78rem',
            color: 'var(--text-muted)',
            lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span>⚡</span> System Telemetry & Performance Info
            </div>
            <div>
              • Current Allocation: <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{concurrentAgents} Worker Threads / {parallelBatches} Parallel Streams</span>
            </div>
            <div>
              • Recommended limit for standard Google Gemini API tier: <span style={{ color: 'var(--success)', fontWeight: 500 }}>5 Workers</span>
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              • State Status: <span style={{ color: 'var(--success)' }}>✓ Persisted & Auto-Saved to LocalStorage</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Turbo Mode: Parallel Batches ─────────────────────────────────── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255, 170, 0, 0.25)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            ⚡ Turbo Mode — Parallel Batch Execution
          </div>
          <span style={{ fontSize: '0.75rem', color: '#c97a00', fontWeight: 600 }}>Paid API tier recommended for &gt; 1</span>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="form-label" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>
                Parallel Batch Streams
              </label>
              <div style={{
                fontFamily: 'JetBrains Mono, monospace',
                background: parallelBatches > 1 ? 'rgba(255, 170, 0, 0.12)' : 'rgba(0, 212, 168, 0.1)',
                border: `1px solid ${parallelBatches > 1 ? 'rgba(255,170,0,0.4)' : 'rgba(0,212,168,0.3)'}`,
                color: parallelBatches > 1 ? '#c97a00' : 'var(--success)',
                padding: '0.2rem 0.6rem',
                borderRadius: '99px',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}>
                {parallelBatches === 1 ? '1 Stream (Safe)' : `${parallelBatches} Streams (Turbo ⚡)`}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
              <input
                type="range" min="1" max="8" value={parallelBatches}
                onChange={e => setParallelBatches(parseInt(e.target.value))}
                style={{ flex: 1, accentColor: '#c97a00', height: '6px', borderRadius: '3px', outline: 'none', cursor: 'pointer' }}
              />
              <input
                type="number" min="1" max="8" value={parallelBatches}
                onChange={e => {
                  let val = parseInt(e.target.value);
                  if (isNaN(val)) val = 1;
                  if (val < 1) val = 1;
                  if (val > 8) val = 8;
                  setParallelBatches(val);
                }}
                style={{ width: '70px', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem', padding: '0.4rem' }}
              />
            </div>

            <div style={{
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem',
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem 1.5rem',
              fontSize: '0.77rem', color: 'var(--text-muted)', marginTop: '0.25rem'
            }}>
              <div>• <strong style={{ color: 'var(--text-primary)' }}>1 stream</strong> — Sequential, safe on free tier</div>
              <div>• <strong style={{ color: 'var(--text-primary)' }}>2–3 streams</strong> — Good on paid tier (1 k RPM)</div>
              <div>• <strong style={{ color: 'var(--text-primary)' }}>4–5 streams</strong> — Max throughput, monitor 429s</div>
              <div>• <strong style={{ color: 'var(--text-primary)' }}>6–8 streams</strong> — High-volume enterprise use only</div>
            </div>

            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Each stream processes a separate batch of 20 files concurrently. Combined throughput = Parallel Streams × Concurrent Agents per stream.
              At <strong style={{ color: 'var(--text-primary)' }}>{parallelBatches} × {concurrentAgents}</strong> = up to{' '}
              <strong style={{ color: '#c97a00' }}>{parallelBatches * concurrentAgents} simultaneous Gemini requests</strong>.
            </p>
          </div>
        </div>
      </div>

      {/* ── File Limit Settings Section ─────────────────────────────────── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            📁 File Size & Upload Configuration
          </div>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="form-label" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>
                Max Upload & Scan File Size
              </label>
              <div style={{
                fontFamily: 'JetBrains Mono, monospace',
                background: 'rgba(61, 127, 255, 0.1)',
                border: '1px solid rgba(61, 127, 255, 0.3)',
                color: 'var(--accent)',
                padding: '0.2rem 0.6rem',
                borderRadius: '99px',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}>
                {maxFileSize} MB
              </div>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
              <input
                type="range"
                min="5"
                max="100"
                value={maxFileSize}
                onChange={e => setMaxFileSize(parseInt(e.target.value))}
                style={{
                  flex: 1,
                  accentColor: 'var(--accent)',
                  height: '6px',
                  borderRadius: '3px',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              />
              <input
                type="number"
                min="5"
                max="100"
                value={maxFileSize}
                onChange={e => {
                  let val = parseInt(e.target.value);
                  if (isNaN(val)) val = 51;
                  if (val < 5) val = 5;
                  if (val > 100) val = 100;
                  setMaxFileSize(val);
                }}
                style={{
                  width: '70px',
                  textAlign: 'center',
                  fontFamily: 'JetBrains Mono, monospace',
                  borderColor: 'var(--border)',
                  background: 'var(--bg-elevated)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.875rem',
                  padding: '0.4rem',
                }}
              />
            </div>
            
            <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Sets the local file filter threshold. The server currently supports uploads and scanning up to **51 MB** for large, multi-page subdivision covenant files. Files exceeding this size will be filtered out to optimize memory usage during AI repairs.
            </p>
          </div>
        </div>
      </div>

      {/* ── Output Configuration ─────────────────────────────────────── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: `1px solid ${autoOutput ? 'rgba(0, 212, 168, 0.35)' : 'var(--border)'}`,
        boxShadow: autoOutput ? '0 4px 24px rgba(0, 212, 168, 0.08)' : '0 4px 24px rgba(0, 0, 0, 0.15)',
        transition: 'border-color 0.3s, box-shadow 0.3s',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            📤 Output File Configuration
          </div>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* Auto-Output Toggle */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
            <label style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              cursor: 'pointer',
              flexShrink: 0,
              marginTop: '2px',
            }}>
              <input
                type="checkbox"
                checked={autoOutput}
                onChange={e => setAutoOutput(e.target.checked)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
              <div style={{
                width: '44px',
                height: '24px',
                borderRadius: '12px',
                background: autoOutput
                  ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)'
                  : 'rgba(255,255,255,0.1)',
                border: `1px solid ${autoOutput ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
                position: 'relative',
                transition: 'all 0.3s ease',
                boxShadow: autoOutput ? '0 0 12px rgba(0, 212, 168, 0.3)' : 'none',
              }}>
                <div style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  background: '#fff',
                  position: 'absolute',
                  top: '2px',
                  left: autoOutput ? '22px' : '3px',
                  transition: 'left 0.3s ease',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                }} />
              </div>
            </label>

            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem', marginBottom: '0.35rem' }}>
                Auto-Generate Output Files
              </div>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                When enabled, each batch/folder scan run will automatically create a timestamped subfolder
                inside the source directory and write output files for every processed deed.
              </p>
            </div>
          </div>

          {/* Output Details Info Box */}
          <div style={{
            background: autoOutput ? 'rgba(0, 212, 168, 0.04)' : 'var(--bg-elevated)',
            border: `1px solid ${autoOutput ? 'rgba(0, 212, 168, 0.2)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-md)',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            fontSize: '0.78rem',
            color: 'var(--text-muted)',
            lineHeight: 1.7,
            transition: 'all 0.3s ease',
          }}>
            <div style={{ fontWeight: 600, color: autoOutput ? 'var(--success)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span>{autoOutput ? '✅' : '⏸️'}</span> {autoOutput ? 'Auto-Output ENABLED' : 'Auto-Output Disabled'}
            </div>
            <div>
              • <strong style={{ color: 'var(--text-primary)' }}>Folder Format:</strong>{' '}
              <code style={{ fontSize: '0.75rem', color: 'var(--accent)', background: 'rgba(61,127,255,0.08)', padding: '1px 5px', borderRadius: '3px' }}>
                DDMMYYYY.fff
              </code>{' '}
              (e.g. <code style={{ fontSize: '0.72rem', color: 'var(--accent)' }}>25052026.142</code>)
            </div>
            <div>• <strong style={{ color: 'var(--text-primary)' }}>Per deed:</strong> <code style={{ fontSize: '0.72rem' }}>_corrected.txt</code> + <code style={{ fontSize: '0.72rem' }}>_original.txt</code> + <code style={{ fontSize: '0.72rem' }}>_report.json</code></div>
            <div>• <strong style={{ color: 'var(--text-primary)' }}>Batch summary:</strong> <code style={{ fontSize: '0.72rem' }}>_BATCH_SUMMARY.json</code> with pass/fail stats</div>
            <div>• <strong style={{ color: 'var(--text-primary)' }}>Location:</strong> Created inside the scanned source folder</div>
          </div>
        </div>
      </div>
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            🗄️ Database Management
          </div>
          <button className="btn btn-ghost btn-sm" onClick={fetchStats} style={{ fontSize: '0.72rem' }}>↻ Refresh</button>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* Live Stats Grid */}
          {dbStats && (
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '0.6rem', fontSize: '0.78rem'
            }}>
              {[
                { label: 'DB Size', value: `${dbStats.fileSizeMb} MB`, color: 'var(--accent)' },
                { label: 'Total Deeds', value: dbStats.deedLogCount, color: 'var(--text-primary)' },
                { label: 'Passed', value: dbStats.passCount, color: 'var(--success)' },
                { label: 'Failed', value: dbStats.failCount, color: '#dc3232' },
                { label: 'Batch Runs', value: dbStats.batchRunCount, color: 'var(--text-muted)' },
                { label: 'Heuristics', value: dbStats.heuristicCount, color: '#c97a00' },
              ].map(s => (
                <div key={s.label} style={{
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', padding: '0.65rem 0.85rem',
                  display: 'flex', flexDirection: 'column', gap: '0.15rem'
                }}>
                  <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{s.label}</span>
                  <span style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: s.color }}>{s.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Date range */}
          {dbStats?.oldestTimestamp && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
              <span>📅 Oldest: <strong style={{ color: 'var(--text-primary)' }}>{dbStats.oldestTimestamp}</strong></span>
              <span>📅 Newest: <strong style={{ color: 'var(--text-primary)' }}>{dbStats.newestTimestamp}</strong></span>
              <span>📂 Path: <code style={{ fontSize: '0.7rem', color: 'var(--accent)' }}>{dbStats.dbPath}</code></span>
            </div>
          )}

          {/* Retention slider */}
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="form-label" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>
                Log Retention Period
              </label>
              <div style={{
                fontFamily: 'JetBrains Mono, monospace',
                background: 'rgba(61, 127, 255, 0.1)',
                border: '1px solid rgba(61, 127, 255, 0.3)',
                color: 'var(--accent)',
                padding: '0.2rem 0.6rem',
                borderRadius: '99px',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}>
                {retentionDays} Days
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <input
                type="range" min="7" max="365" value={retentionDays}
                onChange={e => setRetentionDays(parseInt(e.target.value))}
                style={{ flex: 1, accentColor: 'var(--accent)', height: '6px', borderRadius: '3px', outline: 'none', cursor: 'pointer' }}
              />
              <input
                type="number" min="7" max="365" value={retentionDays}
                onChange={e => {
                  let val = parseInt(e.target.value);
                  if (isNaN(val)) val = 90;
                  if (val < 7) val = 7;
                  if (val > 365) val = 365;
                  setRetentionDays(val);
                }}
                style={{ width: '70px', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem', padding: '0.4rem' }}
              />
            </div>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Logs older than this are auto-purged on server startup. Click "Purge Now" to apply immediately.
            </p>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm"
              disabled={dbLoading}
              onClick={() => dbAction(`${API}/diagnostics/purge?days=${retentionDays}`, 'Purge')}
              style={{ background: 'rgba(61,127,255,0.12)', border: '1px solid rgba(61,127,255,0.35)', color: 'var(--accent)', fontWeight: 600 }}
            >
              🧹 Purge Old ({retentionDays}d+)
            </button>
            <button
              className="btn btn-sm"
              disabled={dbLoading}
              onClick={() => dbAction(`${API}/diagnostics/clear-failed`, 'Clear Failed')}
              style={{ background: 'rgba(220,50,50,0.08)', border: '1px solid rgba(220,50,50,0.3)', color: '#dc3232', fontWeight: 600 }}
            >
              🔄 Clear Failed Cache
            </button>
            {!confirmClear ? (
              <button
                className="btn btn-sm"
                disabled={dbLoading}
                onClick={() => setConfirmClear(true)}
                style={{ background: 'rgba(220,50,50,0.08)', border: '1px solid rgba(220,50,50,0.3)', color: '#dc3232', fontWeight: 600 }}
              >
                🗑️ Clear All Cache
              </button>
            ) : (
              <button
                className="btn btn-sm"
                disabled={dbLoading}
                onClick={() => dbAction(`${API}/diagnostics/clear-all`, 'Clear All')}
                style={{ background: '#dc3232', border: 'none', color: '#fff', fontWeight: 700, animation: 'pulse 0.8s infinite' }}
              >
                ⚠ CONFIRM — Delete Everything
              </button>
            )}
          </div>

          {/* Status message */}
          {dbMessage && (
            <div style={{
              padding: '0.55rem 0.85rem', borderRadius: 'var(--radius-sm)',
              background: dbMessage.startsWith('Error') ? 'rgba(220,50,50,0.1)' : 'rgba(0,212,168,0.08)',
              border: `1px solid ${dbMessage.startsWith('Error') ? 'rgba(220,50,50,0.3)' : 'rgba(0,212,168,0.3)'}`,
              color: dbMessage.startsWith('Error') ? '#dc3232' : 'var(--success)',
              fontSize: '0.78rem', fontWeight: 500
            }}>
              {dbMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
