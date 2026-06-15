import { useState, useEffect, useRef, Component } from 'react';
import TraverseTab from './components/TraverseTab';
import PlatTab from './components/PlatTab';
import WriterTab from './components/WriterTab';
import BatchDeedTab from './components/BatchDeedTab';
import DashboardTab from './components/DashboardTab';
import SettingsTab from './components/SettingsTab';
import UserSettingsTab from './components/UserSettingsTab';
import HelpModal from './components/HelpModal';
import LoginScreen from './components/LoginScreen';
import AdminPanel from './components/AdminPanel';
import BillingTab from './components/BillingTab';
import { StatsRefreshProvider } from './hooks/useStatsRefresh.jsx';
import { useLocalStorage } from './hooks/useLocalStorage';
import { API } from './config';

// ─── Tab Error Boundary ────────────────────────────────────────────────────────────
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
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100%', gap: '1.25rem',
          padding: '2rem', textAlign: 'center',
        }}>
          <div style={{ fontSize: '2.5rem' }}>⚠️</div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '1.05rem' }}>
            This tab encountered an unexpected error.
          </div>
          <div style={{
            fontFamily: 'monospace', fontSize: '0.78rem',
            color: 'var(--text-muted)', maxWidth: 520,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem',
            textAlign: 'left', wordBreak: 'break-word',
          }}>
            {this.state.error?.message || String(this.state.error)}
          </div>
          <button
            className="btn-primary"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            🔄 Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Tab & access definitions ─────────────────────────────────────────────────
// minRole: 'user' = all logged-in users | 'admin' = admins only
// minPlan: plan gate (only relevant when user already has minRole access)
// status:  'live' | 'testing' — 'testing' shows a chip in the sidebar for admin
const TABS = [
  { id: 'traverse',  icon: '📐', label: 'Deed Reader',   minRole: 'user',  minPlan: 'free', status: 'live'    },
  { id: 'plat',      icon: '🛰',  label: 'Plat Extraction', minRole: 'user',  minPlan: 'free', status: 'testing' },
  { id: 'writer',    icon: '✍️',  label: 'Writer',          minRole: 'user',  minPlan: 'free', status: 'testing' },
  { id: 'batch',     icon: '📦',  label: 'Batch Deed',      minRole: 'user',  minPlan: 'free', status: 'testing' },
  { id: 'dashboard', icon: '📊',  label: 'Dashboard',       minRole: 'user',  minPlan: 'free', status: 'testing' },
  { id: 'settings',  icon: '⚙️',  label: 'Settings',        minRole: 'user',  minPlan: 'free', status: 'live'    },
];

const PLAN_RANK  = { free: 0, pro: 1, enterprise: 2, admin: 99 };
const ROLE_RANK  = { user: 0, admin: 99 };
const userRoleRank = (user) => user?.role === 'admin' ? 99 : 0;
const userPlanRank = (user) => user?.role === 'admin' ? 99 : (PLAN_RANK[user?.plan] ?? 0);
/** true if the user has the required role AND plan for a tab */
const hasRoleAccess = (user, minRole) => userRoleRank(user) >= (ROLE_RANK[minRole] ?? 0);
const hasAccess = (user, tab) =>
  hasRoleAccess(user, tab.minRole) &&
  (user?.role === 'admin' || userPlanRank(user) >= (PLAN_RANK[tab.minPlan] ?? 0));

