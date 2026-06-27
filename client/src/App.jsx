import { useState, useEffect, Component, useMemo, useCallback, lazy, Suspense } from 'react';
// ── Lazy-loaded tab components — each loads only when first visited ────────────
const TraverseTab  = lazy(() => import('./components/TraverseTab'));
const PlatTab      = lazy(() => import('./components/PlatTab'));
const WriterTab    = lazy(() => import('./components/WriterTab'));
const BatchDeedTab = lazy(() => import('./components/BatchDeedTab'));
const DashboardTab = lazy(() => import('./components/DashboardTab'));
const SettingsTab  = lazy(() => import('./components/SettingsTab'));
const UserSettingsTab = lazy(() => import('./components/UserSettingsTab'));
const HelpModal    = lazy(() => import('./components/HelpModal'));
const AdminPanel   = lazy(() => import('./components/AdminPanel'));
const BillingTab   = lazy(() => import('./components/BillingTab'));
const ScriptingTab = lazy(() => import('./components/ScriptingTab'));
const LoginScreen  = lazy(() => import('./components/LoginScreen'));
import { StatsRefreshProvider } from './hooks/useStatsRefresh.jsx';
import { useLocalStorage } from './hooks/useLocalStorage';
import { AuthProvider } from './context/AuthProvider';
import { useAuthContext } from './context/AuthContext';
import { API } from './config.js';

// ─── Tab Error Boundary ────────────────────────────────────────────────────────
class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[TabErrorBoundary] Uncaught render error:', error, info.componentStack);
    const msg = (error?.message || String(error)).toLowerCase();
    if (msg.includes('dynamically imported module') || msg.includes('failed to fetch') || msg.includes('loading chunk')) {
      console.warn('Vite chunk load failure detected in TabErrorBoundary. Reloading page...');
      window.location.reload();
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100%', minHeight: '380px',
          padding: '2rem', boxSizing: 'border-box'
        }}>
          <div className="card" style={{
            width: '100%', maxWidth: '600px', padding: 0, overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)', border: '1px solid var(--border)'
          }}>
            {/* Professional Top Banner with Logo */}
            <div style={{
              background: 'var(--bg-elevated)',
              borderBottom: '1px solid var(--border)',
              padding: '1.25rem 2rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem'
            }}>
              <span style={{ fontSize: '1.5rem', color: 'var(--accent)' }}>⬡</span>
              <span style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                Boundary<span style={{ color: 'var(--accent)' }}>.IQ</span>
              </span>
            </div>

            {/* Error Content Body */}
            <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center' }}>
              <div style={{ fontSize: '2.5rem' }}>⚠️</div>
              <h3 style={{ margin: 0, color: 'var(--text-primary)', fontWeight: 600 }}>
                Application Error Detected
              </h3>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center', maxWidth: '480px' }}>
                The workspace encountered an unexpected runtime error. The details of the failure are listed below:
              </p>
              
              <div style={{
                width: '100%',
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.8rem',
                color: 'var(--danger)',
                background: 'rgba(255, 77, 109, 0.05)',
                border: '1px solid rgba(255, 77, 109, 0.15)',
                borderRadius: 'var(--radius-md)', padding: '1rem',
                boxSizing: 'border-box',
                textAlign: 'left', wordBreak: 'break-word',
                maxHeight: '150px', overflowY: 'auto'
              }}>
                {this.state.error?.message || String(this.state.error)}
              </div>

              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
                <button
                  className="btn btn-ghost"
                  onClick={() => window.location.reload()}
                >
                  🔄 Reload Platform
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => this.setState({ hasError: false, error: null })}
                >
                  Dismiss & Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Tab lazy-load spinner ─────────────────────────────────────────────────────
function TabSpinner() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: '0.75rem', color: 'var(--text-muted)',
    }}>
      <span className="spinner" style={{ width: 28, height: 28, borderWidth: 2 }} />
      <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>Loading module…</span>
    </div>
  );
}


