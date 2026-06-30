import { useState, useEffect, useCallback } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { authFetch } from '../api';

// Matches the canonical PANEL_DEFS in SettingsTab.jsx and TABS in App.jsx.
// minRole: 'user' = toggleable by all users | 'admin' = admin-only / in testing
const PANEL_DEFS = [
  { id: 'traverse',  icon: '📐', label: 'Deed Reader',              desc: 'Core deed parsing, coordinate entry & closure analysis', minRole: 'user',  status: 'live'    },
  { id: 'plat',      icon: '🛰️', label: 'Plat Extraction',         desc: 'AI-powered OCR for boundary images and PDFs',           minRole: 'user',  status: 'testing' },
  { id: 'writer',    icon: '✍️', label: 'Legal Description Writer', desc: 'Generate professional registry legal text',              minRole: 'user',  status: 'testing' },
  { id: 'batch',     icon: '📦', label: 'Batch Deed',               desc: 'Folder scan & batch deed processing pipeline',           minRole: 'user',  status: 'testing' },
  { id: 'dashboard', icon: '📊', label: 'Dashboard',                desc: 'Processing statistics and deed review panel',           minRole: 'user',  status: 'testing' },
];

// ── Reusable toggle switch ──────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled }) {
  return (
    <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1 }}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      <div style={{
        width: '40px', height: '20px', borderRadius: '10px',
        background: checked ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)' : 'rgba(255,255,255,0.1)',
        border: `1px solid ${checked ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
        position: 'relative', transition: 'all 0.25s ease',
        boxShadow: checked ? '0 0 10px rgba(0, 212, 168, 0.3)' : 'none',
      }}>
        <div style={{
          width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
          position: 'absolute', top: '2px', left: checked ? '22px' : '3px',
          transition: 'left 0.25s ease',
        }} />
      </div>
    </label>
  );
}

// ── License Key section ───────────────────────────────────────────────────────
const PLAN_META = {
  free:       { label: 'Free',       color: '#8899bb', glow: 'rgba(136,153,187,0.3)', icon: '🔓' },
  basic:      { label: 'Basic',      color: '#00d4a8', glow: 'rgba(0,212,168,0.35)',  icon: '⭐' },
  pro:        { label: 'Pro',        color: '#3d7fff', glow: 'rgba(61,127,255,0.4)',  icon: '🚀' },
  enterprise: { label: 'Enterprise', color: '#a855f7', glow: 'rgba(168,85,247,0.4)', icon: '🏢' },
};

function LicenseKeySection({ currentPlan, onPlanChanged }) {
  const [keyInput, setKeyInput]   = useState('');
  const [loading, setLoading]     = useState(false);
  const [msg, setMsg]             = useState(null); // { text, ok }
  const [licenses, setLicenses]   = useState([]);
  const [loadingKeys, setLoadingKeys] = useState(true);

  const plan = currentPlan || 'free';
  const meta = PLAN_META[plan] || PLAN_META.free;

  useEffect(() => {
    authFetch('/auth/me/licenses')
      .then(d => setLicenses(d.licenses || []))
      .catch(() => {})
      .finally(() => setLoadingKeys(false));
  }, []);

  const handleActivate = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) { setMsg({ text: 'Please enter a license key.', ok: false }); return; }
    setLoading(true); setMsg(null);
    try {
      const data = await authFetch('/auth/me/redeem-license', {
        method: 'POST',
        body: JSON.stringify({ licenseKey: trimmed }),
      });
      setMsg({ text: data.message, ok: true });
      setKeyInput('');
      if (!data.alreadyOwner && onPlanChanged) onPlanChanged(data.plan);
      // Refresh applied keys list
      authFetch('/auth/me/licenses').then(d => setLicenses(d.licenses || [])).catch(() => {});
    } catch (e) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setLoading(false);
    }
  };

  const fmtDate = (s) => s ? new Date(s).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : null;

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(20,30,58,0.7) 0%, rgba(9,14,26,0.8) 100%)',
      border: `1px solid ${meta.color}40`,
      borderRadius: 'var(--radius-lg)',
      backdropFilter: 'blur(16px)',
      boxShadow: `0 0 32px ${meta.glow}, 0 8px 24px rgba(0,0,0,0.3)`,
      overflow: 'hidden',
    }}>
      {/* Header bar */}
      <div style={{
        background: `linear-gradient(135deg, ${meta.color}18 0%, transparent 100%)`,
        borderBottom: `1px solid ${meta.color}25`,
        padding: '1.25rem 1.5rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            width: 38, height: 38, borderRadius: 'var(--radius-md)',
            background: `linear-gradient(135deg, ${meta.color}30, ${meta.color}10)`,
            border: `1px solid ${meta.color}40`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.2rem',
            boxShadow: `0 0 12px ${meta.glow}`,
          }}>🪪</div>
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.01em' }}>
              License & Subscription
            </div>
            <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginTop: 1 }}>
              Enter your license key to activate or upgrade your plan
            </div>
          </div>
        </div>
        {/* Plan badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          background: `${meta.color}18`,
          border: `1px solid ${meta.color}45`,
          borderRadius: '2rem',
          padding: '0.3rem 0.85rem',
          boxShadow: `0 0 10px ${meta.glow}`,
        }}>
          <span style={{ fontSize: '0.85rem' }}>{meta.icon}</span>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: meta.color, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {meta.label}
          </span>
        </div>
      </div>

      {/* Key input area */}
      <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'stretch' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <input
              id="license-key-input"
              type="text"
              placeholder="BIQ-XXXX-XXXX-XXXX-XXXX"
              value={keyInput}
              onChange={e => { setKeyInput(e.target.value.toUpperCase()); setMsg(null); }}
              onKeyDown={e => e.key === 'Enter' && handleActivate()}
              spellCheck={false}
              autoComplete="off"
              style={{
                width: '100%',
                background: 'rgba(9,14,26,0.6)',
                border: `1px solid ${keyInput ? meta.color + '60' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '0.65rem 0.9rem',
                color: '#fff',
                fontFamily: 'monospace',
                fontSize: '0.9rem',
                letterSpacing: '0.08em',
                transition: 'border-color 0.2s, box-shadow 0.2s',
                boxShadow: keyInput ? `0 0 0 2px ${meta.color}20` : 'none',
                outline: 'none',
              }}
            />
          </div>
          <button
            id="license-activate-btn"
            className="btn btn-primary"
            onClick={handleActivate}
            disabled={loading || !keyInput.trim()}
            style={{
              padding: '0.65rem 1.4rem',
              fontWeight: 700,
              fontSize: '0.82rem',
              borderRadius: 'var(--radius-sm)',
              background: loading ? 'rgba(61,127,255,0.4)' : `linear-gradient(135deg, ${meta.color}, ${meta.color}cc)`,
              border: 'none',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              transition: 'opacity 0.2s',
              opacity: (!keyInput.trim() || loading) ? 0.55 : 1,
            }}
          >
            {loading ? '⏳ Activating…' : '🔐 Activate'}
          </button>
        </div>

        {/* Feedback message */}
        {msg && (
          <div style={{
            padding: '0.5rem 0.85rem',
            borderRadius: 6,
            fontSize: '0.78rem',
            fontWeight: 600,
            background: msg.ok ? 'rgba(0,212,168,0.08)' : 'rgba(220,50,50,0.1)',
            border: `1px solid ${msg.ok ? 'rgba(0,212,168,0.3)' : 'rgba(220,50,50,0.3)'}`,
            color: msg.ok ? '#00d4a8' : '#e05555',
            display: 'flex', alignItems: 'center', gap: '0.4rem',
          }}>
            <span>{msg.ok ? '✓' : '✗'}</span>
            <span>{msg.text}</span>
          </div>
        )}

        {/* Applied keys history */}
        {!loadingKeys && licenses.length > 0 && (
          <div style={{ marginTop: '0.25rem' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
              Applied Keys
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {licenses.map((lic, i) => {
                const lMeta = PLAN_META[lic.Plan] || PLAN_META.free;
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: '0.6rem',
                    background: 'rgba(9,14,26,0.4)',
                    border: `1px solid ${lMeta.color}25`,
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.45rem 0.75rem',
                  }}>
                    <span style={{ fontSize: '0.85rem' }}>{lMeta.icon}</span>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 700, color: lMeta.color }}>
                        {lMeta.label} Plan
                      </span>
                      {lic.Note && <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{lic.Note}</span>}
                    </div>
                    {fmtDate(lic.RedeemedAt) && (
                      <span style={{ fontSize: '0.67rem', color: 'var(--text-muted)' }}>Activated {fmtDate(lic.RedeemedAt)}</span>
                    )}
                    {lic.ExpiresAt && (
                      <span style={{ fontSize: '0.67rem', color: '#ffaa00' }}>Expires {fmtDate(lic.ExpiresAt)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <span>💡</span>
          <span>License keys are single-use and tied to your account. Contact support if you need a new key.</span>
        </div>
      </div>
    </div>
  );
}

// ── My Account section ────────────────────────────────────────────────────────
function MyAccountSection() {
  const [displayName, setDisplayName] = useState('');
  const [profileMsg, setProfileMsg] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);

  const [curPw, setCurPw]   = useState('');
  const [newPw, setNewPw]   = useState('');
  const [confPw, setConfPw] = useState('');
  const [pwMsg, setPwMsg]   = useState('');
  const [pwLoading, setPwLoading] = useState(false);

  const [sessions, setSessions] = useState([]);
  const [sessLoading, setSessLoading] = useState(false);
  const [sessMsg, setSessMsg] = useState('');

  const fmtTime = (s) => s ? new Date(s).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : 'Unknown';

  const fetchSessions = useCallback(async () => {
    setSessLoading(true);
    try {
      const d = await authFetch('/auth/me/sessions');
      setSessions(d.sessions || []);
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    }
    finally { setSessLoading(false); }
  }, []);

  useEffect(() => { fetchSessions(); }, []);

  const saveProfile = async () => {
    setProfileLoading(true); setProfileMsg('');
    try {
      await authFetch('/auth/me/profile', { method:'PUT', body:JSON.stringify({displayName}) });
      setProfileMsg('✓ Display name updated.');
    } catch (e) { setProfileMsg(`✗ ${e.message}`); }
    finally { setProfileLoading(false); }
  };

  const changePassword = async () => {
    setPwMsg(''); if (!curPw || !newPw) return setPwMsg('✗ All fields required.');
    if (newPw.length < 6) return setPwMsg('✗ Password must be ≥ 6 characters.');
    if (newPw !== confPw) return setPwMsg('✗ New passwords do not match.');
    setPwLoading(true);
    try {
      await authFetch('/auth/me/password', { method:'PUT', body:JSON.stringify({currentPassword:curPw, newPassword:newPw}) });
      setPwMsg('✓ Password changed.');
      setCurPw(''); setNewPw(''); setConfPw(''); fetchSessions();
    } catch (e) { setPwMsg(`✗ ${e.message}`); }
    finally { setPwLoading(false); }
  };

  const revokeOtherSessions = async () => {
    setSessMsg('');
    try {
      const d = await authFetch('/auth/me/sessions', { method:'DELETE' });
      setSessMsg(`✓ Revoked ${d.revoked} session(s).`);
      fetchSessions();
    } catch (e) { setSessMsg(`✗ ${e.message}`); }
  };

  const revokeSession = async (fullToken) => {
    try {
      await authFetch(`/auth/me/sessions/${fullToken}`, { method:'DELETE' });
      fetchSessions();
    } catch (e) {
      console.error('Failed to revoke session:', e);
    }
  };

  const msgStyle = (m) => ({
    padding:'0.4rem 0.7rem', borderRadius:6, fontSize:'0.75rem',
    background: m.startsWith('✓') ? 'rgba(0,212,168,.08)' : 'rgba(220,50,50,.1)',
    border:`1px solid ${m.startsWith('✓') ? 'rgba(0,212,168,.25)' : 'rgba(220,50,50,.25)'}`,
    color: m.startsWith('✓') ? 'var(--success)' : '#dc3232',
  });

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1rem' }}>
      {/* Display name */}
      <div className="card" style={{ background:'rgba(9,14,26,.4)', backdropFilter:'blur(8px)', border:'1px solid var(--border)' }}>
        <div className="card-header" style={{ borderBottom:'1px solid var(--border)', paddingBottom:'0.9rem' }}>
          <div className="card-title" style={{ fontSize:'1.05rem', fontWeight:700, color:'#fff', display:'flex', alignItems:'center', gap:'0.5rem' }}>👤 Profile</div>
        </div>
        <div style={{ padding:'1.25rem', display:'flex', flexDirection:'column', gap:'0.85rem' }}>
          <div style={{ display:'flex', gap:'0.75rem', alignItems:'flex-end' }}>
            <div style={{ flex:1, display:'flex', flexDirection:'column', gap:'0.35rem' }}>
              <label style={{ fontSize:'0.78rem', color:'var(--text-secondary)', fontWeight:600 }}>Display Name</label>
              <input type="text" placeholder="Your full name or nickname" value={displayName} onChange={e=>{setDisplayName(e.target.value);setProfileMsg('');}}
                style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', padding:'0.55rem 0.85rem', color:'var(--text-primary)', fontSize:'0.82rem' }} />
            </div>
            <button className="btn btn-primary" onClick={saveProfile} disabled={profileLoading} style={{ padding:'0.55rem 1.25rem', fontSize:'0.78rem', borderRadius:'var(--radius-sm)', whiteSpace:'nowrap' }}>
              {profileLoading ? '⏳' : '💾 Save'}
            </button>
          </div>
          {profileMsg && <div style={msgStyle(profileMsg)}>{profileMsg}</div>}
        </div>
      </div>

      {/* Change password */}
      <div className="card" style={{ background:'rgba(9,14,26,.4)', backdropFilter:'blur(8px)', border:'1px solid rgba(255,170,0,.2)' }}>
        <div className="card-header" style={{ borderBottom:'1px solid var(--border)', paddingBottom:'0.9rem' }}>
          <div className="card-title" style={{ fontSize:'1.05rem', fontWeight:700, color:'#fff', display:'flex', alignItems:'center', gap:'0.5rem' }}>🔑 Change Password</div>
        </div>
        <div style={{ padding:'1.25rem', display:'flex', flexDirection:'column', gap:'0.75rem' }}>
          {[['Current Password', curPw, setCurPw], ['New Password (≥ 6 chars)', newPw, setNewPw], ['Confirm New Password', confPw, setConfPw]].map(([label, val, set]) => (
            <div key={label} style={{ display:'flex', flexDirection:'column', gap:'0.3rem' }}>
              <label style={{ fontSize:'0.75rem', color:'var(--text-secondary)', fontWeight:600 }}>{label}</label>
              <input type="password" placeholder="••••••••" value={val} onChange={e=>{set(e.target.value);setPwMsg('');}}
                style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', padding:'0.55rem 0.85rem', color:'var(--text-primary)', fontSize:'0.82rem' }} />
            </div>
          ))}
          <button className="btn btn-primary" onClick={changePassword} disabled={pwLoading} style={{ padding:'0.55rem 1.25rem', fontSize:'0.78rem', borderRadius:'var(--radius-sm)', width:'fit-content' }}>
            {pwLoading ? '⏳ Updating…' : '🔑 Update Password'}
          </button>
          {pwMsg && <div style={msgStyle(pwMsg)}>{pwMsg}</div>}
        </div>
      </div>

      {/* Active sessions */}
      <div className="card" style={{ background:'rgba(9,14,26,.4)', backdropFilter:'blur(8px)', border:'1px solid var(--border)' }}>
        <div className="card-header" style={{ borderBottom:'1px solid var(--border)', paddingBottom:'0.9rem', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div className="card-title" style={{ fontSize:'1.05rem', fontWeight:700, color:'#fff', display:'flex', alignItems:'center', gap:'0.5rem' }}>🔗 Active Sessions</div>
          <div style={{ display:'flex', gap:'0.5rem' }}>
            <button className="btn btn-ghost btn-sm" onClick={fetchSessions} style={{ fontSize:'0.72rem' }}>↻ Refresh</button>
            <button className="btn btn-ghost btn-sm" onClick={revokeOtherSessions} style={{ fontSize:'0.72rem', color:'#ff7070' }}>🚫 Revoke Others</button>
          </div>
        </div>
        <div style={{ padding:'1.25rem', display:'flex', flexDirection:'column', gap:'0.6rem' }}>
          {sessLoading ? <div style={{ color:'var(--text-muted)', fontSize:'0.8rem' }}>Loading…</div>
          : sessions.length === 0 ? <div style={{ color:'var(--text-muted)', fontSize:'0.8rem' }}>No sessions found</div>
          : sessions.map((s, i) => (
            <div key={s.tokenPrefix} style={{ display:'flex', alignItems:'center', gap:'0.75rem', padding:'0.65rem 0.9rem', background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)' }}>
              <div style={{ width:8, height:8, borderRadius:'50%', flexShrink:0, background:'#50c878', boxShadow:'0 0 6px #50c878' }} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:'0.78rem', fontWeight:600, color:'var(--text-primary)' }}>{s.userAgent ? s.userAgent.substring(0,60)+'…' : 'Unknown device'}</div>
                <div style={{ fontSize:'0.68rem', color:'var(--text-muted)' }}>
                  {s.ipAddress || 'unknown IP'} · Since {fmtTime(s.createdAt)} · Expires {fmtTime(s.expiresAt)}
                </div>
              </div>
              <span style={{ fontSize:'0.65rem', color:'var(--text-muted)', fontFamily:'monospace' }}>{s.token}</span>
              {i !== 0 && <button className="btn btn-ghost" style={{ fontSize:'0.65rem', padding:'2px 7px', color:'#ff7070', flexShrink:0 }} onClick={()=>revokeSession(s.fullToken)}>Revoke</button>}
              {i === 0 && <span style={{ fontSize:'0.65rem', color:'#50c878', flexShrink:0 }}>Current</span>}
            </div>
          ))}
          {sessMsg && <div style={msgStyle(sessMsg)}>{sessMsg}</div>}
        </div>
      </div>
    </div>
  );
}

const SectionDivider = ({ label }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.25rem 0' }}>
    <div style={{ height: '1px', flex: 1, background: 'var(--border)' }} />
    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>{label}</span>
    <div style={{ height: '1px', flex: 1, background: 'var(--border)' }} />
  </div>
);

export default function UserSettingsTab({
  user,
  hideTraverse: propHideTraverse, setHideTraverse: propSetHideTraverse,
  hidePlat: propHidePlat,         setHidePlat: propSetHidePlat,
  hideWriter: propHideWriter,     setHideWriter: propSetHideWriter,
}) {
    // Local fallbacks
  const [localHideTraverse, localSetHideTraverse] = useLocalStorage('boundaryiq_hide_traverse', false);
  const [localHidePlat,     localSetHidePlat]     = useLocalStorage('boundaryiq_hide_plat', false);
  const [localHideWriter,   localSetHideWriter]   = useLocalStorage('boundaryiq_hide_writer', false);

  const hideTraverse   = propHideTraverse   !== undefined ? propHideTraverse   : localHideTraverse;
  const setHideTraverse = propSetHideTraverse || localSetHideTraverse;
  const hidePlat        = propHidePlat       !== undefined ? propHidePlat       : localHidePlat;
  const setHidePlat     = propSetHidePlat    || localSetHidePlat;
  const hideWriter      = propHideWriter     !== undefined ? propHideWriter     : localHideWriter;
  const setHideWriter   = propSetHideWriter  || localSetHideWriter;

  // Panel policy set by admin
  const [panelPolicy] = useLocalStorage('boundaryiq_panel_policy', {});

  const [concurrentAgents, setConcurrentAgents] = useLocalStorage('boundaryiq_concurrent_agents', 5);
  const [parallelBatches,  setParallelBatches]  = useLocalStorage('boundaryiq_parallel_batches', 1);
  const [maxFileSize,      setMaxFileSize]       = useLocalStorage('boundaryiq_max_file_size', 51);
  const [autoOutput,       setAutoOutput]        = useLocalStorage('boundaryiq_auto_output', true);
  const [shortFileNames,   setShortFileNames]    = useLocalStorage('boundaryiq_short_file_names', true);
  const [showConceptualDetail, setShowConceptualDetail] = useLocalStorage('boundaryiq_show_conceptual_detail', true);
  const [frontendOcr, setFrontendOcr]           = useLocalStorage('boundaryiq_frontend_ocr', false);
  const [openaiBaseUrl]                         = useLocalStorage('boundaryiq_openai_base_url', 'http://127.0.0.1:11434/v1');
  const [geminiKey,        setGeminiKey]          = useLocalStorage('boundaryiq_gemini_key', '');
  const [openaiKey,        setOpenaiKey]          = useLocalStorage('boundaryiq_openai_key', '');

  const [modelConfig,      setModelConfig]        = useState(null);
  const [modelLoading,     setModelLoading]       = useState(true);
  const [modelMsg,         setModelMsg]           = useState('');
  const [startingOllama,   setStartingOllama]     = useState(false);
  const [saveKeysLoading,  setSaveKeysLoading]    = useState(false);
  const [keysMsg,          setKeysMsg]            = useState('');
  const [selectedVendor,   setSelectedVendor]     = useState('gemini');
  const [selectedModel,    setSelectedModel]      = useState('gemini-2.5-flash');
  const [allowApiFallback, setAllowApiFallback]   = useState(true);
  const [enforceNoSelfIntersection, setEnforceNoSelfIntersection] = useState(false);
  const [mapPanSensitivity, setMapPanSensitivity] = useState(0.55);
  const [switchingTo,      setSwitchingTo]        = useState(null);

  const providerMeta = {
    gemini: { color: '#4285F4', icon: '☁️', gradient: 'linear-gradient(135deg, #4285F4 0%, #8AB4F8 100%)', label: 'Cloud' },
    ollama: { color: '#00d4a8', icon: '🖥️', gradient: 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)', label: 'Local' },
    openai: { color: '#a855f7', icon: '🔌', gradient: 'linear-gradient(135deg, #a855f7 0%, #7c3aed 100%)', label: 'Compat' },
  };

  const fetchModelConfig = useCallback(async () => {
    setModelLoading(true);
    try {
      const data = await authFetch('/settings/model');
      setModelConfig(data);
    } catch (e) {
      console.error('Failed to fetch model config:', e);
    } finally {
      setModelLoading(false);
    }
  }, []);

  useEffect(() => {
    if (modelConfig) {
      setSelectedVendor(modelConfig.activeProvider || 'gemini');
      setSelectedModel(modelConfig.activeModel || 'gemini-2.5-flash');
      if (modelConfig.allowApiFallback !== undefined) setAllowApiFallback(modelConfig.allowApiFallback);
      if (modelConfig.enforceNoSelfIntersection !== undefined) setEnforceNoSelfIntersection(modelConfig.enforceNoSelfIntersection);
      if (modelConfig.mapPanSensitivity !== undefined) setMapPanSensitivity(modelConfig.mapPanSensitivity);
    }
  }, [modelConfig]);

  useEffect(() => { fetchModelConfig(); }, [fetchModelConfig]);

  const saveKeysToBackend = async (gKey, oKey, silent = false) => {
    if (!silent) setSaveKeysLoading(true);
    try {
      await authFetch('/settings/keys', {
        method: 'POST',
        body: JSON.stringify({ geminiApiKey: gKey, openAiApiKey: oKey }),
      });
      if (!silent) setKeysMsg('✓ API keys saved.');
      fetchModelConfig();
    } catch (e) {
      if (!silent) setKeysMsg(`✗ ${e.message}`);
    } finally {
      if (!silent) setSaveKeysLoading(false);
    }
  };

  useEffect(() => {
    if (geminiKey || openaiKey) saveKeysToBackend(geminiKey, openaiKey, true);
  }, []);

  const switchModel = async (provider, model) => {
    setSwitchingTo(`${provider}/${model}`); setModelLoading(true); setModelMsg('');
    try {
      const body = { provider, model, allowApiFallback, enforceNoSelfIntersection, mapPanSensitivity };
      if (provider === 'openai') body.openaiBaseUrl = openaiBaseUrl;
      const data = await authFetch('/settings/model', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setModelMsg(`✓ ${data.message}`);
      fetchModelConfig();
    } catch (e) {
      setModelMsg(`✗ ${e.message}`);
    } finally {
      setModelLoading(false); setSwitchingTo(null);
    }
  };

  const toggleApiFallback = async (val) => {
    setAllowApiFallback(val);
    if (!modelConfig) return;
    const body = { provider: modelConfig.activeProvider, model: modelConfig.activeModel, allowApiFallback: val, enforceNoSelfIntersection, mapPanSensitivity };
    if (modelConfig.activeProvider === 'openai') body.openaiBaseUrl = openaiBaseUrl;
    try {
      await authFetch('/settings/model', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      console.error('Failed to toggle API fallback:', e);
    }
    fetchModelConfig();
  };

  const updateMapPanSensitivity = async (val) => {
    setMapPanSensitivity(val);
    if (!modelConfig) return;
    const body = {
      provider: modelConfig.activeProvider,
      model: modelConfig.activeModel,
      allowApiFallback,
      enforceNoSelfIntersection,
      mapPanSensitivity: val
    };
    if (modelConfig.activeProvider === 'openai') body.openaiBaseUrl = openaiBaseUrl;
    try {
      await authFetch('/settings/model', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      console.error('Failed to update map pan sensitivity:', e);
    }
    fetchModelConfig();
  };

  const startOllama = async () => {
    setStartingOllama(true); setModelMsg('⏳ Starting Ollama…');
    try {
      const data = await authFetch('/settings/ollama/start', { method: 'POST' });
      if (data.started) {
        setModelMsg(`✓ ${data.message}`);
        fetchModelConfig();
      } else {
        setModelMsg('⏳ Waiting for Ollama to initialize…');
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          try {
            const s = await authFetch('/settings/ollama/status');
            if (s.online) {
              clearInterval(poll);
              setModelMsg(`✓ Ollama online — ${s.models?.length || 0} model(s).`);
              setStartingOllama(false);
              fetchModelConfig();
            } else if (attempts >= 8) {
              clearInterval(poll);
              setModelMsg("✗ Ollama did not start. Try running 'ollama serve'.");
              setStartingOllama(false);
            }
          } catch {
            if (attempts >= 8) {
              clearInterval(poll);
              setModelMsg("✗ Ollama did not start. Try running 'ollama serve'.");
              setStartingOllama(false);
            }
          }
        }, 2000);
        return;
      }
    } catch (e) {
      setModelMsg(`✗ ${e.message}`);
    }
    setStartingOllama(false);
  };

  // Sidebar toggles: check if panel is locked by admin policy
  const isLocked = (panelId) => {
    const policy = panelPolicy || {};
    // If policy key exists and is false → locked off
    return policy[panelId] === false;
  };

  const panelHideMap = { traverse: hideTraverse, plat: hidePlat, writer: hideWriter };
  const panelSetMap  = { traverse: setHideTraverse, plat: setHidePlat, writer: setHideWriter };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* ── License Key ─────────────────────────────────────────────── */}
      <LicenseKeySection
        currentPlan={user?.plan || 'free'}
        onPlanChanged={() => setTimeout(() => window.location.reload(), 1200)}
      />

      {/* ── My Account ──────────────────────────────────────────────── */}
      <MyAccountSection />

      {/* ── Title ─────────────────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(31,46,77,0.4) 0%, rgba(9,14,26,0.6) 100%)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        padding: '2rem', backdropFilter: 'blur(12px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
          <div style={{
            background: 'linear-gradient(135deg, #3d7fff 0%, #00d4a8 100%)',
            width: '42px', height: '42px', borderRadius: 'var(--radius-md)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.5rem', boxShadow: '0 0 16px rgba(61,127,255,0.4)', color: '#fff',
          }}>👤</div>
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, letterSpacing: '-0.02em', background: 'linear-gradient(to right, #ffffff, #8899bb)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              My Preferences
            </h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Personal workspace settings — saved to your browser profile.
            </p>
          </div>
        </div>
      </div>

      {/* ── AI Model Provider ─────────────────────────────────────── */}
      <div className="card" style={{ background: 'rgba(9,14,26,0.4)', backdropFilter: 'blur(8px)', border: '1px solid rgba(66,133,244,0.3)', boxShadow: '0 4px 24px rgba(66,133,244,0.1)' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              🧠 AI Model Provider
            </div>
            <button className="btn btn-ghost btn-sm" onClick={fetchModelConfig} style={{ fontSize: '0.72rem' }}>↻ Refresh</button>
          </div>
        </div>

        {(modelLoading || startingOllama) && <div className="progress-bar-container"><div className="progress-bar-fill" /></div>}

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* Active Model Badge */}
          {modelConfig && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{
                background: providerMeta[modelConfig.activeProvider]?.gradient || 'var(--bg-elevated)',
                padding: '0.5rem 1.2rem', borderRadius: '99px',
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                boxShadow: `0 0 20px ${providerMeta[modelConfig.activeProvider]?.color || '#fff'}33`,
              }}>
                <span style={{ fontSize: '1rem' }}>{providerMeta[modelConfig.activeProvider]?.icon}</span>
                <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.85rem' }}>{modelConfig.activeModel}</span>
              </div>
              <span style={{ fontSize: '0.72rem', color: providerMeta[modelConfig.activeProvider]?.color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {providerMeta[modelConfig.activeProvider]?.label} · Active
              </span>
            </div>
          )}

          {/* Ollama status */}
          {modelConfig && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '0.6rem 1rem',
              background: modelConfig.ollama.online ? 'rgba(0,212,168,0.06)' : 'rgba(220,50,50,0.06)',
              border: `1px solid ${modelConfig.ollama.online ? 'rgba(0,212,168,0.25)' : 'rgba(220,50,50,0.25)'}`,
              borderRadius: 'var(--radius-md)', fontSize: '0.78rem', flexWrap: 'wrap',
            }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: modelConfig.ollama.online ? '#00d4a8' : '#dc3232', boxShadow: modelConfig.ollama.online ? '0 0 8px #00d4a8' : '0 0 8px #dc3232', animation: modelConfig.ollama.online ? 'pulse 2s infinite' : 'none' }} />
              <span style={{ color: modelConfig.ollama.online ? 'var(--success)' : '#dc3232', fontWeight: 600 }}>
                Ollama {modelConfig.ollama.online ? 'Online' : 'Offline'}
              </span>
              {modelConfig.ollama.online && <span style={{ color: 'var(--text-muted)' }}>· {modelConfig.ollama.modelCount} model(s) · {modelConfig.ollama.url}</span>}
              {!modelConfig.ollama.online && (
                <button onClick={startOllama} disabled={startingOllama} style={{
                  marginLeft: 'auto', padding: '0.3rem 0.85rem',
                  background: startingOllama ? 'rgba(0,212,168,0.08)' : 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)',
                  border: '1px solid rgba(0,212,168,0.5)', borderRadius: '99px', color: '#fff',
                  fontWeight: 700, fontSize: '0.72rem', cursor: startingOllama ? 'wait' : 'pointer',
                  boxShadow: startingOllama ? 'none' : '0 0 12px rgba(0,212,168,0.3)',
                }}>
                  {startingOllama ? '⏳ Starting…' : '▶ Start Ollama'}
                </button>
              )}
            </div>
          )}

          {/* API Keys */}
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              🔑 API Keys &amp; Credentials
            </div>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '220px' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Google Gemini API Key</label>
                <input type="password" placeholder="AIza…" value={geminiKey}
                  onChange={e => { setGeminiKey(e.target.value); setKeysMsg(''); }}
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.55rem 0.85rem', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.8rem' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '220px' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>OpenAI / Compatible API Key (optional)</label>
                <input type="password" placeholder="sk-…" value={openaiKey}
                  onChange={e => { setOpenaiKey(e.target.value); setKeysMsg(''); }}
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.55rem 0.85rem', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.8rem' }} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>🔒 Saved securely in your browser and auto-loaded to server on startup.</span>
              <button onClick={() => saveKeysToBackend(geminiKey, openaiKey)} disabled={saveKeysLoading} className="btn btn-primary" style={{ padding: '0.55rem 1.25rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sm)' }}>
                {saveKeysLoading ? '⏳ Saving…' : '💾 Save API Keys'}
              </button>
            </div>
            {keysMsg && (
              <div style={{ padding: '0.45rem 0.75rem', borderRadius: 'var(--radius-sm)', background: keysMsg.startsWith('✓') ? 'rgba(0,212,168,0.08)' : 'rgba(220,50,50,0.1)', border: `1px solid ${keysMsg.startsWith('✓') ? 'rgba(0,212,168,0.25)' : 'rgba(220,50,50,0.25)'}`, color: keysMsg.startsWith('✓') ? 'var(--success)' : '#dc3232', fontSize: '0.75rem', fontWeight: 500 }}>
                {keysMsg}
              </div>
            )}
          </div>

          {/* Vendor / Model Selector */}
          {modelConfig && (
            <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
                🤖 Vendor &amp; Model Selector
              </div>
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '180px' }}>
                  <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Select Vendor</label>
                  <select value={selectedVendor} onChange={e => { const v = e.target.value; setSelectedVendor(v); setSelectedModel(modelConfig?.availableModels.find(m => m.provider === v)?.id || ''); }}
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.55rem 0.85rem', color: 'var(--text-primary)', fontSize: '0.8rem', cursor: 'pointer', height: '38px' }}>
                    <option value="gemini">☁️ Google Gemini (Cloud)</option>
                    <option value="ollama">🖥️ Ollama (Local)</option>
                    <option value="openai">🔌 OpenAI-Compatible</option>
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1.5, minWidth: '200px' }}>
                  <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Select Model</label>
                  <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)}
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.55rem 0.85rem', color: 'var(--text-primary)', fontSize: '0.8rem', fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer', height: '38px' }}>
                    {modelConfig?.availableModels.filter(m => m.provider === selectedVendor).map(m => (
                      <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
                    ))}
                    {selectedVendor === 'openai' && modelConfig?.availableModels.filter(m => m.provider === 'openai').length === 0 && (
                      <option value="llama3">Default Llama 3 (compat)</option>
                    )}
                  </select>
                </div>
                <button className="btn btn-primary"
                  disabled={modelLoading || !selectedModel || (modelConfig?.activeProvider === selectedVendor && modelConfig?.activeModel === selectedModel)}
                  onClick={() => selectedVendor === 'ollama' && !modelConfig?.ollama?.online ? startOllama() : switchModel(selectedVendor, selectedModel)}
                  style={{ height: '38px', padding: '0 1.5rem', background: providerMeta[selectedVendor]?.gradient || 'var(--accent)', borderColor: 'transparent', borderRadius: 'var(--radius-sm)', fontWeight: 700, fontSize: '0.78rem' }}>
                  {switchingTo ? '⏳ Switching…' : '✓ Switch AI Driver'}
                </button>
              </div>

              {/* API Fallback toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.2rem', background: allowApiFallback ? 'rgba(0,212,168,0.03)' : 'rgba(255,255,255,0.01)', border: `1px solid ${allowApiFallback ? 'rgba(0,212,168,0.25)' : 'var(--border)'}`, borderRadius: 'var(--radius-md)', transition: 'all 0.3s ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ fontSize: '1.2rem' }}>🔄</span>
                  <div>
                    <div style={{ fontWeight: 600, color: allowApiFallback ? '#e8eeff' : 'var(--text-muted)', fontSize: '0.85rem' }}>Smart API Fallback to Local Ollama</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>Automatically fall back from Gemini to local Ollama on quota failures</div>
                  </div>
                </div>
                <Toggle checked={allowApiFallback} onChange={e => toggleApiFallback(e.target.checked)} />
              </div>
            </div>
          )}

          {modelMsg && (
            <div style={{ padding: '0.5rem 0.85rem', borderRadius: 'var(--radius-sm)', background: modelMsg.startsWith('✓') ? 'rgba(0,212,168,0.08)' : 'rgba(220,50,50,0.1)', border: `1px solid ${modelMsg.startsWith('✓') ? 'rgba(0,212,168,0.3)' : 'rgba(220,50,50,0.3)'}`, color: modelMsg.startsWith('✓') ? 'var(--success)' : '#dc3232', fontSize: '0.78rem', fontWeight: 500 }}>
              {modelMsg}
            </div>
          )}
        </div>
      </div>

      {/* ── Agent Processing ──────────────────────────────────────── */}
      <div className="card" style={{ background: 'rgba(9,14,26,0.4)', backdropFilter: 'blur(8px)', border: '1px solid var(--border)', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            🤖 Agent Processing Configuration
          </div>
        </div>
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* Concurrent Agents */}
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="form-label" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>Concurrent Agents</label>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', background: 'rgba(0,212,168,0.1)', border: '1px solid rgba(0,212,168,0.3)', color: 'var(--success)', padding: '0.2rem 0.6rem', borderRadius: '99px', fontSize: '0.8rem', fontWeight: 600 }}>
                {concurrentAgents} {concurrentAgents === 1 ? 'Agent' : 'Agents'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <input type="range" min="1" max="20" value={concurrentAgents} onChange={e => setConcurrentAgents(parseInt(e.target.value))} style={{ flex: 1, accentColor: 'var(--success)', height: '6px', borderRadius: '3px', cursor: 'pointer' }} />
              <input type="number" min="1" max="20" value={concurrentAgents} onChange={e => { let v = parseInt(e.target.value); if (isNaN(v)) v = 5; setConcurrentAgents(Math.min(20, Math.max(1, v))); }} style={{ width: '70px', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem', padding: '0.4rem' }} />
            </div>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Maximum number of concurrent vision & geometry agents. Higher values speed up batch processing but may hit API rate limits.
            </p>
          </div>

          <SectionDivider label="Turbo Mode" />

          {/* Parallel Batches */}
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="form-label" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>Parallel Batch Streams</label>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', background: parallelBatches > 1 ? 'rgba(255,170,0,0.12)' : 'rgba(0,212,168,0.1)', border: `1px solid ${parallelBatches > 1 ? 'rgba(255,170,0,0.4)' : 'rgba(0,212,168,0.3)'}`, color: parallelBatches > 1 ? '#c97a00' : 'var(--success)', padding: '0.2rem 0.6rem', borderRadius: '99px', fontSize: '0.8rem', fontWeight: 600 }}>
                {parallelBatches === 1 ? '1 Stream (Safe)' : `${parallelBatches} Streams ⚡`}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <input type="range" min="1" max="8" value={parallelBatches} onChange={e => setParallelBatches(parseInt(e.target.value))} style={{ flex: 1, accentColor: '#c97a00', height: '6px', borderRadius: '3px', cursor: 'pointer' }} />
              <input type="number" min="1" max="8" value={parallelBatches} onChange={e => { let v = parseInt(e.target.value); if (isNaN(v)) v = 1; setParallelBatches(Math.min(8, Math.max(1, v))); }} style={{ width: '70px', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem', padding: '0.4rem' }} />
            </div>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Combined throughput: <strong style={{ color: '#c97a00' }}>{parallelBatches} × {concurrentAgents} = {parallelBatches * concurrentAgents}</strong> simultaneous requests. Paid API tier recommended above 1 stream.
            </p>
          </div>
        </div>
      </div>

      {/* ── File Size ─────────────────────────────────────────────── */}
      <div className="card" style={{ background: 'rgba(9,14,26,0.4)', backdropFilter: 'blur(8px)', border: '1px solid var(--border)', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>📁 File Size &amp; Upload Limit</div>
        </div>
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="form-label" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>Max Upload &amp; Scan File Size</label>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', background: 'rgba(61,127,255,0.1)', border: '1px solid rgba(61,127,255,0.3)', color: 'var(--accent)', padding: '0.2rem 0.6rem', borderRadius: '99px', fontSize: '0.8rem', fontWeight: 600 }}>{maxFileSize} MB</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <input type="range" min="5" max="100" value={maxFileSize} onChange={e => setMaxFileSize(parseInt(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent)', height: '6px', borderRadius: '3px', cursor: 'pointer' }} />
            <input type="number" min="5" max="100" value={maxFileSize} onChange={e => { let v = parseInt(e.target.value); if (isNaN(v)) v = 51; setMaxFileSize(Math.min(100, Math.max(5, v))); }} style={{ width: '70px', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem', padding: '0.4rem' }} />
          </div>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>Files exceeding this size are filtered out during folder scans to optimize memory usage.</p>
        </div>
      </div>

      {/* ── Output Configuration ───────────────────────────────────── */}
      <div className="card" style={{ background: 'rgba(9,14,26,0.4)', backdropFilter: 'blur(8px)', border: `1px solid ${autoOutput ? 'rgba(0,212,168,0.35)' : 'var(--border)'}`, boxShadow: autoOutput ? '0 4px 24px rgba(0,212,168,0.08)' : '0 4px 24px rgba(0,0,0,0.15)', transition: 'border-color 0.3s, box-shadow 0.3s' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>📤 Output File Configuration</div>
        </div>
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {[
            { checked: autoOutput,           set: setAutoOutput,           label: 'Auto-Generate Output Files',    desc: 'Automatically create a timestamped output subfolder for each batch run inside the source directory.' },
            { checked: shortFileNames,        set: setShortFileNames,        label: 'Use Short File Names',          desc: 'Save outputs with standardized names (Map, OCR, Summary, Cogo, Script, DXF) inside a per-deed folder.' },
            { checked: showConceptualDetail,  set: setShowConceptualDetail,  label: 'Add Conceptual Details to Maps', desc: 'Overlay neighboring lots, street name, utility easements, and inline course dimensions on check plots.' },
            { checked: frontendOcr,           set: setFrontendOcr,           label: 'Perform OCR on Frontend',       desc: 'Run OCR directly in the browser (images/PDFs) before uploading. Only plain text is uploaded, reducing server load.' },
          ].map(({ checked, set, label, desc }, i) => (
            <div key={i}>
              {i > 0 && <div style={{ height: '1px', background: 'var(--border)', margin: '0.25rem 0 1rem 0' }} />}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
                <div style={{ flexShrink: 0, marginTop: '2px' }}><Toggle checked={checked} onChange={e => set(e.target.checked)} /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem', marginBottom: '0.35rem' }}>{label}</div>
                  <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>{desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Interactive Map Settings ─────────────────────────────────── */}
      <div className="card" style={{ background: 'rgba(9,14,26,0.4)', backdropFilter: 'blur(8px)', border: '1px solid var(--border)', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            🗺️ Interactive Map Configuration
          </div>
        </div>
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="form-label" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>Map Pan Sensitivity</label>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', background: 'rgba(0,212,168,0.1)', border: '1px solid rgba(0,212,168,0.3)', color: 'var(--success)', padding: '0.2rem 0.6rem', borderRadius: '99px', fontSize: '0.8rem', fontWeight: 600 }}>
                {mapPanSensitivity.toFixed(2)}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <input type="range" min="0.1" max="2.0" step="0.05" value={mapPanSensitivity} onChange={e => updateMapPanSensitivity(parseFloat(e.target.value))} style={{ flex: 1, accentColor: 'var(--success)', height: '6px', borderRadius: '3px', cursor: 'pointer' }} />
              <input type="number" min="0.1" max="2.0" step="0.05" value={mapPanSensitivity} onChange={e => { let v = parseFloat(e.target.value); if (isNaN(v)) v = 0.55; updateMapPanSensitivity(Math.min(2.0, Math.max(0.1, v))); }} style={{ width: '70px', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--border)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem', padding: '0.4rem' }} />
            </div>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Adjust pan sensitivity multiplier when dragging the survey check plot map. Default is 0.55.
            </p>
          </div>
        </div>
      </div>

      {/* ── Sidebar Customization ─────────────────────────────────── */}
      <div className="card" style={{ background: 'rgba(9,14,26,0.4)', backdropFilter: 'blur(8px)', border: '1px solid var(--border)', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            🖥️ Sidebar Navigation Customization
          </div>
        </div>
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Toggle visibility of specific tools in the sidebar. Tabs marked with 🔒 have been restricted by your administrator.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {PANEL_DEFS.map(panel => {
              const isAdminOnly = panel.minRole === 'admin';
              const locked = isLocked(panel.id) || isAdminOnly;
              const hideState = panelHideMap[panel.id];
              const isVisible = hideState !== undefined ? !hideState : true;
              // Only traverse is user-toggleable now; others are admin-only (testing)
              const isUserToggleable = panel.id === 'traverse' && !locked;
              const panelColors = { traverse: '#3d7fff', plat: '#00d4a8', writer: '#a855f7', batch: '#c97a00', dashboard: '#4285F4' };
              const color = panelColors[panel.id] || 'var(--accent)';

              return (
                <div key={panel.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.85rem 1.2rem',
                  background: isAdminOnly ? 'rgba(255,170,0,0.025)' : (locked ? 'rgba(255,255,255,0.01)' : (isVisible ? `${color}08` : 'rgba(255,255,255,0.02)')),
                  border: `1px solid ${isAdminOnly ? 'rgba(255,170,0,0.15)' : (locked ? 'rgba(255,255,255,0.08)' : (isVisible ? `${color}30` : 'var(--border)'))}`,
                  borderRadius: 'var(--radius-md)', transition: 'all 0.3s ease',
                  opacity: isAdminOnly ? 0.65 : (locked ? 0.6 : 1),
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontSize: '1.2rem' }}>{panel.icon}</span>
                    <div>
                      <div style={{ fontWeight: 600, color: (locked || isAdminOnly) ? 'var(--text-muted)' : '#e8eeff', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {panel.label}
                        {isAdminOnly && (
                          <span style={{ fontSize: '0.6rem', background: 'rgba(255,170,0,0.1)', border: '1px solid rgba(255,170,0,0.3)', color: '#c97a00', padding: '1px 6px', borderRadius: 99, fontWeight: 800, letterSpacing: '0.05em' }}>🔧 Testing</span>
                        )}
                        {!isAdminOnly && locked && (
                          <span style={{ fontSize: '0.72rem', background: 'rgba(220,50,50,0.12)', border: '1px solid rgba(220,50,50,0.3)', color: '#dc3232', padding: '1px 6px', borderRadius: '99px', fontWeight: 700 }}>🔒 Restricted</span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{panel.desc}</div>
                    </div>
                  </div>
                  {isUserToggleable ? (
                    <Toggle
                      checked={isVisible}
                      onChange={e => panelSetMap[panel.id](!e.target.checked)}
                    />
                  ) : (
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.04em', padding: '0.2rem 0.6rem', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', whiteSpace: 'nowrap' }}>
                      {isAdminOnly ? 'Admin Only' : locked ? 'Admin Locked' : 'Always On'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
