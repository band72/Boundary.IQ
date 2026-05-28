import { useState, useEffect, useCallback } from 'react';
import { API } from '../config';
import { useStatsRefresh } from '../hooks/useStatsRefresh.jsx';

export default function DashboardTab() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbMessage, setDbMessage] = useState('');
  const [confirmAction, setConfirmAction] = useState(null); // 'clear-all' | 'clear-failed' | null

  // Failed deed drill-down drawer
  const [failedDeeds, setFailedDeeds]       = useState([]);
  const [failedLoading, setFailedLoading]   = useState(false);
  const [activeBucket, setActiveBucket]     = useState(null); // null | 'nearClosed' | 'minorError' | 'moderateError' | 'majorError'
  const [drawerOpen, setDrawerOpen]         = useState(false);
  const [sortField, setSortField]           = useState('linearError');
  const [sortDir, setSortDir]               = useState('desc');

  // Deed preview panel (slide-in)
  const [selectedDeed, setSelectedDeed]     = useState(null);   // full detail from /deed-detail
  const [deedText, setDeedText]             = useState('');     // raw .txt content from disk
  const [deedLoading, setDeedLoading]       = useState(false);
  const [deedTab, setDeedTab]               = useState('text'); // 'text' | 'courses' | 'traverse'
  const [folderPath]                        = useState(() => localStorage.getItem('boundaryiq_folder_path') || '');

  const fetchDeedDetail = async (fileName) => {
    setDeedLoading(true);
    setDeedText('');
    setDeedTab('text');
    try {
      // Fetch full DB record
      const detailRes = await fetch(`${API}/diagnostics/deed-detail?fileName=${encodeURIComponent(fileName)}`);
      if (detailRes.ok) {
        const detail = await detailRes.json();
        setSelectedDeed(detail);
      }
      // Fetch raw text from disk
      const params = new URLSearchParams({ fileName });
      if (folderPath) params.set('folder', folderPath);
      const textRes = await fetch(`${API}/diagnostics/deed-text?${params}`);
      if (textRes.ok) {
        const { text } = await textRes.json();
        setDeedText(text || '');
      }
    } catch (ex) {
      setDeedText(`Error loading deed: ${ex.message}`);
    } finally {
      setDeedLoading(false);
    }
  };

  const closeDeedPanel = () => { setSelectedDeed(null); setDeedText(''); };

  // Normalize extraction JSON — handles both PascalCase (C#-serialized) and camelCase
  const normalizeExtraction = (raw) => {
    if (!raw) return null;
    // If RawJson is embedded parse it for MentalMapSummary
    let rawParsed = null;
    try { rawParsed = typeof raw.RawJson === 'string' ? JSON.parse(raw.RawJson) : raw.RawJson; } catch { /* invalid JSON, ignore */ }
    return {
      courses:          raw.courses        || raw.Courses        || rawParsed?.Segments || rawParsed?.segments || [],
      message:          raw.message        || raw.Message        || '',
      mentalMapSummary: raw.mentalMapSummary || raw.MentalMapSummary || rawParsed?.MentalMapSummary || '',
      classification:   raw.classification  || raw.Classification  || '',
      isOpenEnded:      raw.isOpenEnded     || raw.IsOpenEnded     || false,
    };
  };

  const fetchFailedDeeds = async (bucket = null) => {
    setFailedLoading(true);
    try {
      const url = `${API}/diagnostics/failed-deeds${bucket ? `?bucket=${bucket}` : ''}`;
      const res = await fetch(url);
      if (res.ok) setFailedDeeds(await res.json());
    } catch (e) { console.error('Failed to fetch failed deeds:', e); }
    finally { setFailedLoading(false); }
  };

  const openDrawer = (bucket = null) => {
    const isSame = drawerOpen && activeBucket === bucket;
    if (isSame) { setDrawerOpen(false); setActiveBucket(null); return; }
    setActiveBucket(bucket);
    setDrawerOpen(true);
    fetchFailedDeeds(bucket);
  };

  // Global stats refresh signal — fires whenever BatchDeedTab completes a reprocess
  const { statsRefreshKey } = useStatsRefresh();

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/diagnostics/stats`);
      if (res.ok) {
        const data = await res.json();
        setStats(data);
        setError(null);
      } else {
        setError('Failed to load database stats');
      }
    } catch (e) {
      setError(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount AND whenever any tab triggers a global stats refresh
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchStats();
    if (drawerOpen) fetchFailedDeeds(activeBucket);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchStats, statsRefreshKey]);

  const runDbAction = async (endpoint, label) => {
    setDbLoading(true);
    setDbMessage('');
    try {
      const res = await fetch(`${API}/diagnostics/${endpoint}`, { method: 'POST' });
      const data = await res.json();
      setDbMessage(data.message || `${label} action completed.`);
      if (data.stats) {
        setStats(data.stats);
      } else {
        fetchStats();
      }
    } catch (e) {
      setDbMessage(`Error: ${e.message}`);
    } finally {
      setDbLoading(false);
      setConfirmAction(null);
    }
  };

  if (loading && !stats) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '300px', flexDirection: 'column', gap: '1rem' }}>
        <div className="spinner" style={{ width: '40px', height: '40px', border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Compiling telemetry metrics…</span>
      </div>
    );
  }

  const passRate = stats && stats.deedLogCount > 0 
    ? ((stats.passCount / stats.deedLogCount) * 100).toFixed(1) 
    : '0.0';

  const failRate = stats && stats.deedLogCount > 0 
    ? ((stats.failCount / stats.deedLogCount) * 100).toFixed(1) 
    : '0.0';

  const meanderRate = stats && stats.deedLogCount > 0 
    ? ((stats.meanderCount / stats.deedLogCount) * 100).toFixed(1) 
    : '0.0';

  const errorRate = stats && stats.deedLogCount > 0 
    ? ((stats.errorCount / stats.deedLogCount) * 100).toFixed(1) 
    : '0.0';

  return (
    <>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* ── Header Card ──────────────────────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(31, 46, 77, 0.4) 0%, rgba(9, 14, 26, 0.6) 100%)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '2rem',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Glow effect */}
        <div style={{
          position: 'absolute', top: '-150px', right: '-150px',
          width: '350px', height: '350px',
          background: 'radial-gradient(circle, rgba(0, 212, 168, 0.15) 0%, transparent 70%)',
          pointerEvents: 'none'
        }} />
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginBottom: '0.5rem' }}>
              <div style={{
                background: 'linear-gradient(135deg, var(--accent), var(--accent2))',
                width: '36px', height: '36px', borderRadius: 'var(--radius-md)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1.2rem', color: '#fff', boxShadow: '0 0 12px var(--accent-glow)'
              }}>📊</div>
              <h1 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 700, color: '#fff' }}>Analytics & Statistics</h1>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', margin: 0, maxWidth: '600px' }}>
              Survey grade boundary quality control telemetry. Monitor auto-repair heuristic success rates, legal description classifications, and precision closure distributions.
            </p>
          </div>
          <button 
            className="btn btn-ghost" 
            onClick={fetchStats} 
            disabled={loading}
            style={{ fontSize: '0.8rem', height: '38px', padding: '0 1rem', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
          >
            {loading ? '⏳ Syncing…' : '↻ Force Refresh'}
          </button>
        </div>

        {error && <div className="alert alert-error" style={{ marginTop: '1rem' }}>⚠ {error}</div>}
        {dbMessage && <div className="alert alert-success" style={{ marginTop: '1rem', borderColor: 'var(--accent2)' }}>✓ {dbMessage}</div>}
      </div>

      {/* ── Key Performance Indicators Grid ─────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '1rem'
      }}>
        {[
          { label: 'Total Scanned', value: stats?.deedLogCount ?? 0, color: 'var(--text-primary)', icon: '📄', bucket: null, clickable: false },
          { label: 'Overall Pass Rate', value: `${passRate}%`, color: 'var(--success)', sub: `${stats?.passCount ?? 0} Closed Deeds`, icon: '🏆', bucket: null, clickable: false },
          { label: 'Needs Review', value: stats?.failCount ?? 0, color: '#ff4d6d', sub: `${failRate}% · click to expand`, icon: '⚠', bucket: null, clickable: true },
          { label: 'Waterway Meanders', value: stats?.meanderCount ?? 0, color: 'var(--warning)', sub: `${meanderRate}% of total`, icon: '🌊', bucket: null, clickable: false },
          { label: 'Processing Errors', value: stats?.errorCount ?? 0, color: 'var(--text-muted)', sub: `${errorRate}% of total`, icon: '🛑', bucket: 'errors', clickable: false }
        ].map((card, i) => (
          <div key={i}
            onClick={() => card.clickable ? openDrawer(null) : undefined}
            style={{
            background: 'linear-gradient(135deg, rgba(20, 30, 53, 0.6) 0%, rgba(15, 23, 41, 0.8) 100%)',
            border: card.clickable && drawerOpen && activeBucket === null
              ? '1px solid rgba(255,77,109,0.6)'
              : '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            position: 'relative',
            boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
            minHeight: '115px',
            cursor: card.clickable ? 'pointer' : 'default',
            transition: 'border-color 0.2s, transform 0.15s',
            ...(card.clickable ? { ':hover': { transform: 'translateY(-1px)' } } : {})
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {card.label}
              </span>
              <span style={{ fontSize: '1.1rem' }}>{card.icon}</span>
            </div>
            <div style={{ marginTop: '0.5rem' }}>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: card.color, lineHeight: 1.1 }}>
                {card.value}
              </div>
              {card.sub && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                  {card.sub}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── Two-Column Main Analytics Grid ───────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
        gap: '1.5rem'
      }}>
        
        {/* Left Column: Classification pass / fail / open-ended split */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="card-header" style={{ paddingBottom: '0.5rem', borderBottom: '1px solid var(--border)' }}>
            <div className="card-title">🗂️ Deed Classification & Accuracy Breakdown</div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Success metrics grouped by geometric legal description style
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', padding: '0.25rem 0' }}>
            {stats?.classifications && stats.classifications.length > 0 ? (
              stats.classifications.map((c, idx) => {
                const totalClass = c.count || 1;
                const cPassRate = ((c.passed / totalClass) * 100);
                const cFailRate = ((c.failed / totalClass) * 100);
                const cMeanderRate = ((c.meanders / totalClass) * 100);
                const cErrorRate = ((c.errors / totalClass) * 100);

                // Helper to format class labels prettily
                const displayLabel = {
                  METES_BOUNDS: 'Metes & Bounds (Standard)',
                  HYBRID: 'Hybrid (PLSS + Metes)',
                  LOT_BLOCK: 'Lot & Block (Subdivision)',
                  UNKNOWN: 'Unclassified / Other'
                }[c.class] || c.class;

                const statusColor = {
                  METES_BOUNDS: 'var(--accent)',
                  HYBRID: 'var(--success)',
                  LOT_BLOCK: '#c97a00',
                  UNKNOWN: 'var(--text-muted)'
                }[c.class] || 'var(--text-muted)';

                return (
                  <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: statusColor }} />
                        {displayLabel}
                      </span>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{c.count}</strong> deeds ({cPassRate.toFixed(0)}% pass)
                      </span>
                    </div>

                    {/* Stacked Percentage bar */}
                    <div style={{
                      height: '14px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      borderRadius: '99px',
                      overflow: 'hidden',
                      display: 'flex',
                      border: '1px solid var(--border)'
                    }}>
                      {c.passed > 0 && (
                        <div 
                          title={`Passed: ${c.passed} (${cPassRate.toFixed(1)}%)`}
                          style={{ width: `${cPassRate}%`, background: 'var(--success)', height: '100%', transition: 'width 0.5s ease' }} 
                        />
                      )}
                      {c.failed > 0 && (
                        <div 
                          title={`Failed: ${c.failed} (${cFailRate.toFixed(1)}%)`}
                          style={{ width: `${cFailRate}%`, background: '#ff4d6d', height: '100%', transition: 'width 0.5s ease' }} 
                        />
                      )}
                      {c.meanders > 0 && (
                        <div 
                          title={`Waterways: ${c.meanders} (${cMeanderRate.toFixed(1)}%)`}
                          style={{ width: `${cMeanderRate}%`, background: 'var(--warning)', height: '100%', transition: 'width 0.5s ease' }} 
                        />
                      )}
                      {c.errors > 0 && (
                        <div 
                          title={`Errors: ${c.errors} (${cErrorRate.toFixed(1)}%)`}
                          style={{ width: `${cErrorRate}%`, background: '#4a5a7a', height: '100%', transition: 'width 0.5s ease' }} 
                        />
                      )}
                    </div>

                    {/* Miniature stats legend */}
                    <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.68rem', color: 'var(--text-muted)', flexWrap: 'wrap', paddingLeft: '0.75rem' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--success)' }} /> PASS: {c.passed}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#ff4d6d' }} /> FAIL: {c.failed}
                      </span>
                      {c.meanders > 0 && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--warning)' }} /> MEANDER: {c.meanders}
                        </span>
                      )}
                      {c.errors > 0 && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#4a5a7a' }} /> ERROR: {c.errors}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.82rem' }}>
                No classification breakdown available. Run folder scans to register deed types.
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Heuristic corrections applied & Closure distribution */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Repair Heuristics Counter */}
          <div className="card">
            <div className="card-header" style={{ paddingBottom: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
              <div className="card-title">🔧 Active Heuristic Fixes & Successes</div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Geometric fixes dynamically applied during compilation
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {stats?.repairStages && stats.repairStages.length > 0 ? (
                stats.repairStages.map((s, idx) => (
                  <div key={idx} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.6rem 0.8rem',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)'
                  }}>
                    <div>
                      <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {s.stage}
                      </div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                        Automated algorithm correction
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--accent2)', fontFamily: 'JetBrains Mono' }}>
                        {s.count}
                      </div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--success)' }}>
                        Passed: {s.passed}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.82rem' }}>
                  No automated repairs applied yet. Algorithms trigger dynamically based on geometric error conditions.
                </div>
              )}
            </div>
          </div>

          {/* Closure Error Distribution Card */}
          <div className="card">
            <div className="card-header" style={{ paddingBottom: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
              <div className="card-title">📐 Unclosed Deeds - Distance Distribution</div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Closure vector errors for failed/needs-review traverses
              </span>
            </div>

            {stats?.errorDistribution ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {[
                  { label: '≤ 1.0 ft (Near Closed / High Fixability)', value: stats.errorDistribution.nearClosed, color: 'var(--accent2)', bucket: 'nearClosed', pct: stats.failCount > 0 ? (stats.errorDistribution.nearClosed / stats.failCount) * 100 : 0 },
                  { label: '1.0 to 10.0 ft (Minor Surveyor Error)', value: stats.errorDistribution.minorError, color: 'var(--warning)', bucket: 'minorError', pct: stats.failCount > 0 ? (stats.errorDistribution.minorError / stats.failCount) * 100 : 0 },
                  { label: '10.0 to 100.0 ft (Moderate Traverse Gap)', value: stats.errorDistribution.moderateError, color: '#f5a623', bucket: 'moderateError', pct: stats.failCount > 0 ? (stats.errorDistribution.moderateError / stats.failCount) * 100 : 0 },
                  { label: '> 100.0 ft (Major Boundary Misread)', value: stats.errorDistribution.majorError, color: '#ff4d6d', bucket: 'majorError', pct: stats.failCount > 0 ? (stats.errorDistribution.majorError / stats.failCount) * 100 : 0 },
                ].map((item, idx) => (
                  <div key={idx}
                    onClick={() => item.value > 0 ? openDrawer(item.bucket) : undefined}
                    style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', cursor: item.value > 0 ? 'pointer' : 'default' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                      <span style={{ color: drawerOpen && activeBucket === item.bucket ? item.color : 'var(--text-secondary)', transition: 'color 0.15s' }}>
                        {item.label} {item.value > 0 && <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>→ click to expand</span>}
                      </span>
                      <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono', color: item.color }}>
                        {item.value} deeds ({item.pct.toFixed(0)}%)
                      </span>
                    </div>
                    <div style={{ height: '6px', background: 'var(--bg-elevated)', borderRadius: '3px', overflow: 'hidden', border: drawerOpen && activeBucket === item.bucket ? `1px solid ${item.color}66` : '1px solid transparent', transition: 'border-color 0.2s' }}>
                      <div style={{
                        height: '100%', borderRadius: '3px', background: item.color,
                        width: `${item.pct}%`, transition: 'width 0.4s ease'
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.82rem' }}>
                No error distribution available.
              </div>
            )}
          </div>

        </div>

      </div>

      {/* ── Failed Deed Drill-Down Drawer ─────────────────────────────────── */}
      {drawerOpen && (() => {
        const bucketLabels = {
          null:          'All Unclosed Deeds',
          nearClosed:    '≤ 1.0 ft — Near Closed',
          minorError:    '1–10 ft — Minor Error',
          moderateError: '10–100 ft — Moderate Error',
          majorError:    '> 100 ft — Major Misread',
        };
        const label = bucketLabels[activeBucket] ?? 'All Unclosed Deeds';

        // Sort
        const sorted = [...failedDeeds].sort((a, b) => {
          const av = a[sortField] ?? '';
          const bv = b[sortField] ?? '';
          if (typeof av === 'number') return sortDir === 'desc' ? bv - av : av - bv;
          return sortDir === 'desc' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
        });

        const toggleSort = (field) => {
          if (sortField === field) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
          else { setSortField(field); setSortDir('desc'); }
        };

        const SortIcon = ({ field }) => sortField === field
          ? <span style={{ marginLeft: 3, fontSize: '0.6rem' }}>{sortDir === 'desc' ? '▾' : '▴'}</span>
          : <span style={{ marginLeft: 3, fontSize: '0.6rem', opacity: 0.3 }}>▾</span>;

        return (
          <div className="card" style={{ borderColor: 'rgba(255,77,109,0.35)', animation: 'slideDown 0.18s ease' }}>
            <div className="card-header" style={{ paddingBottom: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ fontSize: '1rem' }}>⚠</span>
                <div className="card-title">{label}</div>
                {failedLoading
                  ? <span style={{ fontSize: '0.72rem', color: 'var(--accent)' }}>Loading…</span>
                  : <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{sorted.length} deed{sorted.length !== 1 ? 's' : ''}</span>}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => fetchFailedDeeds(activeBucket)} style={{ fontSize: '0.72rem' }}>↻</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setDrawerOpen(false); setActiveBucket(null); }} style={{ fontSize: '0.72rem' }}>✕ Close</button>
              </div>
            </div>

            {sorted.length === 0 && !failedLoading ? (
              <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                No unclosed deeds in this range. 🎉
              </div>
            ) : (
              <div className="data-table-wrap" style={{ maxHeight: '420px', overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th onClick={() => toggleSort('fileName')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                        File <SortIcon field="fileName" />
                      </th>
                      <th onClick={() => toggleSort('status')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                        Status <SortIcon field="status" />
                      </th>
                      <th onClick={() => toggleSort('linearError')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                        Linear Error (ft) <SortIcon field="linearError" />
                      </th>
                      <th onClick={() => toggleSort('geoCallCount')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                        Segments <SortIcon field="geoCallCount" />
                      </th>
                      <th onClick={() => toggleSort('repairStageUsed')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                        Last Stage <SortIcon field="repairStageUsed" />
                      </th>
                      <th onClick={() => toggleSort('timestamp')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                        Last Attempt <SortIcon field="timestamp" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((d, i) => {
                      const errColor = d.linearError <= 1 ? 'var(--success)'
                        : d.linearError <= 10 ? 'var(--warning)'
                        : d.linearError <= 100 ? '#f5a623'
                        : 'var(--danger)';
                      const isActive = selectedDeed?.fileName === d.fileName;
                      return (
                        <tr key={i}
                          onClick={() => fetchDeedDetail(d.fileName)}
                          style={{ cursor: 'pointer', background: isActive ? 'rgba(61,127,255,0.12)' : undefined, outline: isActive ? '1px solid rgba(61,127,255,0.4)' : undefined }}
                        >
                          <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.fileName}>
                            {d.fileName}
                          </td>
                          <td>
                            <span style={{
                              fontSize: '0.68rem', fontWeight: 700, padding: '1px 8px', borderRadius: '99px',
                              background: d.status === 'FAIL' ? 'rgba(255,77,109,0.12)' : 'rgba(220,50,50,0.1)',
                              border: d.status === 'FAIL' ? '1px solid rgba(255,77,109,0.4)' : '1px solid rgba(220,50,50,0.3)',
                              color: d.status === 'FAIL' ? '#ff4d6d' : '#c95050',
                            }}>{d.status}</span>
                          </td>
                          <td style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: errColor }}>
                            {d.linearError != null ? d.linearError.toFixed(3) : '—'}
                          </td>
                          <td style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
                            {d.geoCallCount ?? '—'}
                          </td>
                          <td style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.repairStageUsed ?? ''}>
                            {d.repairStageUsed || '—'}
                          </td>
                          <td style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', fontFamily: 'JetBrains Mono, monospace' }}>
                            {d.timestamp?.replace('T', ' ').slice(0, 16) || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── System Details & Quick Database Actions ─────────────────────────── */}
      <div className="card" style={{ marginTop: '0.5rem' }}>
        <div className="card-header" style={{ paddingBottom: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1.25rem' }}>
          <div className="card-title">💾 Database Storage & Administrative Control</div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Manage the SQLite backing engine and cached diagnostics logs
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Metadata Row */}
          {stats && (
            <div style={{ 
              display: 'flex', gap: '2rem', flexWrap: 'wrap', 
              fontSize: '0.78rem', color: 'var(--text-muted)',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', 
              borderRadius: 'var(--radius-md)', padding: '1rem' 
            }}>
              <span>💾 DB Size: <strong style={{ color: 'var(--text-primary)' }}>{stats.fileSizeMb} MB</strong></span>
              <span>📅 Oldest Log: <strong style={{ color: 'var(--text-primary)' }}>{stats.oldestTimestamp || '—'}</strong></span>
              <span>📅 Newest Log: <strong style={{ color: 'var(--text-primary)' }}>{stats.newestTimestamp || '—'}</strong></span>
              <span style={{ flex: 1, minWidth: '250px' }}>📂 Absolute Path: <code style={{ fontSize: '0.7rem', color: 'var(--accent)' }}>{stats.dbPath}</code></span>
            </div>
          )}

          {/* Warning buttons */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Cache Operations:</span>
            
            {confirmAction === null ? (
              <>
                <button 
                  className="btn btn-sm btn-ghost" 
                  disabled={dbLoading}
                  onClick={() => setConfirmAction('clear-failed')}
                  style={{ border: '1px solid rgba(245, 166, 35, 0.3)', color: 'var(--warning)', background: 'rgba(245, 166, 35, 0.05)' }}
                >
                  ♻️ Clear Failures & Retry
                </button>
                <button 
                  className="btn btn-sm btn-ghost" 
                  disabled={dbLoading}
                  onClick={() => setConfirmAction('clear-all')}
                  style={{ border: '1px solid rgba(255, 77, 109, 0.3)', color: 'var(--danger)', background: 'rgba(255, 77, 109, 0.05)' }}
                >
                  🗑️ Purge Diagnostics Database
                </button>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', background: 'rgba(255, 77, 109, 0.1)', border: '1px solid rgba(255, 77, 109, 0.3)', borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.8rem' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                  ⚠️ Are you absolutely sure? {confirmAction === 'clear-all' ? 'This deletes ALL logs and batches!' : 'This clears failed cache.'}
                </span>
                <button 
                  className="btn btn-primary btn-sm" 
                  onClick={() => runDbAction(confirmAction === 'clear-all' ? 'clear-all' : 'clear-failed', confirmAction === 'clear-all' ? 'Clear All' : 'Clear Failed')}
                  style={{ background: 'var(--danger)', padding: '0.2rem 0.6rem', fontSize: '0.72rem' }}
                >
                  Yes, Proceed
                </button>
                <button 
                  className="btn btn-ghost btn-sm" 
                  onClick={() => setConfirmAction(null)}
                  style={{ padding: '0.2rem 0.6rem', fontSize: '0.72rem' }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

    </div>

      {/* ── Deed Preview Slide-In Panel ─────────────────────────────────────── */}
      {selectedDeed && (
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(640px, 100vw)',
          background: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border)',
          boxShadow: '-8px 0 40px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column',
          zIndex: 500,
          animation: 'slideInRight 0.22s ease',
        }}>
          {/* Panel header */}
          <div style={{ padding: '1rem 1.25rem 0.75rem', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                  {selectedDeed.fileName}
                </div>
                {selectedDeed.parcelName && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{selectedDeed.parcelName}</div>
                )}
              </div>
              <button onClick={closeDeedPanel} style={{ flexShrink: 0, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.7rem', background: selectedDeed.status === 'FAIL' ? 'rgba(255,77,109,0.12)' : 'rgba(220,50,50,0.1)', border: `1px solid ${selectedDeed.status === 'FAIL' ? 'rgba(255,77,109,0.4)' : 'rgba(220,50,50,0.3)'}`, color: selectedDeed.status === 'FAIL' ? '#ff4d6d' : '#c95050', borderRadius: '99px', padding: '1px 10px', fontWeight: 700 }}>
                {selectedDeed.status}
              </span>
              {selectedDeed.linearError != null && (
                <span style={{ fontSize: '0.7rem', color: selectedDeed.linearError > 100 ? 'var(--danger)' : selectedDeed.linearError > 10 ? '#f5a623' : 'var(--warning)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                  ⊿ {selectedDeed.linearError.toFixed(3)} ft error
                </span>
              )}
              {selectedDeed.geoCallCount > 0 && (
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                  {selectedDeed.geoCallCount} course{selectedDeed.geoCallCount !== 1 ? 's' : ''} extracted
                </span>
              )}
              {selectedDeed.repairStageUsed && (
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selectedDeed.repairStageUsed}>
                  🔧 {selectedDeed.repairStageUsed}
                </span>
              )}
            </div>
            {normalizeExtraction(selectedDeed.extraction)?.mentalMapSummary && (
              <div style={{ marginTop: '0.6rem', fontSize: '0.72rem', color: 'var(--text-secondary)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', borderLeft: '3px solid var(--accent)' }}>
                🗺 {normalizeExtraction(selectedDeed.extraction).mentalMapSummary}
              </div>
            )}
            <div style={{ display: 'flex', gap: 0, marginTop: '0.75rem', borderBottom: '1px solid var(--border)' }}>
              {[
                { id: 'text',     label: '📄 Raw Text' },
                { id: 'courses',  label: `📐 Courses (${(normalizeExtraction(selectedDeed.extraction)?.courses || []).length})` },
                { id: 'traverse', label: '📊 Traverse' },
              ].map(tab => (
                <button key={tab.id} onClick={() => setDeedTab(tab.id)} style={{
                  padding: '0.45rem 0.9rem', fontSize: '0.75rem', border: 'none', cursor: 'pointer',
                  background: 'none', fontFamily: 'inherit', fontWeight: deedTab === tab.id ? 700 : 400,
                  color: deedTab === tab.id ? 'var(--accent)' : 'var(--text-muted)',
                  borderBottom: deedTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'all 0.15s', marginBottom: '-1px',
                }}>
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem' }}>
            {deedLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200, flexDirection: 'column', gap: '0.75rem' }}>
                <div className="spinner" style={{ width: 32, height: 32 }} />
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading deed…</span>
              </div>
            ) : deedTab === 'text' ? (
              <div>
                {deedText ? (
                  <pre style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1rem' }}>
                    {deedText}
                  </pre>
                ) : (
                  <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📂</div>
                    No raw text file found on disk.
                    <br />
                    <span style={{ fontSize: '0.72rem' }}>Expected: <code>{folderPath ? folderPath + '/_extracted/<basename>.txt' : '_extracted/<basename>.txt'}</code></span>
                  </div>
                )}
              </div>
            ) : deedTab === 'courses' ? (
              (() => {
                const courses = normalizeExtraction(selectedDeed.extraction)?.courses || [];
                if (!courses.length) return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>No courses extracted from this deed.</div>;
                return (
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead><tr><th>#</th><th>Type</th><th>Bearing</th><th>Distance (ft)</th><th>Arc Len</th><th>Radius</th><th>Delta</th></tr></thead>
                      <tbody>
                        {courses.map((c, ci) => (
                          <tr key={ci}>
                            <td style={{ color: 'var(--text-muted)', textAlign: 'center' }}>{ci + 1}</td>
                            <td style={{ color: c.type === 'Curve' ? 'var(--accent)' : 'var(--text-secondary)' }}>{c.type || 'Line'}</td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace', color: c.isUnknown ? 'var(--danger)' : 'var(--text-primary)' }}>{c.bearing || c.chordBearing || '—'}</td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent2)' }}>{c.distance != null ? c.distance.toFixed(2) : (c.chordDistance != null ? c.chordDistance.toFixed(2) : '—')}</td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{c.arcLength != null ? c.arcLength.toFixed(2) : '—'}</td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{c.radius != null ? c.radius.toFixed(2) : '—'}</td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{c.delta || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()
            ) : (
              (() => {
                const tv = selectedDeed.traverse;
                if (!tv) return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>No traverse data for this deed.</div>;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {[
                      ['Linear Error', tv.closure?.linearError != null ? `${tv.closure.linearError.toFixed(4)} ft` : '—', 'var(--danger)'],
                      ['Closure Precision', tv.closure?.precisionRatio != null ? `1:${Math.round(tv.closure.precisionRatio).toLocaleString()}` : '—', 'var(--text-primary)'],
                      ['Perimeter', tv.perimeter != null ? `${tv.perimeter.toFixed(2)} ft` : '—', 'var(--text-secondary)'],
                      ['Area (sq ft)', tv.areaSqFt != null ? tv.areaSqFt.toFixed(2) : '—', 'var(--text-secondary)'],
                      ['Area (acres)', tv.areaAcres != null ? tv.areaAcres.toFixed(4) : '—', 'var(--accent2)'],
                    ].map(([label, val, color]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.55rem 0.8rem', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{label}</span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color, fontSize: '0.9rem' }}>{val}</span>
                      </div>
                    ))}
                    {tv.stations?.length > 0 && (
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Station Coordinates</div>
                        <div className="data-table-wrap">
                          <table className="data-table">
                            <thead><tr><th>#</th><th>Northing</th><th>Easting</th></tr></thead>
                            <tbody>
                              {tv.stations.map((s, si) => (
                                <tr key={si}>
                                  <td style={{ color: 'var(--text-muted)', textAlign: 'center' }}>{si + 1}</td>
                                  <td style={{ color: 'var(--accent2)' }}>{(s.northing ?? s.n ?? 0).toFixed(4)}</td>
                                  <td style={{ color: 'var(--accent)' }}>{(s.easting ?? s.e ?? 0).toFixed(4)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()
            )}
          </div>
        </div>
      )}
      {selectedDeed && (
        <div onClick={closeDeedPanel} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 499, backdropFilter: 'blur(2px)' }} />
      )}
    </>
  );
}