// minRole: 'user' = all logged-in users | 'admin' = admins only
// minPlan: plan gate (only relevant when user already has minRole access)
// status:  'live' | 'testing' — 'testing' shows a chip in the sidebar for admin
const TABS = [
  { id: 'traverse',  icon: '📐', label: 'Deed Reader',      minRole: 'user',  minPlan: 'free', status: 'live'    },
  { id: 'plat',      icon: '🛰',  label: 'Plat Extraction',  minRole: 'user',  minPlan: 'free', status: 'testing' },
  { id: 'writer',    icon: '✍️',  label: 'Deed Writer',      minRole: 'user',  minPlan: 'free', status: 'live'    },
  { id: 'batch',     icon: '📦',  label: 'Batch Deed',       minRole: 'user',  minPlan: 'free', status: 'testing' },
  { id: 'scripting', icon: '📝',  label: 'Linework Scripting', minRole: 'user', minPlan: 'free', status: 'live'   },
  { id: 'dashboard', icon: '📊',  label: 'Dashboard',        minRole: 'user',  minPlan: 'free', status: 'testing' },
  { id: 'settings',  icon: '⚙️',  label: 'Settings',         minRole: 'user',  minPlan: 'free', status: 'live'    },
];

const PLAN_RANK   = { free: 0, pro: 1, enterprise: 2, admin: 99 };
const ROLE_RANK   = { user: 0, admin: 99 };
const userRoleRank = (user) => user?.role === 'admin' ? 99 : 0;
const userPlanRank = (user) => user?.role === 'admin' ? 99 : (PLAN_RANK[user?.plan] ?? 0);
const hasRoleAccess = (user, minRole) => userRoleRank(user) >= (ROLE_RANK[minRole] ?? 0);
const hasAccess = (user, tab) =>
  hasRoleAccess(user, tab.minRole) &&
  (user?.role === 'admin' || userPlanRank(user) >= (PLAN_RANK[tab.minPlan] ?? 0));

// ── Root export — wraps everything in AuthProvider ────────────────────────────
export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

