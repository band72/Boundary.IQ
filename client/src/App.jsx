import { useState, useEffect } from 'react';
import TraverseTab from './components/TraverseTab';
import PlatTab from './components/PlatTab';
import WriterTab from './components/WriterTab';
import BatchDeedTab from './components/BatchDeedTab';
import DashboardTab from './components/DashboardTab';
import SettingsTab from './components/SettingsTab';
import HelpModal from './components/HelpModal';
import LoginScreen from './components/LoginScreen';
import { StatsRefreshProvider } from './hooks/useStatsRefresh.jsx';
import { useLocalStorage } from './hooks/useLocalStorage';

const TABS = [
  { id: 'traverse',   icon: '📐', label: 'Traverse Compute' },
  { id: 'plat',       icon: '🛰',  label: 'Plat Extraction'  },
  { id: 'writer',     icon: '✍️',  label: 'Writer'           },
  { id: 'batch',      icon: '📦',  label: 'Batch Deed'       },
  { id: 'dashboard',  icon: '📊', label: 'Dashboard'        },
  { id: 'settings',   icon: '⚙️',  label: 'Settings'         },
];

export default function App() {
  const [hideTraverse, setHideTraverse] = useLocalStorage('boundaryiq_hide_traverse', false);
  const [hidePlat, setHidePlat]         = useLocalStorage('boundaryiq_hide_plat', false);
  const [hideWriter, setHideWriter]     = useLocalStorage('boundaryiq_hide_writer', false);

  const [tab, setTab] = useState('traverse');
  const [helpOpen, setHelpOpen] = useState(false);

  // Authentication State
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Verify active session on load
  useEffect(() => {
    const token = localStorage.getItem('boundaryiq_auth_token');
    if (token) {
      fetch('/api/auth/me', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      .then(res => {
        if (!res.ok) throw new Error('Session invalid');
        return res.json();
      })
      .then(data => {
        setUser(data);
      })
      .catch(() => {
        localStorage.removeItem('boundaryiq_auth_token');
      })
      .finally(() => {
        setAuthLoading(false);
      });
    } else {
      setAuthLoading(false);
    }
  }, []);

  const handleAuthSuccess = (payload) => {
    localStorage.setItem('boundaryiq_auth_token', payload.token);
    setUser({ username: payload.username, role: payload.role });
  };

  const handleLogout = async () => {
    const token = localStorage.getItem('boundaryiq_auth_token');
    localStorage.removeItem('boundaryiq_auth_token');
    setUser(null);

    if (token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
      } catch (err) {
        console.error('Revoke session failed:', err.message);
      }
    }
  };

  // Auto-redirect if currently active tab gets hidden
  useEffect(() => {
    if (hideTraverse && tab === 'traverse') {
      setTimeout(() => setTab('batch'), 0);
    } else if (hidePlat && tab === 'plat') {
      setTimeout(() => setTab('batch'), 0);
    } else if (hideWriter && tab === 'writer') {
      setTimeout(() => setTab('batch'), 0);
    }
  }, [hideTraverse, hidePlat, hideWriter, tab]);

  const visibleTabs = TABS.filter(t => {
    if (t.id === 'traverse' && hideTraverse) return false;
    if (t.id === 'plat' && hidePlat) return false;
    if (t.id === 'writer' && hideWriter) return false;
    return true;
  });

  if (authLoading) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#090e1a',
        gap: '1rem',
        color: 'var(--text-secondary)'
      }}>
        <span className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }}></span>
        <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>Verifying Engine Authorization...</span>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onAuthSuccess={handleAuthSuccess} />;
  }

  return (
    <StatsRefreshProvider>
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
          <div className="header-badge" style={{ marginRight: '1rem' }}>BETA · v1.0</div>

          {/* User Profile Badge */}
          <div className="user-badge" style={{ marginLeft: 'auto' }}>
            <div className="user-avatar">
              {user.username.substring(0, 2).toUpperCase()}
            </div>
            <span className="user-name" title={user.username}>{user.username}</span>
            <button className="logout-icon-btn" onClick={handleLogout} title="Sign Out">
              🚪
            </button>
          </div>
        </header>

        <div className="main-content">
          {/* Sidebar */}
          <nav className="sidebar">
            <div className="nav-section" style={{ marginTop: '0.5rem' }}>Tools</div>
            {visibleTabs.map(t => (
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

            {/* Help / Docs button */}
            <button
              className="nav-item"
              onClick={() => setHelpOpen(true)}
              style={{ position: 'relative' }}
            >
              <span className="nav-icon">📖</span>
              Help &amp; Docs
              <span style={{
                marginLeft: 'auto',
                fontSize: '0.58rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
                background: 'rgba(61,127,255,0.15)',
                border: '1px solid rgba(61,127,255,0.35)',
                color: 'var(--accent)',
                padding: '1px 5px',
                borderRadius: 3,
                flexShrink: 0,
              }}>README</span>
            </button>

            <button className="nav-item">
              <span className="nav-icon">⚡</span>
              Health Status
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
                <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: '0.3rem' }}>COGO Engine</div>
                <div>GeometryEngine · Forward</div>
                <div>Compass Rule Adjustment</div>
                <div>Shoelace Area</div>
                <div style={{ marginTop: '0.3rem', color: 'var(--success)' }}>● Connected</div>
              </div>
            </div>
          </nav>

          {/* Workspace */}
          <main className="workspace">
            {tab === 'traverse'  && <TraverseTab />}
            {tab === 'plat'      && <PlatTab />}
            {tab === 'writer'    && <WriterTab />}
            {tab === 'batch'     && <BatchDeedTab />}
            {tab === 'dashboard' && <DashboardTab />}
            {tab === 'settings'  && (
              <SettingsTab
                hideTraverse={hideTraverse}
                setHideTraverse={setHideTraverse}
                hidePlat={hidePlat}
                setHidePlat={setHidePlat}
                hideWriter={hideWriter}
                setHideWriter={setHideWriter}
              />
            )}
          </main>
        </div>
      </div>

      {/* Help Modal — rendered outside the app-shell so it overlays everything */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </StatsRefreshProvider>
  );
}
