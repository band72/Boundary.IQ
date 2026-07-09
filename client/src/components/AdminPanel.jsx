import { useState, useEffect, useCallback } from 'react';
import { API } from '../config';

// ── Shared helpers ────────────────────────────────────────────────────────────
const ROLE_C  = { admin: { bg: 'rgba(255,170,0,.12)', border: 'rgba(255,170,0,.35)', text: '#ffaa00' }, user: { bg: 'rgba(61,127,255,.1)', border: 'rgba(61,127,255,.28)', text: 'var(--accent)' } };
const PLAN_C  = { free: { bg: 'rgba(120,120,120,.1)', border: 'rgba(120,120,120,.25)', text: '#aaa' }, basic: { bg: 'rgba(61,127,255,.12)', border: 'rgba(61,127,255,.30)', text: '#3d7fff' }, pro: { bg: 'rgba(80,200,120,.12)', border: 'rgba(80,200,120,.30)', text: '#50c878' }, enterprise: { bg: 'rgba(255,170,0,.12)', border: 'rgba(255,170,0,.35)', text: '#ffaa00' } };
const ACTION_C = { login: '#50c878', logout: '#aaa', register: '#3d7fff', google_login: '#4285F4', password_change: '#ffaa00', force_password_reset: '#ff7070', delete_user: '#ff4444', role_change: '#a855f7', plan_change: '#50c878', create_invite: '#3d7fff', revoke_sessions: '#ff7070', profile_update: '#aaa', admin_set_plan: '#ffaa00', admin_cancel_subscription: '#ff7070' };
const fmtDate = (s) => s ? new Date(s).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '—';
const fmtTime = (s) => s ? new Date(s).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';

function Badge({ label, colors }) {
  return <span style={{ fontSize:'0.6rem', fontWeight:800, letterSpacing:'0.07em', textTransform:'uppercase', padding:'2px 8px', borderRadius:99, background:colors.bg, border:`1px solid ${colors.border}`, color:colors.text, flexShrink:0 }}>{label}</span>;
}

function Flash({ msg, type }) {
  if (!msg) return null;
  return <div style={{ padding:'0.6rem 1rem', borderRadius:'var(--radius-md)', marginBottom:'1rem', background: type==='error'?'rgba(255,70,70,.12)':'rgba(80,200,120,.12)', border:`1px solid ${type==='error'?'rgba(255,70,70,.3)':'rgba(80,200,120,.3)'}`, color: type==='error'?'#ff7070':'#50c878', fontSize:'0.81rem' }}>{msg}</div>;
}

function LicenseKeyDisplay({ licenseKey, flash }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(licenseKey);
    setCopied(true);
    flash('✓ Copied to clipboard!');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <textarea
        readOnly
        value={licenseKey}
        style={{
          width: '100%',
          padding: '0.55rem',
          background: 'rgba(0,0,0,0.35)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          color: '#fff',
          fontFamily: 'monospace',
          fontSize: '0.76rem',
          height: '80px',
          resize: 'none',
          boxSizing: 'border-box',
        }}
        onClick={(e) => e.target.select()}
      />
      <button className="btn btn-ghost" onClick={handleCopy} style={{ alignSelf: 'flex-end', fontSize: '0.72rem', padding: '0.25rem 0.6rem' }}>
        {copied ? '✓ Copied!' : '📋 Copy to Clipboard'}
      </button>
    </div>
  );
}