// ── Inner shell — consumes AuthContext ────────────────────────────────────────
function AppShell() {
  const { user, authLoading, login, logout } = useAuthContext();

  const [hideTraverse, setHideTraverse] = useLocalStorage('boundaryiq_hide_traverse', false);
  const [hidePlat, setHidePlat]         = useLocalStorage('boundaryiq_hide_plat', false);
  const [hideWriter, setHideWriter]     = useLocalStorage('boundaryiq_hide_writer', false);
  const [panelPolicy]                   = useLocalStorage('boundaryiq_panel_policy', {});
  const [tab, setTab]                   = useState('writer');
  const [helpOpen, setHelpOpen]         = useState(false);
  const [healthStatus, setHealthStatus] = useState(null); // null | 'ok' | 'error'

  const isAdmin = user?.role === 'admin';

  // ── Health Status button handler ───────────────────────────────────────────
  const checkHealth = async () => {
    setHealthStatus(null);
    try {
      const token = localStorage.getItem('boundaryiq_token');
      const res = await fetch(`${API.replace(/\/api$/, '')}/api/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      setHealthStatus(res.ok ? 'ok' : 'error');
      setTimeout(() => setHealthStatus(null), 4000);
    } catch {
      setHealthStatus('error');
      setTimeout(() => setHealthStatus(null), 4000);
    }
  };

  // Listen for 401 → session expired events from api/index.js
  useEffect(() => {
    const onExpired = () => logout();
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [logout]);

  const isPanelAllowed = useCallback((panelId) => {
    if (isAdmin) return true;
    return panelPolicy[panelId] !== false;
  }, [isAdmin, panelPolicy]);

  const visibleTabs = useMemo(() => {
    return TABS.filter(t => {
      if (!hasRoleAccess(user, t.minRole)) return false;
      if (!isPanelAllowed(t.id)) return false;
      
      if (isAdmin) {
        if (t.id === 'traverse' && hideTraverse) return false;
        if (t.id === 'plat'     && hidePlat)     return false;
        if (t.id === 'writer'   && hideWriter)   return false;
      } else {
        if (t.id === 'traverse' && hideTraverse) return false;
      }
      return true;
    });
  }, [isAdmin, user, isPanelAllowed, hideTraverse, hidePlat, hideWriter]);

  const extraTabs = useMemo(() => isAdmin ? [
    { id: 'billing', icon: '💳', label: 'Billing' },
    { id: 'admin',   icon: '👥', label: 'Users'   },
  ] : [], [isAdmin]);

  // Auto-redirect to first visible tab if the active tab disappears or is unauthorized
  useEffect(() => {
    const isTabInVisible = visibleTabs.some(t => t.id === tab);
    const isTabInExtra = extraTabs.some(t => t.id === tab);

    if (!isTabInVisible && !isTabInExtra) {
      const firstId = visibleTabs[0]?.id || 'settings';
      setTimeout(() => setTab(firstId), 0);
    }
  }, [tab, visibleTabs, extraTabs]);

  // ── Loading screen ──────────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh', background: '#090e1a',
        gap: '1rem', color: 'var(--text-secondary)',
      }}>
        <span className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
        <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>Verifying Engine Authorization...</span>
      </div>
    );
  }

  // ── Login screen ────────────────────────────────────────────────────────────
  if (!user) {
    return (
      <Suspense fallback={<TabSpinner />}>
        <LoginScreen onAuthSuccess={login} />
      </Suspense>
    );
  }

  // ── Main application shell ──────────────────────────────────────────────────
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
              {(user?.username || 'US').substring(0, 2).toUpperCase()}
            </div>
            <span className="user-name" title={user?.username || 'User'}>{user?.username || 'User'}</span>
            <span style={{
              fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase',
              padding: '2px 7px', borderRadius: '99px', flexShrink: 0,
              background: isAdmin ? 'rgba(201,122,0,0.15)' : 'rgba(61,127,255,0.12)',
              border: isAdmin ? '1px solid rgba(201,122,0,0.4)' : '1px solid rgba(61,127,255,0.3)',
              color: isAdmin ? '#ffaa00' : 'var(--accent)',
            }}>
              {isAdmin ? '🔑 Admin' : user?.plan === 'pro' ? '⭐ Pro' : user?.plan === 'enterprise' ? '🏢 Enterprise' : '👤 Free'}
            </span>
            <button className="logout-icon-btn" onClick={logout} title="Sign Out">
              🚪
            </button>
          </div>
        </header>

        <div className="main-content">
          {/* Sidebar */}
          <nav className="sidebar">
            <div className="nav-section" style={{ marginTop: '0.5rem' }}>Tools</div>
            {visibleTabs.map(t => {
              const planLocked = !isAdmin && userPlanRank(user) < (PLAN_RANK[t.minPlan] ?? 0);
              const isTesting  = t.status === 'testing';
              return (
                <button
                  key={t.id}
                  className={`nav-item ${tab === t.id ? 'active' : ''} ${planLocked ? 'nav-item-locked' : ''}`}
                  onClick={() => setTab(t.id)}
                  title={planLocked ? `Requires ${t.minPlan} plan` : t.label}
                  style={{ position: 'relative' }}
                >
                  <span className="nav-icon">{t.icon}</span>
                  {t.label}
                  {isTesting && (
                    <span style={{
                      marginLeft: 'auto', fontSize: '0.56rem', fontWeight: 800,
                      letterSpacing: '0.05em', background: 'rgba(255,170,0,0.12)',
                      border: '1px solid rgba(255,170,0,0.3)', color: '#ffaa00',
                      padding: '1px 5px', borderRadius: 3, flexShrink: 0,
                    }}>TEST</span>
                  )}
                  {planLocked && !isTesting && (
                    <span style={{
                      marginLeft: 'auto', fontSize: '0.58rem', fontWeight: 800,
                      letterSpacing: '0.06em', background: 'rgba(80,200,120,0.12)',
                      border: '1px solid rgba(80,200,120,0.3)', color: '#50c878',
                      padding: '1px 5px', borderRadius: 3, flexShrink: 0,
                    }}>PRO</span>
                  )}
                </button>
              );
            })}

            <div className="divider" style={{ margin: '1rem 1.25rem' }} />
            <div className="nav-section">Account</div>

            {extraTabs.map(t => (
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

            <button className="nav-item" onClick={() => setHelpOpen(true)} style={{ position: 'relative' }}>
              <span className="nav-icon">📖</span>
              Help &amp; Docs
              <span style={{
                marginLeft: 'auto', fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.06em',
                background: 'rgba(61,127,255,0.15)', border: '1px solid rgba(61,127,255,0.35)',
                color: 'var(--accent)', padding: '1px 5px', borderRadius: 3, flexShrink: 0,
              }}>README</span>
            </button>

            <button className="nav-item" onClick={checkHealth} style={{ position: 'relative' }}>
              <span className="nav-icon">⚡</span>
              Health Status
              {healthStatus === 'ok' && (
                <span style={{ marginLeft: 'auto', fontSize: '0.62rem', color: 'var(--success)', fontWeight: 700 }}>● Online</span>
              )}
              {healthStatus === 'error' && (
                <span style={{ marginLeft: 'auto', fontSize: '0.62rem', color: 'var(--danger)', fontWeight: 700 }}>● Error</span>
              )}
            </button>

            {/* Engine badge */}
            <div style={{ marginTop: 'auto', padding: '1rem 1.25rem' }}>
              <div style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)', padding: '0.75rem',
                fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.7,
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
          <TabErrorBoundary>
            <main className="workspace">
              <Suspense fallback={<TabSpinner />}>
                {tab === 'traverse'  && <TraverseTab />}
                {tab === 'plat'      && (
                  hasAccess(user, TABS.find(t => t.id === 'plat'))
                    ? <PlatTab />
                    : <TestingWall feature="Plat Extraction" icon="🛰" />
                )}
                {tab === 'writer'    && (
                  hasAccess(user, TABS.find(t => t.id === 'writer'))
                    ? <WriterTab />
                    : <TestingWall feature="Legal Description Writer" icon="✍️" />
                )}
                {tab === 'batch'     && (
                  hasAccess(user, TABS.find(t => t.id === 'batch'))
                    ? <BatchDeedTab />
                    : <TestingWall feature="Batch Deed Processing" icon="📦" />
                )}
                {tab === 'scripting' && (
                  hasAccess(user, TABS.find(t => t.id === 'scripting'))
                    ? <ScriptingTab />
                    : <TestingWall feature="Linework Scripting" icon="📝" />
                )}
                {tab === 'dashboard' && (
                  hasAccess(user, TABS.find(t => t.id === 'dashboard'))
                    ? <DashboardTab />
                    : <TestingWall feature="Dashboard" icon="📊" />
                )}
                {tab === 'settings'  && (
                  isAdmin ? (
                    <SettingsTab
                      hideTraverse={hideTraverse} setHideTraverse={setHideTraverse}
                      hidePlat={hidePlat}         setHidePlat={setHidePlat}
                      hideWriter={hideWriter}     setHideWriter={setHideWriter}
                    />
                  ) : (
                    <UserSettingsTab
                      hideTraverse={hideTraverse} setHideTraverse={setHideTraverse}
                      hidePlat={hidePlat}         setHidePlat={setHidePlat}
                      hideWriter={hideWriter}     setHideWriter={setHideWriter}
                    />
                  )
                )}
                {tab === 'billing' && <BillingTab user={user} />}
                {tab === 'admin'   && isAdmin && <AdminPanel />}
              </Suspense>
            </main>
          </TabErrorBoundary>
        </div>
      </div>

      {helpOpen && (
        <Suspense fallback={null}>
          <HelpModal onClose={() => setHelpOpen(false)} />
        </Suspense>
      )}
    </StatsRefreshProvider>
  );
}

// ── Testing Wall (features not yet released to users) ─────────────────────────
function TestingWall({ feature, icon }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: '1rem', padding: '3rem', textAlign: 'center',
    }}>
      <div style={{ fontSize: '3rem', filter: 'grayscale(0.3)' }}>{icon}</div>
      <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#fff' }}>{feature}</div>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.07em',
        background: 'rgba(255,170,0,.12)', border: '1px solid rgba(255,170,0,.35)',
        color: '#ffaa00', padding: '4px 12px', borderRadius: 99,
      }}>🔧 IN TESTING</div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', maxWidth: 400, lineHeight: 1.7 }}>
        This module is currently in active testing and will be released to users once validation is complete.
        Check back soon or contact your administrator.
      </div>
    </div>
  );
}