export default function App() {
  const [hideTraverse, setHideTraverse] = useLocalStorage('boundaryiq_hide_traverse', false);
  const [hidePlat, setHidePlat]         = useLocalStorage('boundaryiq_hide_plat', false);
  const [hideWriter, setHideWriter]     = useLocalStorage('boundaryiq_hide_writer', false);

  // Panel access policy set by admin — controls which tabs non-admin users see
  const [panelPolicy] = useLocalStorage('boundaryiq_panel_policy', {});

  const [tab, setTab] = useState('traverse');
  const [helpOpen, setHelpOpen] = useState(false);

  // Authentication State
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Verify active session on load
  useEffect(() => {
    const token = localStorage.getItem('boundaryiq_auth_token');
    if (token) {
      fetch(`${API}/auth/me`, {
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
    try {
      if (!payload) throw new Error('Authentication payload is null or undefined');
      if (!payload.token) throw new Error('Authentication token is missing from response');
      if (!payload.username) throw new Error('Authentication username is missing from response');

      localStorage.setItem('boundaryiq_auth_token', payload.token);
      setUser({ username: payload.username, role: payload.role, plan: payload.plan || 'free' });
    } catch (err) {
      console.error('handleAuthSuccess error:', err);
      alert('Authentication transition failed: ' + err.message);
    }
  };

  const handleLogout = async () => {
    const token = localStorage.getItem('boundaryiq_auth_token');
    localStorage.removeItem('boundaryiq_auth_token');
    setUser(null);

    if (token) {
      try {
        await fetch(`${API}/auth/logout`, {
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

  const isAdmin = user?.role === 'admin';

  // Helper: is a panel allowed for this user?
  const isPanelAllowed = (panelId) => {
    if (isAdmin) return true; // admins always see everything
    return panelPolicy[panelId] !== false; // default true if unset
  };

  // Build visible tab list FIRST — used by the redirect effect below.
  // Only show tabs whose minRole the user satisfies.
  // Admins always see ALL tabs (including testing ones).
  const visibleTabs = TABS.filter(t => {
    if (!hasRoleAccess(user, t.minRole)) return false; // role gate — hard hide for non-admins
    if (!isPanelAllowed(t.id)) return false;            // admin policy override
    if (t.id === 'traverse' && hideTraverse) return false;
    if (t.id === 'plat'     && hidePlat)     return false;
    if (t.id === 'writer'   && hideWriter)   return false;
    return true;
  });

  // Use a ref so the effect dep array never changes size
  const visibleTabsRef = useRef(visibleTabs);
  visibleTabsRef.current = visibleTabs;

  // Auto-redirect to first visible tab if the active tab disappears
  useEffect(() => {
    const vt = visibleTabsRef.current;
    const firstId = vt[0]?.id || 'settings';
    const currentDef = TABS.find(t => t.id === tab);
    const roleBlocked = currentDef && !hasRoleAccess(user, currentDef.minRole);
    if (
      (hideTraverse && tab === 'traverse') ||
      (hidePlat     && tab === 'plat')     ||
      (hideWriter   && tab === 'writer')   ||
      (!isPanelAllowed(tab) && tab !== 'settings') ||
      (roleBlocked          && tab !== 'settings')
    ) {
      setTimeout(() => setTab(firstId), 0);
    }
  }, [hideTraverse, hidePlat, hideWriter, tab, panelPolicy, user?.role]); // stable size — no derived values

  const extraTabs = [
    ...(true ? [{ id: 'billing', icon: '💳', label: 'Billing' }] : []),
    ...(isAdmin ? [{ id: 'admin', icon: '👥', label: 'Users' }] : []),
  ];

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
            <button className="logout-icon-btn" onClick={handleLogout} title="Sign Out">
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
          <TabErrorBoundary>
            <main className="workspace">
              {tab === 'traverse'  && <TraverseTab />}
              {tab === 'plat'      && (
                hasAccess(user, TABS.find(t=>t.id==='plat'))
                  ? <PlatTab />
                  : <TestingWall feature="Plat Extraction" icon="🛰" />
              )}
              {tab === 'writer'    && (
                hasAccess(user, TABS.find(t=>t.id==='writer'))
                  ? <WriterTab />
                  : <TestingWall feature="Legal Description Writer" icon="✍️" />
              )}
              {tab === 'batch'     && (
                hasAccess(user, TABS.find(t=>t.id==='batch'))
                  ? <BatchDeedTab />
                  : <TestingWall feature="Batch Deed Processing" icon="📦" />
              )}
              {tab === 'dashboard' && (
                hasAccess(user, TABS.find(t=>t.id==='dashboard'))
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
            </main>
          </TabErrorBoundary>
        </div>
      </div>

      {/* Help Modal — rendered outside the app-shell so it overlays everything */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
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

// ── Upgrade Wall (plan-gated features for users with role access) ──────────────
function UpgradeWall({ feature, plan, onUpgrade }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: '1rem', padding: '3rem', textAlign: 'center',
    }}>
      <div style={{ fontSize: '3rem' }}>🔒</div>
      <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#fff' }}>{feature}</div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', maxWidth: 380, lineHeight: 1.6 }}>
        This feature is available on the <strong style={{ color: '#50c878' }}>Pro plan</strong>.
        Upgrade to unlock unlimited deed solves, Batch Deed, Plat Extraction, and more.
      </div>
      <button
        className="btn btn-primary"
        onClick={onUpgrade}
        style={{ marginTop: '0.5rem', padding: '0.65rem 1.75rem', fontSize: '0.92rem' }}
      >
        ⭐ Upgrade to Pro — $29/mo
      </button>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Cancel anytime · No lock-in</div>
    </div>
  );
}
