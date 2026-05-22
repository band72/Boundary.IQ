import { useState } from 'react';
import TraverseTab from './components/TraverseTab';
import PlatTab from './components/PlatTab';
import WriterTab from './components/WriterTab';
import BatchDeedTab from './components/BatchDeedTab';

const TABS = [
  { id: 'traverse',   icon: '📐', label: 'Traverse Compute' },
  { id: 'plat',       icon: '🛰',  label: 'Plat Extraction'  },
  { id: 'writer',     icon: '✍️',  label: 'Writer'           },
  { id: 'batch',      icon: '📦',  label: 'Batch Deed'       },
];

export default function App() {
  const [tab, setTab] = useState('traverse');

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="app-header">
        <div className="logo-mark">
          <div className="logo-icon">⬡</div>
          <div className="logo-text">Boundary<span>.IQ</span></div>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
          Survey Intelligence Platform
        </span>
        <div className="header-badge">BETA · v1.0</div>
      </header>

      <div className="main-content">
        {/* Sidebar */}
        <nav className="sidebar">
          <div className="nav-section" style={{ marginTop: '0.5rem' }}>Tools</div>
          {TABS.map(t => (
            <button
              key={t.id}
              className={`nav-item ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className="nav-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}

          <div className="divider" style={{ margin: '1rem 1.25rem' }} />
          <div className="nav-section">Resources</div>
          <button className="nav-item">
            <span className="nav-icon">📖</span> API Docs
          </button>
          <button className="nav-item">
            <span className="nav-icon">⚡</span> Health Status
          </button>

          {/* Engine badge */}
          <div style={{ marginTop: 'auto', padding: '1rem 1.25rem' }}>
            <div style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '0.75rem',
              fontSize: '0.72rem',
              color: 'var(--text-muted)',
              lineHeight: 1.7
            }}>
              <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: '0.3rem' }}>RCS COGO Engine</div>
              <div>GeometryEngine · Forward</div>
              <div>Compass Rule Adjustment</div>
              <div>Shoelace Area</div>
              <div style={{ marginTop: '0.3rem', color: 'var(--success)' }}>● Connected</div>
            </div>
          </div>
        </nav>

        {/* Workspace */}
        <main className="workspace">
          {tab === 'traverse' && <TraverseTab />}
          {tab === 'plat'     && <PlatTab />}
          {tab === 'writer'   && <WriterTab />}
          {tab === 'batch'    && <BatchDeedTab />}
        </main>
      </div>
    </div>
  );
}