function Modal({ open, title, body, onConfirm, onCancel, danger }) {
  if (!open) return null;
  return <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.65)', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:3000 }}>
    <div style={{ background:'var(--bg-elevated)', border:`1px solid ${danger?'rgba(255,70,70,.3)':'var(--border)'}`, borderRadius:'var(--radius-md)', padding:'1.5rem', width:380, maxWidth:'90vw' }}>
      <h3 style={{ fontSize:'1rem', fontWeight:700, color:'#fff', marginBottom:'0.5rem' }}>{title}</h3>
      <div style={{ fontSize:'0.83rem', color:'var(--text-secondary)', marginBottom:'1.25rem', lineHeight:1.6 }}>{body}</div>
      <div style={{ display:'flex', gap:'0.75rem' }}>
        <button className={`btn ${danger?'btn-danger':'btn-primary'}`} style={{ flex:1, justifyContent:'center' }} onClick={onConfirm}>{danger?'⚠️ Confirm':'Confirm'}</button>
        <button className="btn btn-ghost" style={{ flex:1, justifyContent:'center' }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>;
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function AdminPanel() {
  const [tab, setTab] = useState('users');
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('success');
  const [modal, setModal] = useState(null);

  const token = localStorage.getItem('boundaryiq_auth_token');
  const auth  = { headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` } };

  const flash = (text, type='success') => { setMsg(text); setMsgType(type); setTimeout(()=>setMsg(''), 5000); };

  const TABS = [
    { id:'users',   icon:'👥', label:'Users'        },
    { id:'orders',  icon:'💳', label:'Orders'        },
    { id:'audit',   icon:'📋', label:'Audit Log'     },
    { id:'invites', icon:'✉️', label:'Invites'       },
    { id:'plans',   icon:'⚙️', label:'Plan Templates'},
    { id:'stats',   icon:'📊', label:'System Stats'  },
  ];

  return (
    <div style={{ padding:'1.5rem', maxWidth:1100, margin:'0 auto' }}>
      <div style={{ marginBottom:'1.25rem' }}>
        <h1 style={{ fontSize:'1.4rem', fontWeight:800, color:'#fff', marginBottom:'0.2rem' }}>👥 User Administration</h1>
        <p style={{ fontSize:'0.81rem', color:'var(--text-muted)' }}>Manage users, roles, plans, sessions, audit log, and invites.</p>
      </div>

      {/* Sub-tabs */}
      <div style={{ display:'flex', gap:'0.4rem', marginBottom:'1.25rem', background:'rgba(9,14,26,.4)', padding:'0.35rem', borderRadius:'var(--radius-md)', border:'1px solid var(--border)', width:'fit-content' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)} style={{ padding:'0.45rem 1rem', borderRadius:'var(--radius-sm)', border:'none', background: tab===t.id?'rgba(61,127,255,.2)':'transparent', color: tab===t.id?'var(--accent)':'var(--text-muted)', fontWeight: tab===t.id?700:400, fontSize:'0.8rem', cursor:'pointer', transition:'all .15s', display:'flex', alignItems:'center', gap:'0.35rem' }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <Flash msg={msg} type={msgType} />

      {tab==='users'   && <UsersTab auth={auth} flash={flash} modal={modal} setModal={setModal} />}
      {tab==='orders'  && <OrdersTab auth={auth} flash={flash} modal={modal} setModal={setModal} />}
      {tab==='audit'   && <AuditTab auth={auth} />}
      {tab==='invites' && <InvitesTab auth={auth} flash={flash} />}
      {tab==='plans'   && <PlansTab auth={auth} flash={flash} />}
      {tab==='stats'   && <StatsTab auth={auth} />}
    </div>
  );
}

// ── Users Tab ────────────────────────────────────────────────────────────────
function UsersTab({ auth, flash, modal, setModal }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [drawerUser, setDrawerUser] = useState(null); // user detail drawer
  const [tempPw, setTempPw] = useState(null); // shown after force reset
  const [selected, setSelected] = useState(new Set());

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/auth/users`, auth);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setUsers(d.users || []);
    } catch (e) { flash(e.message, 'error'); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const doRoleChange = async (userId, role) => {
    try {
      const r = await fetch(`${API}/auth/users/${userId}/role`, { method:'POST', ...auth, body:JSON.stringify({role}) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      flash(`✓ Role updated to "${role}"`);
      fetchUsers();
    } catch(e) { flash(e.message,'error'); }
    finally { setModal(null); }
  };

  const doPlanChange = async (userId, plan) => {
    try {
      const r = await fetch(`${API}/auth/users/${userId}/plan`, { method:'POST', ...auth, body:JSON.stringify({plan}) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      flash(`✓ Plan updated to "${plan}"`);
      fetchUsers();
    } catch(e) { flash(e.message,'error'); }
    finally { setModal(null); }
  };

  const doDelete = async (userId) => {
    try {
      const r = await fetch(`${API}/auth/users/${userId}`, { method:'DELETE', ...auth });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      flash('✓ User deleted');
      fetchUsers();
      if (drawerUser?.id === userId) setDrawerUser(null);
    } catch(e) { flash(e.message,'error'); }
    finally { setModal(null); }
  };

  const doBatchDelete = async () => {
    try {
      const userIds = Array.from(selected);
      const r = await fetch(`${API}/auth/users/batch-delete`, { method:'POST', ...auth, body:JSON.stringify({userIds}) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      flash(`✓ ${d.deletedCount} users deleted`);
      fetchUsers();
      setSelected(new Set());
    } catch(e) { flash(e.message,'error'); }
    finally { setModal(null); }
  };


  const doForceReset = async (userId) => {
    try {
      const r = await fetch(`${API}/auth/users/${userId}/reset-password`, { method:'POST', ...auth });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setTempPw(d.tempPassword);
      flash('✓ Password reset. Temporary password shown below.');
      fetchUsers();
    } catch(e) { flash(e.message,'error'); }
    finally { setModal(null); }
  };

  const doRevokeSessions = async (userId) => {
    try {
      const r = await fetch(`${API}/auth/users/${userId}/sessions`, { method:'DELETE', ...auth });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      flash(`✓ Revoked ${d.revoked} session(s)`);
    } catch(e) { flash(e.message,'error'); }
    finally { setModal(null); }
  };

  const doShowLicense = async (userId, username) => {
    try {
      const res = await fetch(`${API}/auth/users/${userId}/license`, auth);
      const data = await res.json();
      if (res.ok) {
        if (!data.license || !data.license.RawKey) {
          flash(`No active license key found for user ${username}.`, 'warning');
        } else {
          setModal({
            title: `License Key — ${username}`,
            body: <LicenseKeyDisplay licenseKey={data.license.RawKey} flash={flash} />,
            onConfirm: () => setModal(null),
            onCancel: () => setModal(null),
          });
        }
      } else {
        flash(data.error || 'Failed to fetch license key', 'error');
      }
    } catch (e) {
      flash(e.message, 'error');
    }
  };

  const doGenerateLicense = async (userId, username, userPlan) => {
    if (userPlan === 'free') {
      flash('Cannot generate a license key for users on the Free plan. Please assign basic/pro/enterprise first.', 'error');
      return;
    }
    setModal({
      title: `Generate License Key`,
      body: `Are you sure you want to generate and sign a new license key for ${username} (${userPlan})? This will associate it as their active license.`,
      onConfirm: async () => {
        setModal(null);
        try {
          const res = await fetch(`${API}/auth/users/${userId}/license/generate`, {
            method: 'POST',
            ...auth,
          });
          const data = await res.json();
          if (res.ok && data.licenseKey) {
            flash(`✓ License key generated successfully!`);
            setModal({
              title: `License Key Generated — ${username}`,
              body: <LicenseKeyDisplay licenseKey={data.licenseKey} flash={flash} />,
              onConfirm: () => setModal(null),
              onCancel: () => setModal(null),
            });
          } else {
            flash(data.error || 'Failed to generate license key', 'error');
          }
        } catch (e) {
          flash(e.message, 'error');
        }
      }
    });
  };

  const exportCSV = () => {
    const rows = [['ID','Username','Role','Plan','LastLogin','DisplayName']];
    users.forEach(u => rows.push([u.id, u.username, u.role, u.plan, u.lastLogin||'', u.displayName||'']));
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='users.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const filtered = users.filter(u => {
    const q = search.toLowerCase();
    const matchQ = !q || u.username.toLowerCase().includes(q) || (u.displayName||'').toLowerCase().includes(q);
    const matchR = !roleFilter || u.role === roleFilter;
    const matchP = !planFilter || u.plan === planFilter;
    return matchQ && matchR && matchP;
  });

  const stats = { total:users.length, admins:users.filter(u=>u.role==='admin').length, pro:users.filter(u=>u.plan!=='free').length, active:users.filter(u=>u.lastLogin && new Date(u.lastLogin)>new Date(Date.now()-7*86400000)).length };

  return (
    <div>
      <Modal open={!!modal} title={modal?.title} body={modal?.body} danger={modal?.danger} onConfirm={modal?.onConfirm} onCancel={()=>setModal(null)} />

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'0.7rem', marginBottom:'1.25rem' }}>
        {[['👥','Total',stats.total,'var(--accent)'],['🔑','Admins',stats.admins,'#ffaa00'],['⭐','Paid',stats.pro,'#50c878'],['🟢','Active 7d',stats.active,'#aaa']].map(([icon,label,val,color])=>(
          <div key={label} style={{ padding:'0.9rem', background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)' }}>
            <div style={{ fontSize:'1.3rem', marginBottom:'0.2rem' }}>{icon}</div>
            <div style={{ fontSize:'1.5rem', fontWeight:800, color }}>{val}</div>
            <div style={{ fontSize:'0.7rem', color:'var(--text-muted)' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Temp password banner */}
      {tempPw && (
        <div style={{ padding:'1rem', borderRadius:'var(--radius-md)', marginBottom:'1rem', background:'rgba(255,170,0,.1)', border:'1px solid rgba(255,170,0,.3)' }}>
          <div style={{ fontSize:'0.78rem', fontWeight:700, color:'#ffaa00', marginBottom:'0.35rem' }}>⚠️ Temporary Password (shown once — copy now)</div>
          <div style={{ fontFamily:'monospace', fontSize:'1.1rem', letterSpacing:'0.12em', color:'#fff', background:'rgba(0,0,0,.3)', padding:'0.5rem 1rem', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            {tempPw}
            <button className="btn btn-ghost" style={{ fontSize:'0.72rem', padding:'0.2rem 0.6rem' }} onClick={()=>{navigator.clipboard.writeText(tempPw); flash('Copied!'); setTempPw(null);}}>Copy & Close</button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display:'flex', gap:'0.6rem', marginBottom:'0.9rem', flexWrap:'wrap' }}>
        <input type="text" placeholder="🔍 Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{ flex:1, minWidth:160, padding:'0.5rem 0.85rem', borderRadius:'var(--radius-md)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.81rem' }} />
        <select value={roleFilter} onChange={e=>setRoleFilter(e.target.value)} style={{ padding:'0.5rem 0.7rem', borderRadius:'var(--radius-md)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.78rem' }}>
          <option value="">All roles</option><option value="admin">admin</option><option value="user">user</option>
        </select>
        <select value={planFilter} onChange={e=>setPlanFilter(e.target.value)} style={{ padding:'0.5rem 0.7rem', borderRadius:'var(--radius-md)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.78rem' }}>
          <option value="">All plans</option><option value="free">free</option><option value="basic">basic</option><option value="pro">pro</option><option value="enterprise">enterprise</option>
        </select>
        <button className="btn btn-ghost" onClick={fetchUsers} title="Refresh" style={{ minWidth:38 }}>⟳</button>
        <button className="btn btn-ghost" onClick={exportCSV} style={{ fontSize:'0.75rem' }}>⬇ CSV</button>
      </div>

      {/* Table */}
      <div style={{ background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'40px 2.5fr 1fr 1.2fr 1.2fr 1.5fr 2fr', padding:'0.55rem 1rem', background:'rgba(255,255,255,.04)', borderBottom:'1px solid var(--border)', fontSize:'0.65rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--text-muted)', alignItems:'center' }}>
          <input type="checkbox" 
            checked={filtered.length > 0 && selected.size === filtered.length} 
            onChange={e => {
              if (e.target.checked) setSelected(new Set(filtered.map(u => u.id)));
              else setSelected(new Set());
            }} 
          />
          <span>User</span><span>Role</span><span>Plan</span><span>Tokens</span><span>Last Login</span><span>Actions</span>
        </div>

        {loading ? (
          <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)' }}><span className="spinner" style={{ width:24, height:24, borderWidth:2 }}/></div>
        ) : filtered.length===0 ? (
          <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)', fontSize:'0.83rem' }}>No users found</div>
        ) : filtered.map((u,i) => (
          <div key={u.id} style={{ display:'grid', gridTemplateColumns:'40px 2.5fr 1fr 1.2fr 1.2fr 1.5fr 2fr', padding:'0.7rem 1rem', alignItems:'center', borderBottom: i<filtered.length-1?'1px solid var(--border)':'none', cursor:'pointer', transition:'background .12s' }}
            onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,.025)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
          >
            <input type="checkbox" checked={selected.has(u.id)} onChange={e => {
              const newSet = new Set(selected);
              if (e.target.checked) newSet.add(u.id);
              else newSet.delete(u.id);
              setSelected(newSet);
            }} onClick={e => e.stopPropagation()} />
            {/* User info */}
            <div style={{ display:'flex', alignItems:'center', gap:'0.6rem' }}>
              <div style={{ width:32, height:32, borderRadius:'50%', flexShrink:0, background:'linear-gradient(135deg,var(--accent),#7c3aed)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'0.72rem', fontWeight:800, color:'#fff' }}>
                {u.username.substring(0,2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize:'0.83rem', fontWeight:600, color:'var(--text-primary)' }}>{u.username}</div>
                {u.displayName && <div style={{ fontSize:'0.7rem', color:'var(--text-muted)' }}>{u.displayName}</div>}
              </div>
            </div>
            {/* Role */}
            <div><Badge label={u.role} colors={ROLE_C[u.role]||ROLE_C.user}/></div>
            {/* Plan */}
            <div><Badge label={u.plan} colors={PLAN_C[u.plan]||PLAN_C.free}/></div>
            {/* Tokens */}
            <div style={{ fontSize:'0.75rem', fontFamily:'monospace', color:'var(--accent)' }}>
              {u.totalTokens?.toLocaleString() || 0}
            </div>
            {/* Last login */}
            <div style={{ fontSize:'0.7rem', color:'var(--text-muted)' }}>{fmtDate(u.lastLogin)}</div>
            {/* Actions */}
            <div style={{ display:'flex', gap:'0.35rem', flexWrap:'wrap' }}>
              {/* Role */}
              <select value={u.role} onChange={e=>{
                const newRole = e.target.value;
                setModal({ title:`Change Role`, body:`Set role to "${newRole}" for ${u.username}?`, onConfirm:()=>doRoleChange(u.id, newRole) });
              }}
                style={{ fontSize:'0.68rem', padding:'3px 5px', borderRadius:4, background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', cursor:'pointer' }}>
                <option value="user">user</option><option value="admin">admin</option>
              </select>
              {/* Plan */}
              <select value={u.plan} onChange={e=>{
                const newPlan = e.target.value;
                setModal({ title:`Change Plan`, body:`Grant "${newPlan}" plan to ${u.username}?`, onConfirm:()=>doPlanChange(u.id, newPlan) });
              }}
                style={{ fontSize:'0.68rem', padding:'3px 5px', borderRadius:4, background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', cursor:'pointer' }}>
                <option value="free">free</option><option value="basic">basic</option><option value="pro">pro</option><option value="enterprise">enterprise</option>
              </select>
              {/* Reset PW */}
              <button title="Force password reset" className="btn btn-ghost" style={{ fontSize:'0.65rem', padding:'2px 7px' }}
                onClick={()=>setModal({ title:'Force Password Reset', body:`Reset password for ${u.username}? A temporary password will be generated and all their sessions will be revoked.`, danger:true, onConfirm:()=>doForceReset(u.id) })}>
                🔑
              </button>
              {/* Revoke sessions */}
              <button title="Revoke all sessions" className="btn btn-ghost" style={{ fontSize:'0.65rem', padding:'2px 7px' }}
                onClick={()=>setModal({ title:'Revoke Sessions', body:`Force-logout ${u.username} from all devices?`, danger:true, onConfirm:()=>doRevokeSessions(u.id) })}>
                🚫
              </button>
              {/* Delete */}
              <button title="Delete user" className="btn btn-ghost" style={{ fontSize:'0.65rem', padding:'2px 7px', color:'#ff7070' }}
                onClick={()=>setModal({ title:'⚠️ Delete User', body:`Permanently delete "${u.username}"? This cannot be undone. All their data and sessions will be removed.`, danger:true, onConfirm:()=>doDelete(u.id) })}>
                🗑️
              </button>
              {/* Show license key */}
              <button title="Show active license key" className="btn btn-ghost" style={{ fontSize:'0.65rem', padding:'2px 7px' }}
                onClick={()=>doShowLicense(u.id, u.username)}>
                👁️
              </button>
              {/* Generate license key */}
              <button title="Generate signed license key" className="btn btn-ghost" style={{ fontSize:'0.65rem', padding:'2px 7px', color:'var(--accent)' }}
                onClick={()=>doGenerateLicense(u.id, u.username, u.plan)}>
                🗝️
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Audit Log Tab ─────────────────────────────────────────────────────────────
function AuditTab({ auth }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');

  const fetch_ = useCallback(async () => {
    setLoading(true);
    const qs = actionFilter ? `?action=${actionFilter}&limit=200` : '?limit=200';
    try {
      const r = await fetch(`${API}/auth/audit-log${qs}`, auth);
      const d = await r.json();
      setEntries(d.entries || []);
    } catch (err) {
      console.error('Failed to fetch audit log:', err);
    }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionFilter]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const ALL_ACTIONS = [...new Set(Object.keys(ACTION_C))];

  return (
    <div>
      <div style={{ display:'flex', gap:'0.6rem', marginBottom:'1rem', alignItems:'center' }}>
        <select value={actionFilter} onChange={e=>setActionFilter(e.target.value)} style={{ padding:'0.45rem 0.7rem', borderRadius:'var(--radius-md)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.78rem' }}>
          <option value="">All actions</option>
          {ALL_ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <button className="btn btn-ghost" onClick={fetch_} style={{ minWidth:38 }}>⟳</button>
        <span style={{ fontSize:'0.72rem', color:'var(--text-muted)', marginLeft:'auto' }}>{entries.length} entries</span>
      </div>

      <div style={{ background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1.2fr 1fr 1fr 2fr', padding:'0.5rem 1rem', background:'rgba(255,255,255,.04)', borderBottom:'1px solid var(--border)', fontSize:'0.63rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--text-muted)' }}>
          <span>Time</span><span>Action</span><span>User</span><span>Actor</span><span>Detail / IP</span>
        </div>
        {loading ? <div style={{ textAlign:'center', padding:'1.5rem', color:'var(--text-muted)' }}><span className="spinner" style={{ width:20, height:20, borderWidth:2 }}/></div>
        : entries.length === 0 ? <div style={{ textAlign:'center', padding:'1.5rem', color:'var(--text-muted)', fontSize:'0.83rem' }}>No audit entries yet</div>
        : entries.map((e,i) => (
          <div key={e.id} style={{ display:'grid', gridTemplateColumns:'1fr 1.2fr 1fr 1fr 2fr', padding:'0.55rem 1rem', borderBottom: i<entries.length-1?'1px solid var(--border)':'none', alignItems:'center', fontSize:'0.75rem' }}>
            <span style={{ color:'var(--text-muted)', fontFamily:'monospace', fontSize:'0.68rem' }}>{fmtTime(e.timestamp)}</span>
            <span style={{ fontWeight:700, color: ACTION_C[e.action]||'var(--text-secondary)' }}>{e.action}</span>
            <span style={{ color:'var(--text-secondary)' }}>{e.username||'—'}</span>
            <span style={{ color:'var(--text-secondary)' }}>{e.actorUsername||'—'}</span>
            <div style={{ display:'flex', flexDirection:'column', gap:'1px' }}>
              {e.target && <span style={{ color:'var(--text-muted)', fontSize:'0.68rem' }}>→ {e.target}</span>}
              {e.detail && <span style={{ color:'var(--text-muted)', fontSize:'0.65rem', fontFamily:'monospace' }}>{typeof e.detail==='object'?JSON.stringify(e.detail):e.detail}</span>}
              {e.ipAddress && <span style={{ color:'rgba(255,255,255,.2)', fontSize:'0.63rem' }}>{e.ipAddress}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Invites Tab ───────────────────────────────────────────────────────────────
function InvitesTab({ auth, flash }) {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ email:'', note:'', hours:72 });
  const [creating, setCreating] = useState(false);
  const [newInvite, setNewInvite] = useState(null);

  const fetchInvites = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/auth/invites`, auth);
      const d = await r.json();
      setInvites(d.invites || []);
    } catch (err) {
      console.error('Failed to fetch invites:', err);
    }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchInvites(); }, [fetchInvites]);

  const createInvite = async () => {
    setCreating(true);
    try {
      const r = await fetch(`${API}/auth/invite`, { method:'POST', ...auth, body:JSON.stringify({ email:form.email||null, note:form.note||null, expiresInHours:parseInt(form.hours) }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setNewInvite(d);
      flash(`✓ Invite created${form.email ? ` for ${form.email}` : ''}`);
      setForm({ email:'', note:'', hours:72 });
      fetchInvites();
    } catch(e) { flash(e.message,'error'); }
    finally { setCreating(false); }
  };

  const revokeInvite = async (token) => {
    try {
      await fetch(`${API}/auth/invites/${token}`, { method:'DELETE', ...auth });
      flash('✓ Invite revoked');
      fetchInvites();
    } catch(e) { flash(e.message,'error'); }
  };

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem', alignItems:'start' }}>
      {/* Create invite */}
      <div style={{ background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', padding:'1.25rem' }}>
        <h3 style={{ fontSize:'0.95rem', fontWeight:700, color:'#fff', marginBottom:'1rem' }}>✉️ Create Invite Link</h3>
        <div style={{ display:'flex', flexDirection:'column', gap:'0.7rem' }}>
          <div>
            <label style={{ fontSize:'0.75rem', color:'var(--text-muted)', display:'block', marginBottom:'0.3rem' }}>Email (optional — sends invite email)</label>
            <input type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="user@example.com" style={{ width:'100%', padding:'0.5rem 0.75rem', borderRadius:'var(--radius-sm)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.81rem', boxSizing:'border-box' }} />
          </div>
          <div>
            <label style={{ fontSize:'0.75rem', color:'var(--text-muted)', display:'block', marginBottom:'0.3rem' }}>Note (shown to invitee)</label>
            <input type="text" value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} placeholder="Welcome to the team!" style={{ width:'100%', padding:'0.5rem 0.75rem', borderRadius:'var(--radius-sm)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.81rem', boxSizing:'border-box' }} />
          </div>
          <div>
            <label style={{ fontSize:'0.75rem', color:'var(--text-muted)', display:'block', marginBottom:'0.3rem' }}>Expires in (hours)</label>
            <select value={form.hours} onChange={e=>setForm(f=>({...f,hours:e.target.value}))} style={{ width:'100%', padding:'0.5rem 0.75rem', borderRadius:'var(--radius-sm)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.81rem' }}>
              <option value={24}>24 hours</option><option value={48}>48 hours</option><option value={72}>72 hours (default)</option><option value={168}>1 week</option><option value={720}>30 days</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={createInvite} disabled={creating} style={{ justifyContent:'center' }}>
            {creating ? <><span className="spinner" style={{ width:14, height:14, borderWidth:2 }}/> Creating…</> : '✉️ Generate Invite Link'}
          </button>
        </div>

        {/* New invite result */}
        {newInvite && (
          <div style={{ marginTop:'1rem', padding:'0.9rem', background:'rgba(61,127,255,.08)', border:'1px solid rgba(61,127,255,.25)', borderRadius:'var(--radius-sm)' }}>
            <div style={{ fontSize:'0.72rem', fontWeight:700, color:'var(--accent)', marginBottom:'0.4rem' }}>✓ Invite Link (copy before leaving)</div>
            <div style={{ fontFamily:'monospace', fontSize:'0.68rem', color:'#fff', wordBreak:'break-all', marginBottom:'0.5rem' }}>{newInvite.inviteUrl}</div>
            <button className="btn btn-ghost" style={{ fontSize:'0.7rem', padding:'0.25rem 0.7rem' }} onClick={()=>{ navigator.clipboard.writeText(newInvite.inviteUrl); flash('Copied!'); setNewInvite(null); }}>Copy & Close</button>
          </div>
        )}
      </div>

      {/* Invite list */}
      <div style={{ background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', padding:'1.25rem' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.9rem' }}>
          <h3 style={{ fontSize:'0.95rem', fontWeight:700, color:'#fff', margin:0 }}>Recent Invites</h3>
          <button className="btn btn-ghost" onClick={fetchInvites} style={{ minWidth:32 }}>⟳</button>
        </div>
        {loading ? <div style={{ color:'var(--text-muted)', fontSize:'0.8rem' }}>Loading…</div>
        : invites.length === 0 ? <div style={{ color:'var(--text-muted)', fontSize:'0.8rem' }}>No invites yet</div>
        : <div style={{ display:'flex', flexDirection:'column', gap:'0.6rem', maxHeight:420, overflowY:'auto' }}>
            {invites.map(inv => (
              <div key={inv.token} style={{ padding:'0.7rem 0.9rem', background:'var(--bg-elevated)', borderRadius:'var(--radius-sm)', border:`1px solid ${inv.used?'rgba(80,200,120,.2)':inv.expired?'rgba(255,70,70,.2)':'var(--border)'}` }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'0.5rem' }}>
                  <div>
                    <div style={{ fontSize:'0.78rem', fontWeight:600, color:'var(--text-primary)' }}>{inv.email || <span style={{ color:'var(--text-muted)' }}>Open invite</span>}</div>
                    {inv.note && <div style={{ fontSize:'0.68rem', color:'var(--text-muted)', fontStyle:'italic' }}>{inv.note}</div>}
                    <div style={{ fontSize:'0.65rem', color:'var(--text-muted)', marginTop:'0.2rem' }}>
                      {inv.used ? <span style={{ color:'#50c878' }}>✓ Used by {inv.usedByUsername}</span> : inv.expired ? <span style={{ color:'#ff7070' }}>⏱ Expired</span> : <span style={{ color:'var(--accent)' }}>⏳ Expires {fmtDate(inv.expiresAt)}</span>}
                    </div>
                  </div>
                  {!inv.used && !inv.expired && (
                    <button className="btn btn-ghost" style={{ fontSize:'0.65rem', padding:'2px 7px', flexShrink:0 }} onClick={()=>revokeInvite(inv.token)}>Revoke</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        }
      </div>
    </div>
  );
}

// ── System Stats Tab ──────────────────────────────────────────────────────────
function StatsTab({ auth }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/auth/system-stats`, auth).then(r=>r.json()).then(setStats).catch(()=>{}).finally(()=>setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div style={{ color:'var(--text-muted)', padding:'2rem', textAlign:'center' }}><span className="spinner" style={{ width:24, height:24, borderWidth:2 }}/></div>;
  if (!stats) return <div style={{ color:'#ff7070' }}>Failed to load stats.</div>;

  const items = [
    ['👥','Total Users', stats.userCount, 'var(--accent)'],
    ['⭐','Paid Users',   stats.proCount,  '#50c878'],
    ['🔗','Active Sessions', stats.sessionCount, '#ffaa00'],
    ['📝','Solves Today', stats.todaySolves, '#a855f7'],
    ['📦','Total Solves', stats.totalSolves, '#3d7fff'],
    ['🆓','Free Users',   stats.userCount - stats.proCount, '#aaa'],
  ];

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'0.85rem', marginBottom:'1.5rem' }}>
        {items.map(([icon,label,val,color]) => (
          <div key={label} style={{ padding:'1.25rem', background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)' }}>
            <div style={{ fontSize:'1.5rem', marginBottom:'0.35rem' }}>{icon}</div>
            <div style={{ fontSize:'1.8rem', fontWeight:800, color }}>{val}</div>
            <div style={{ fontSize:'0.75rem', color:'var(--text-muted)' }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ padding:'1rem', background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', fontSize:'0.78rem', color:'var(--text-muted)' }}>
        💡 Tip: Add <code style={{ color:'var(--accent)', background:'rgba(61,127,255,.08)', padding:'1px 5px', borderRadius:3 }}>RESEND_API_KEY</code> to <code style={{ color:'var(--accent)', background:'rgba(61,127,255,.08)', padding:'1px 5px', borderRadius:3 }}>.env</code> to enable transactional emails (welcome, password reset, plan changes). Set <code style={{ color:'#ffaa00', background:'rgba(255,170,0,.08)', padding:'1px 5px', borderRadius:3 }}>INVITE_ONLY=true</code> to require invite tokens for registration.
      </div>
    </div>
  );
}

// ── Orders Tab ────────────────────────────────────────────────────────────────
function OrdersTab({ auth, flash, modal, setModal }) {
  const [orders, setOrders] = useState([]);
  const [revenue, setRevenue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/auth/orders`, auth);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setOrders(d.orders || []);
      setRevenue(d.revenue || null);
    } catch (e) { flash(e.message, 'error'); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  const doSetPlan = async (userId, plan) => {
    try {
      const r = await fetch(`${API}/auth/orders/${userId}/plan`, { method:'PUT', ...auth, body:JSON.stringify({plan}) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      flash(`✓ Plan set to "${plan}"`);
      fetchOrders();
    } catch(e) { flash(e.message,'error'); }
    finally { setModal(null); }
  };

  const doCancel = async (userId, username) => {
    try {
      const r = await fetch(`${API}/auth/orders/${userId}`, { method:'DELETE', ...auth });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      flash(`✓ Subscription cancelled — ${username} downgraded to Free`);
      fetchOrders();
    } catch(e) { flash(e.message,'error'); }
    finally { setModal(null); }
  };

  const exportCSV = () => {
    const rows = [['UserID','Username','Email','Role','Plan','Status','Stripe Customer','Stripe Sub','Period End','Total Solves','Updated']];
    orders.forEach(o => rows.push([
      o.userId, o.username, o.email||'', o.role, o.plan, o.status,
      o.stripeCustomerId||'', o.stripeSubscriptionId||'',
      o.periodEnd||'', o.totalSolves, o.updatedAt||'',
    ]));
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='orders.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const PLAN_PRICE = { free: 0, basic: 5, pro: 29, enterprise: 99 };
  const STATUS_C = { active:'#50c878', inactive:'#aaa', cancelled:'#ff7070', past_due:'#ffaa00', trialing:'#3d7fff' };

  const filtered = orders.filter(o => {
    const q = search.toLowerCase();
    const matchQ = !q || o.username.toLowerCase().includes(q) || (o.email||'').toLowerCase().includes(q) || (o.stripeCustomerId||'').toLowerCase().includes(q);
    const matchP = !planFilter || o.plan === planFilter;
    const matchS = !statusFilter || o.status === statusFilter;
    return matchQ && matchP && matchS;
  });

  return (
    <div>
      <Modal open={!!modal} title={modal?.title} body={modal?.body} danger={modal?.danger} onConfirm={modal?.onConfirm} onCancel={()=>setModal(null)} />

      {/* Revenue Summary Cards */}
      {revenue && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:'0.7rem', marginBottom:'1.25rem' }}>
          {[
            ['💰','MRR', `$${(revenue.mrr||0).toLocaleString()}`, '#50c878'],
            ['👤','Free', revenue.breakdown?.free||0, '#aaa'],
            ['⭐','Pro', revenue.breakdown?.pro||0, '#50c878'],
            ['🏢','Enterprise', revenue.breakdown?.enterprise||0, '#ffaa00'],
            ['👥','Total Users', revenue.totalUsers||0, 'var(--accent)'],
          ].map(([icon,label,val,color]) => (
            <div key={label} style={{ padding:'0.9rem', background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)' }}>
              <div style={{ fontSize:'1.25rem', marginBottom:'0.2rem' }}>{icon}</div>
              <div style={{ fontSize:'1.45rem', fontWeight:800, color }}>{val}</div>
              <div style={{ fontSize:'0.68rem', color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em' }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display:'flex', gap:'0.6rem', marginBottom:'0.9rem', flexWrap:'wrap' }}>
        <input type="text" placeholder="🔍 Search username / email / Stripe ID…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{ flex:1, minWidth:200, padding:'0.5rem 0.85rem', borderRadius:'var(--radius-md)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.81rem' }} />
        <select value={planFilter} onChange={e=>setPlanFilter(e.target.value)}
          style={{ padding:'0.5rem 0.7rem', borderRadius:'var(--radius-md)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.78rem' }}>
          <option value="">All plans</option><option value="free">free</option><option value="basic">basic</option><option value="pro">pro</option><option value="enterprise">enterprise</option>
        </select>
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}
          style={{ padding:'0.5rem 0.7rem', borderRadius:'var(--radius-md)', background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'0.78rem' }}>
          <option value="">All statuses</option><option value="active">active</option><option value="inactive">inactive</option><option value="cancelled">cancelled</option><option value="past_due">past_due</option>
        </select>
        <button className="btn btn-ghost" onClick={fetchOrders} title="Refresh" style={{ minWidth:38 }}>⟳</button>
        <button className="btn btn-ghost" onClick={exportCSV} style={{ fontSize:'0.75rem' }}>⬇ CSV</button>
      </div>

      {/* Orders Table */}
      <div style={{ background:'rgba(9,14,26,.4)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 0.8fr 1fr 1.4fr 2fr', padding:'0.55rem 1rem', background:'rgba(255,255,255,.04)', borderBottom:'1px solid var(--border)', fontSize:'0.63rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--text-muted)' }}>
          <span>User</span><span>Plan</span><span>Status</span><span>Solves</span><span>Period End</span><span>Stripe IDs</span><span>Actions</span>
        </div>
        {loading ? (
          <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)' }}><span className="spinner" style={{ width:24, height:24, borderWidth:2 }}/></div>
        ) : filtered.length===0 ? (
          <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)', fontSize:'0.83rem' }}>No orders found</div>
        ) : filtered.map((o,i) => (
          <div key={o.userId} style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 0.8fr 1fr 1.4fr 2fr', padding:'0.7rem 1rem', alignItems:'center', borderBottom: i<filtered.length-1?'1px solid var(--border)':'none', transition:'background .12s' }}
            onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,.025)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
          >
            {/* User */}
            <div style={{ display:'flex', alignItems:'center', gap:'0.6rem' }}>
              <div style={{ width:30, height:30, borderRadius:'50%', flexShrink:0, background:'linear-gradient(135deg,var(--accent),#7c3aed)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'0.68rem', fontWeight:800, color:'#fff' }}>
                {o.username.substring(0,2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize:'0.82rem', fontWeight:600, color:'var(--text-primary)' }}>{o.username}</div>
                <div style={{ fontSize:'0.68rem', color:'var(--text-muted)' }}>{o.email || <span style={{fontStyle:'italic'}}>no email</span>}</div>
              </div>
            </div>
            {/* Plan */}
            <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', flexWrap:'wrap' }}>
              <Badge label={o.plan} colors={PLAN_C[o.plan]||PLAN_C.free}/>
              {PLAN_PRICE[o.plan] > 0 && <span style={{ fontSize:'0.6rem', color:'#50c878' }}>${PLAN_PRICE[o.plan]}/mo</span>}
            </div>
            {/* Status */}
            <div>
              <span style={{ fontSize:'0.68rem', fontWeight:700, color:STATUS_C[o.status]||'#aaa' }}>
                {o.status==='active'?'● ':'○ '}{o.status}
              </span>
            </div>
            {/* Solves */}
            <div style={{ fontSize:'0.78rem', color:'var(--text-secondary)', fontWeight:600 }}>{o.totalSolves}</div>
            {/* Period End */}
            <div style={{ fontSize:'0.7rem', color:'var(--text-muted)' }}>{o.periodEnd ? fmtDate(o.periodEnd) : <span style={{fontStyle:'italic'}}>—</span>}</div>
            {/* Stripe IDs */}
            <div style={{ fontSize:'0.62rem', color:'var(--text-muted)', fontFamily:'monospace', overflow:'hidden' }}>
              {o.stripeCustomerId
                ? <div title={o.stripeCustomerId} style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>cus:…{o.stripeCustomerId.slice(-8)}</div>
                : <span style={{ fontStyle:'italic', fontFamily:'sans-serif', color:'rgba(255,255,255,.2)' }}>No Stripe</span>}
              {o.stripeSubscriptionId && (
                <div title={o.stripeSubscriptionId} style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>sub:…{o.stripeSubscriptionId.slice(-8)}</div>
              )}
            </div>
            {/* Actions */}
            <div style={{ display:'flex', gap:'0.35rem', alignItems:'center', flexWrap:'wrap' }}>
              <select value={o.plan}
                onChange={e => {
                  const p = e.target.value;
                  setModal({ title:'Override Plan', body:`Set plan to "${p}" for ${o.username}? Access changes immediately.`, onConfirm:()=>doSetPlan(o.userId, p) });
                }}
                style={{ fontSize:'0.68rem', padding:'3px 5px', borderRadius:4, background:'var(--bg-elevated)', border:'1px solid var(--border)', color:'var(--text-primary)', cursor:'pointer' }}>
                <option value="free">free</option>
                <option value="basic">basic</option>
                <option value="pro">pro</option>
                <option value="enterprise">enterprise</option>
              </select>
              {o.plan !== 'free' && (
                <button title="Cancel — downgrade to Free" className="btn btn-ghost"
                  style={{ fontSize:'0.65rem', padding:'2px 8px', color:'#ff7070', borderColor:'rgba(255,70,70,.3)' }}
                  onClick={()=>setModal({ title:'Cancel Subscription', body:`Cancel ${o.username}'s ${o.plan} plan and downgrade to Free? Stripe will NOT auto-refund.`, danger:true, onConfirm:()=>doCancel(o.userId, o.username) })}>
                  ✕ Cancel
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop:'0.85rem', fontSize:'0.72rem', color:'var(--text-muted)', lineHeight:1.6 }}>
        💡 Plan overrides take effect immediately. To process refunds, use the{' '}
        <a href="https://dashboard.stripe.com" target="_blank" rel="noreferrer" style={{ color:'var(--accent)' }}>Stripe Dashboard</a>.
        Without <code style={{ color:'var(--accent)' }}>STRIPE_SECRET_KEY</code>, all plan changes are manual-only (mock mode).
      </div>
    </div>
  );
}

// ── Plan Settings/Templates Tab ────────────────────────────────────────────────
function PlansTab({ auth, flash }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTier, setActiveTier] = useState('free');
  
  // Form states for active plan
  const [name, setName] = useState('');
  const [priceStr, setPriceStr] = useState('0.00');
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(5);
  const [featuresStr, setFeaturesStr] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/admin/plan-settings`, auth);
      const data = await res.json();
      if (res.ok) {
        setPlans(data.settings || []);
      } else {
        flash(data.error || 'Failed to fetch plan settings', 'error');
      }
    } catch (e) {
      flash(e.message, 'error');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Sync form inputs when active plan tier changes or plan list is loaded
  useEffect(() => {
    const current = plans.find(p => p.plan === activeTier);
    if (current) {
      setName(current.name);
      setPriceStr((current.price / 100).toFixed(2));
      setIsUnlimited(current.dailyDeedLimit < 0);
      setDailyLimit(current.dailyDeedLimit < 0 ? 0 : current.dailyDeedLimit);
      setFeaturesStr(current.features.join('\n'));
      setDescription(current.description || '');
    }
  }, [activeTier, plans]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const priceCents = Math.round(parseFloat(priceStr) * 100);
      if (isNaN(priceCents) || priceCents < 0) {
        throw new Error('Please enter a valid price.');
      }
      
      const limitVal = isUnlimited ? -1 : parseInt(dailyLimit);
      if (!isUnlimited && (isNaN(limitVal) || limitVal < 0)) {
        throw new Error('Please enter a valid daily solve limit.');
      }

      const featuresList = featuresStr
        .split('\n')
        .map(f => f.trim())
        .filter(f => f.length > 0);

      const res = await fetch(`${API}/auth/admin/plan-settings/${activeTier}`, {
        method: 'PUT',
        headers: auth.headers,
        body: JSON.stringify({
          name,
          dailyDeedLimit: limitVal,
          price: priceCents,
          features: featuresList,
          description,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        flash(`✓ Settings for plan "${name}" updated successfully!`);
        // Refresh local state list
        setPlans(prev => prev.map(p => p.plan === activeTier ? data.settings : p));
      } else {
        throw new Error(data.error || 'Failed to update plan settings.');
      }
    } catch (err) {
      flash(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color:'var(--text-muted)', padding:'2rem', textAlign:'center' }}><span className="spinner" style={{ width:24, height:24, borderWidth:2 }}/></div>;
  }

  const activePlan = plans.find(p => p.plan === activeTier);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '1.5rem', alignItems: 'start' }}>
      {/* Sidebar Selector */}
      <div style={{ background: 'rgba(9,14,26,.4)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', padding: '0.25rem 0.5rem 0.5rem' }}>Plan Tiers</div>
        {['free', 'basic', 'pro', 'enterprise'].map(tier => {
          const p = plans.find(x => x.plan === tier);
          const isSelected = activeTier === tier;
          return (
            <button
              key={tier}
              onClick={() => setActiveTier(tier)}
              style={{
                width: '100%',
                padding: '0.6rem 0.85rem',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: isSelected ? 'rgba(61,127,255,.15)' : 'transparent',
                color: isSelected ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: isSelected ? 700 : 400,
                fontSize: '0.8rem',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all .12s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>{p ? p.name : tier}</span>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                {p ? (p.price === 0 ? 'Free' : `$${(p.price / 100).toFixed(0)}`) : ''}
              </span>
            </button>
          );
        })}
      </div>

      {/* Main Settings Form */}
      {activePlan && (
        <form onSubmit={handleSave} style={{ background: 'rgba(9,14,26,.4)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginBottom: '0.2rem' }}>
            ⚙️ Configure Settings: {activePlan.name} ({activeTier})
          </h3>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
            Define name, monthly subscription fee, processing constraints, and advertised features.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            {/* Display Name */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem', fontWeight: 600 }}>Display Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                style={{ width: '100%', padding: '0.55rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '0.82rem', boxSizing: 'border-box' }}
                required
              />
            </div>

            {/* Price */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem', fontWeight: 600 }}>Monthly Price ($ USD)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={priceStr}
                onChange={e => setPriceStr(e.target.value)}
                disabled={activeTier === 'free'}
                style={{ width: '100%', padding: '0.55rem 0.75rem', borderRadius: 'var(--radius-sm)', background: activeTier === 'free' ? 'transparent' : 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '0.82rem', boxSizing: 'border-box', opacity: activeTier === 'free' ? 0.5 : 1 }}
                required
              />
            </div>
          </div>

          {/* Daily solves limits */}
          <div style={{ background: 'rgba(255,255,255,.02)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1rem', marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '0.6rem' }}>
              <input
                type="checkbox"
                checked={isUnlimited}
                onChange={e => setIsUnlimited(e.target.checked)}
              />
              <span style={{ fontSize: '0.81rem', fontWeight: 600, color: '#fff' }}>Unlimited Deed Solves</span>
            </label>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0 0 0.75rem 1.4rem' }}>
              When enabled, users on this tier bypass all daily deed solving limits.
            </p>
            {!isUnlimited && (
              <div style={{ marginLeft: '1.4rem' }}>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>Daily Deed Solve Limit</label>
                <input
                  type="number"
                  min="1"
                  value={dailyLimit}
                  onChange={e => setDailyLimit(e.target.value)}
                  style={{ width: '140px', padding: '0.45rem 0.65rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                  required
                />
              </div>
            )}
          </div>

          {/* Description */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem', fontWeight: 600 }}>Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              style={{ width: '100%', padding: '0.55rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '0.82rem', boxSizing: 'border-box' }}
              placeholder="Sleek slogan or summary for this tier"
            />
          </div>

          {/* Features list */}
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem', fontWeight: 600 }}>Advertised Features (one feature per line)</label>
            <textarea
              rows={5}
              value={featuresStr}
              onChange={e => setFeaturesStr(e.target.value)}
              style={{ width: '100%', padding: '0.55rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '0.82rem', fontFamily: 'sans-serif', boxSizing: 'border-box', resize: 'vertical' }}
              placeholder="e.g.&#10;50 deed solves/day&#10;Full Batch processing&#10;Priority support"
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
