import { useState, useCallback } from 'react';
import { toGeoJson, toKml } from '../utils/exportEngine.js';

/**
 * ExportModal — GeoJSON / KML export dialog
 *
 * Props:
 *   stations   {Array}       Traverse station points
 *   courses    {Array}       Course array
 *   meta       {object}      { parcel, county, state, units, areaAcres, perimeter, precisionRatio }
 *   geoRef     {object|null} Georeferencing config (pobLat, pobLng, rotationDeg, scaleFactor, units)
 *   onClose    {function}    Called when the modal should close
 */
export default function ExportModal({ stations, courses, meta, geoRef, onClose }) {
  const [activeTab, setActiveTab] = useState('geojson');
  const [copied, setCopied]       = useState(false);

  const getContent = useCallback(() => {
    try {
      if (activeTab === 'geojson') return toGeoJson(stations, courses, meta, geoRef);
      return toKml(stations, courses, meta, geoRef);
    } catch (e) {
      return `/* Error generating ${activeTab.toUpperCase()}: ${e.message} */`;
    }
  }, [activeTab, stations, courses, meta, geoRef]);

  const content = getContent();
  const ext     = activeTab === 'geojson' ? 'geojson' : 'kml';
  const mime    = activeTab === 'geojson' ? 'application/geo+json' : 'application/vnd.google-earth.kml+xml';
  const label   = activeTab === 'geojson' ? 'GeoJSON' : 'KML';
  const parcelSlug = (meta?.parcel || 'parcel').replace(/\s+/g, '_').replace(/[^a-z0-9_-]/gi, '').toLowerCase();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Fallback for non-https
      const ta = document.createElement('textarea');
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${parcelSlug}_boundary.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 1200,
          background: 'rgba(6, 10, 22, 0.72)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 1201,
          width: 'min(780px, 95vw)',
          maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.25rem',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div>
            <h2 id="export-modal-title" style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              📤 Export Boundary Data
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {meta?.parcel || 'Subject Parcel'} · {courses?.length ?? 0} courses
              {geoRef?.pobLat ? ` · Georeferenced (${parseFloat(geoRef.pobLat).toFixed(6)}, ${parseFloat(geoRef.pobLng).toFixed(6)})` : ' · Local grid coordinates'}
            </p>
          </div>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onClose}
            aria-label="Close export modal"
            style={{ fontSize: '1.1rem', color: 'var(--text-muted)' }}
          >✕</button>
        </div>

        {/* Tab bar */}
        <div style={{
          display: 'flex', gap: 0,
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          padding: '0 1.25rem',
        }}>
          {['geojson', 'kml'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '0.6rem 1.2rem',
                fontSize: '0.8rem', fontWeight: 600,
                background: 'none', border: 'none', cursor: 'pointer',
                color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                letterSpacing: '0.04em', textTransform: 'uppercase',
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {tab === 'geojson' ? 'GeoJSON' : 'KML'}
            </button>
          ))}
        </div>

        {/* Code preview */}
        <div style={{ flex: 1, overflow: 'auto', padding: '0.75rem 1.25rem' }}>
          <pre
            aria-label={`${label} export preview`}
            style={{
              margin: 0,
              fontFamily: '"JetBrains Mono", "Fira Code", monospace',
              fontSize: '0.72rem',
              lineHeight: 1.65,
              color: '#a8c4ff',
              background: 'var(--bg-deep, #060a16)',
              borderRadius: 'var(--radius-md)',
              padding: '1rem',
              overflowX: 'auto',
              whiteSpace: 'pre',
              border: '1px solid rgba(61,127,255,0.15)',
              minHeight: 200,
            }}
          >
            {content}
          </pre>
        </div>

        {/* Footer actions */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: '0.6rem',
          padding: '0.9rem 1.25rem',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginRight: 'auto' }}>
            {content.length.toLocaleString()} characters
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
          <button
            id="export-copy-btn"
            className="btn btn-ghost btn-sm"
            onClick={handleCopy}
            style={{
              background: copied ? 'rgba(0,200,100,0.1)' : undefined,
              color: copied ? 'var(--success)' : undefined,
              border: `1px solid ${copied ? 'var(--success)' : 'var(--border)'}`,
              transition: 'all 0.2s',
            }}
          >
            {copied ? '✓ Copied!' : '📋 Copy'}
          </button>
          <button
            id="export-download-btn"
            className="btn btn-primary btn-sm"
            onClick={handleDownload}
          >
            ⬇ Download .{ext}
          </button>
        </div>
      </div>
    </>
  );
}
