import { useState, useEffect } from 'react';
import { API } from '../config';

export default function LoginScreen({ onAuthSuccess }) {
  const [isRegister, setIsRegister] = useState(false);
  const [isForgotPw, setIsForgotPw] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [tempPwSent, setTempPwSent] = useState(false);

  // Developer Google Authentication Simulator States
  const [showDevGoogleModal, setShowDevGoogleModal] = useState(false);
  const [devGoogleEmail, setDevGoogleEmail] = useState('surveyor@google.com');

  // Live Google Sign-In Client ID State (loaded from localStorage or environment)
  const [googleClientId, setGoogleClientId] = useState(() => {
    const envId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    const resolvedEnvId = (envId && envId !== 'PLACEHOLDER' ? envId : '');
    if (import.meta.env.PROD) {
      return resolvedEnvId;
    }
    return localStorage.getItem('boundaryiq_google_client_id') || 
           resolvedEnvId || 
           '';
  });

  const [devTab, setDevTab] = useState('sim'); // 'sim' | 'live'
  const [inputClientId, setInputClientId] = useState(googleClientId);

  const saveLiveClientId = () => {
    if (!inputClientId.trim()) {
      setError('Please enter a Google Client ID.');
      setShowDevGoogleModal(false);
      return;
    }
    localStorage.setItem('boundaryiq_google_client_id', inputClientId.trim());
    setGoogleClientId(inputClientId.trim());
    setSuccessMsg('Live Google Sign-In initialized successfully!');
    setShowDevGoogleModal(false);
  };

  const clearLiveClientId = () => {
    localStorage.removeItem('boundaryiq_google_client_id');
    setGoogleClientId('');
    setInputClientId('');
    setSuccessMsg('Live Google Sign-In reverted to simulator mode.');
    setShowDevGoogleModal(false);
  };

  // Natively simulate Google Sign-in ID Token (JWT) on localhost
  const triggerGoogleSim = async () => {
    if (!devGoogleEmail.trim()) {
      setError('Please enter a simulation email.');
      setShowDevGoogleModal(false);
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(devGoogleEmail.trim())) {
      setError('Please enter a valid email address.');
      setShowDevGoogleModal(false);
      return;
    }

    setLoading(true);
    setError('');
    setSuccessMsg('');
    setShowDevGoogleModal(false);

    try {
      // Construct a mock Google JWT Token matching OIDC claims
      const headerStr = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
      const payloadStr = JSON.stringify({
        iss: 'https://accounts.google.com',
        sub: '10987654321' + Math.floor(Math.random() * 10000),
        email: devGoogleEmail.trim(),
        email_verified: true,
        name: devGoogleEmail.trim().split('@')[0],
        picture: 'https://lh3.googleusercontent.com/a/mock-avatar',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600
      });

      // Browser-safe Base64Url encoder (replaces Buffer.from)
      const encodeBase64Url = (str) => {
        return btoa(unescape(encodeURIComponent(str)))
          .replace(/=/g, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
      };

      const mockJwt = `${encodeBase64Url(headerStr)}.${encodeBase64Url(payloadStr)}.mocksignature`;

      const res = await fetch(`${API}/auth/google-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          credential: mockJwt,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Google Sign-In simulation failed.');
      }

      setSuccessMsg('Google Single Sign-On Succeeded!');
      setTimeout(() => {
        onAuthSuccess(data);
      }, 1000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleCredentialResponse = async (response) => {
    setLoading(true);
    setError('');
    setSuccessMsg('');

    try {
      const res = await fetch(`${API}/auth/google-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          credential: response.credential,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Google Sign-In failed.');
      }

      setSuccessMsg('Google Authorization Succeeded! Syncing session...');
      setTimeout(() => {
        onAuthSuccess(data);
      }, 1200);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Fetch configured Google client ID dynamically from backend
  useEffect(() => {
    let active = true;
    fetch(`${API}/auth/google-client-id`)
      .then(res => res.json())
      .then(data => {
        if (active && data.googleClientId) {
          setGoogleClientId(data.googleClientId);
        }
      })
      .catch(err => console.warn('Failed to fetch google-client-id:', err));
    return () => { active = false; };
  }, []);

  // Graceful initialization of Google Identity Services GSI script if loaded
  // Module-level guard: only call initialize() once per unique client ID
  useEffect(() => {
    /* global google */
    if (typeof google === 'undefined' || !googleClientId) return;
    // Avoid double-init (triggers warning & breaks button render)
    if (window.__gsiInitializedClientId === googleClientId) return;
    window.__gsiInitializedClientId = googleClientId;
    try {
      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleGoogleCredentialResponse,
        auto_select: false,
      });

      const btnEl = document.getElementById('google-live-signin-btn');
      if (btnEl) {
        google.accounts.id.renderButton(btnEl, {
          theme: 'filled_black',
          size: 'large',
          width: 380,
          logo_alignment: 'left',
          shape: 'rectangular',
        });
      }

      // One Tap prompt
      google.accounts.id.prompt();
    } catch (err) {
      console.warn('Google Identity SDK initialization error:', err.message);
    }
  }, [googleClientId]); // only re-run if client ID changes — NOT on isRegister toggle

  const validateForm = () => {
    if (!username.trim() || !password) {
      setError('Please fill in all fields.');
      return false;
    }
    if (username.trim().length < 3) {
      setError('Username must be at least 3 characters long.');
      return false;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return false;
    }
    if (isRegister && password !== confirmPassword) {
      setError('Passwords do not match.');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (!validateForm()) return;

    setLoading(true);
    const endpoint = isRegister ? `${API}/auth/register` : `${API}/auth/login`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed.');
      }

      if (isRegister) {
        setSuccessMsg('Account created successfully! Logging you in...');
        setTimeout(() => {
          onAuthSuccess(data);
        }, 1500);
      } else {
        onAuthSuccess(data);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setIsRegister(!isRegister);
    setIsForgotPw(false);
    setError('');
    setSuccessMsg('');
    setPassword('');
    setConfirmPassword('');
    setTempPwSent(false);
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    if (!username.trim()) {
      setError('Please enter your username.');
      return;
    }
    setLoading(true);
    setError('');
    setSuccessMsg('');
    try {
      // Use the admin reset-password endpoint — for self-service we POST to a dedicated route
      const r = await fetch(`${API}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Request failed.');
      setTempPwSent(true);
      setSuccessMsg(d.message || 'A temporary password has been sent to your registered email.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const goToForgot = () => {
    setIsForgotPw(true);
    setIsRegister(false);
    setError('');
    setSuccessMsg('');
    setTempPwSent(false);
  };

  const goToLogin = () => {
    setIsForgotPw(false);
    setIsRegister(false);
    setError('');
    setSuccessMsg('');
    setTempPwSent(false);
  };

  return (
    <div className="login-wrapper">
      {/* Dynamic Background Glowing Orbs */}
      <div className="orb orb-1"></div>
      <div className="orb orb-2"></div>
      <div className="orb orb-3"></div>

      <div className="login-container">
        {/* Branding Panel */}
        <div className="login-brand">
          <div className="brand-logo">
            <div className="logo-symbol">⬡</div>
            <div className="logo-text-large">Boundary<span>.IQ</span></div>
          </div>
          <p className="brand-tagline">Survey Intelligence &amp; Geometry Engine</p>
          
          <div className="brand-features">
            <div className="feature-item">
              <span className="feature-icon">📐</span>
              <div>
                <h4>COGO Core</h4>
                <p>Advanced compass rule traverse closure adjustments</p>
              </div>
            </div>
            <div className="feature-item">
              <span className="feature-icon">🛰</span>
              <div>
                <h4>Deed &amp; Plat Extraction</h4>
                <p>AI-driven legal description parsing with deep analytics</p>
              </div>
            </div>
            <div className="feature-item">
              <span className="feature-icon">🔒</span>
              <div>
                <h4>Secure Workspace</h4>
                <p>Encrypted local storage and multi-user environments</p>
              </div>
            </div>
          </div>

          {/* Pricing section */}
          <div style={{ marginTop: '1.5rem' }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.4)', marginBottom: '0.75rem' }}>
              Pricing Plans
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
              {/* Free Plan */}
              <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '0.8rem' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#aaa', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Free</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff', margin: '0.2rem 0' }}>$0</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.68rem', color: 'rgba(255,255,255,0.55)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <li>✓ Traverse Compute</li>
                  <li>✓ Legal Writer</li>
                  <li>✓ 5 solves/day</li>
                </ul>
              </div>
              {/* Pro Plan */}
              <div style={{ background: 'rgba(80,200,120,0.08)', border: '1px solid rgba(80,200,120,0.3)', borderRadius: 10, padding: '0.8rem', position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', top: 0, right: 0, fontSize: '0.54rem', fontWeight: 800, background: '#50c878', color: '#000', padding: '2px 7px', borderBottomLeftRadius: 6, letterSpacing: '0.05em' }}>POPULAR</div>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#50c878', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Pro</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff', margin: '0.2rem 0' }}>$29<span style={{ fontSize: '0.65rem', fontWeight: 400, color: 'rgba(255,255,255,0.5)' }}>/mo</span></div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.68rem', color: 'rgba(255,255,255,0.7)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <li>✓ Unlimited solves</li>
                  <li>✓ Batch Deed + Plat</li>
                  <li>✓ Full Dashboard</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="brand-footer">
            BETA · v1.0.0 · Powered by GeometryEngine
          </div>
        </div>


        {/* Card Form Panel */}
        <div className="login-form-panel">
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="form-header">
              <h2>{isForgotPw ? 'Reset Password' : isRegister ? 'Create Account' : 'Welcome Back'}</h2>
              <p>{isForgotPw ? 'Enter your username to receive a temporary password' : isRegister ? 'Sign up to secure your personal survey engine' : 'Access your traverse and deed diagnostics'}</p>
            </div>

            {error && (
              <div className="alert alert-error slide-down-anim">
                <span className="alert-icon">⚠️</span>
                <span>{error}</span>
              </div>
            )}

            {successMsg && (
              <div className="alert alert-success slide-down-anim">
                <span className="alert-icon">✓</span>
                <span>{successMsg}</span>
              </div>
            )}

            {/* ── Forgot Password Mode ──────────────────────────────── */}
            {isForgotPw && (
              <div style={{ display:'flex', flexDirection:'column', gap:'1rem', marginTop:'0.5rem' }}>
                {!tempPwSent ? (
                  <form onSubmit={handleForgotPassword} style={{ display:'flex', flexDirection:'column', gap:'0.9rem' }}>
                    <div className="form-group">
                      <label className="form-label" htmlFor="forgot-username">Username</label>
                      <div className="input-with-icon">
                        <span className="input-icon">👤</span>
                        <input
                          id="forgot-username"
                          type="text"
                          placeholder="Enter your username"
                          value={username}
                          onChange={e => setUsername(e.target.value)}
                          required
                          autoComplete="username"
                          disabled={loading}
                        />
                      </div>
                    </div>
                    <button type="submit" className="btn btn-primary login-btn" disabled={loading}>
                      {loading ? <><span className="spinner"/><span>Sending…</span></> : <span>Send Temporary Password</span>}
                    </button>
                    <button type="button" className="toggle-link-btn" onClick={goToLogin} style={{ textAlign:'center' }}>
                      ← Back to Sign In
                    </button>
                  </form>
                ) : (
                  <div style={{ textAlign:'center', padding:'1rem 0' }}>
                    <div style={{ fontSize:'2.5rem', marginBottom:'0.75rem' }}>📧</div>
                    <div style={{ fontWeight:700, color:'#50c878', marginBottom:'0.5rem' }}>Email sent!</div>
                    <div style={{ fontSize:'0.82rem', color:'var(--text-muted)', marginBottom:'1.25rem', lineHeight:1.6 }}>
                      A temporary password was sent to your registered email address.
                      Log in with it and change your password in Account Settings.
                    </div>
                    <button className="btn btn-primary" style={{ justifyContent:'center', width:'100%' }} onClick={goToLogin}>
                      Back to Sign In
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── Normal Login / Register Mode ─────────────────────── */}
            {!isForgotPw && (
              <>
                {googleClientId && (
                  <div className="google-signin-wrapper" style={{ marginTop: '0.4rem', marginBottom: '0.2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', gap: '0.4rem' }}>
                    <div id="google-live-signin-btn" style={{ minHeight: 40, width: '100%' }}></div>
                    {!import.meta.env.PROD && (
                      <button type="button" className="toggle-link-btn" onClick={() => setShowDevGoogleModal(true)} style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>⚙️ Configure OAuth ID</button>
                    )}
                  </div>
                )}
                {!googleClientId && !import.meta.env.PROD && (
                  <div className="google-signin-wrapper" style={{ marginTop: '0.4rem', marginBottom: '0.2rem', display: 'flex', justifyContent: 'center', width: '100%' }}>
                    <button type="button" className="google-custom-btn" onClick={() => setShowDevGoogleModal(true)} disabled={loading} style={{ width: '100%' }}>
                      <span className="google-icon-svg" style={{ display: 'flex', alignItems: 'center' }}>
                        <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
                          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
                          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
                        </svg>
                      </span>
                      <span>Sign in with Google</span>
                    </button>
                  </div>
                )}

                {(googleClientId || !import.meta.env.PROD) && (
                  <div className="separator" style={{ display: 'flex', alignItems: 'center', margin: '0.6rem 0', width: '100%' }}>
                    <span className="separator-line" style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }}></span>
                    <span className="separator-text" style={{ padding: '0 0.75rem', fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>or sign in with password</span>
                    <span className="separator-line" style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }}></span>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label" htmlFor="username">Username</label>
                  <div className="input-with-icon">
                    <span className="input-icon">👤</span>
                    <input id="username" type="text" placeholder="Enter username" value={username} onChange={e => setUsername(e.target.value)} required autoComplete="username" disabled={loading} />
                  </div>
                </div>

                <div className="form-group">
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.35rem' }}>
                    <label className="form-label" htmlFor="password" style={{ margin:0 }}>Password</label>
                    {!isRegister && (
                      <button type="button" onClick={goToForgot} disabled={loading}
                        style={{ background:'none', border:'none', color:'var(--accent)', fontSize:'0.72rem', cursor:'pointer', padding:0, opacity:0.8 }}>
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="input-with-icon">
                    <span className="input-icon">🔑</span>
                    <input id="password" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required autoComplete={isRegister ? 'new-password' : 'current-password'} disabled={loading} />
                  </div>
                </div>

                {isRegister && (
                  <div className="form-group slide-down-anim">
                    <label className="form-label" htmlFor="confirmPassword">Confirm Password</label>
                    <div className="input-with-icon">
                      <span className="input-icon">🛡️</span>
                      <input id="confirmPassword" type="password" placeholder="••••••••" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required={isRegister} autoComplete="new-password" disabled={loading} />
                    </div>
                  </div>
                )}

                <button type="submit" className="btn btn-primary login-btn" disabled={loading}>
                  {loading ? (<><span className="spinner"></span><span>Authenticating...</span></>) : (<span>{isRegister ? 'Register & Initialize' : 'Sign In to Dashboard'}</span>)}
                </button>

                <div className="form-toggle">
                  <span>{isRegister ? 'Already have an account?' : "Don't have an account yet?"}</span>
                  <button type="button" className="toggle-link-btn" onClick={toggleMode} disabled={loading}>
                    {isRegister ? 'Sign In' : 'Create an account'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      </div>

      {/* Google Developer SSO Simulator & Settings Dialog overlay */}
      {!import.meta.env.PROD && showDevGoogleModal && (
        <div className="dev-modal-overlay">
          <div className="dev-modal-card">
            <h3>🔑 Google Sign-In Settings</h3>
            
            {/* Glassmorphic Tab Switcher */}
            <div style={{
              display: 'flex',
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              marginBottom: '0.5rem'
            }}>
              <button
                type="button"
                className={`btn btn-sm`}
                onClick={() => setDevTab('sim')}
                style={{ flex: 1, borderRadius: 'var(--radius-sm)', border: 'none', background: devTab === 'sim' ? 'var(--accent)' : 'none', color: '#fff', padding: '0.45rem', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: '0.75rem' }}
              >
                Simulator Mode
              </button>
              <button
                type="button"
                className={`btn btn-sm`}
                onClick={() => setDevTab('live')}
                style={{ flex: 1, borderRadius: 'var(--radius-sm)', border: 'none', background: devTab === 'live' ? 'var(--accent)' : 'none', color: '#fff', padding: '0.45rem', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: '0.75rem' }}
              >
                Configure Live SSO
              </button>
            </div>

            {devTab === 'sim' ? (
              <>
                <p>
                  Simulate Google single sign-on locally using a test email address. Perfect for testing SQLite storage and session logic without registering GSI Client credentials.
                </p>
                
                <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label className="form-label">Simulation Email</label>
                  <input 
                    type="email" 
                    value={devGoogleEmail} 
                    onChange={(e) => setDevGoogleEmail(e.target.value)} 
                    placeholder="e.g. surveyor@google.com"
                    required
                    style={{ width: '100%', padding: '0.55rem 0.8rem' }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                  <button 
                    type="button" 
                    className="btn btn-primary" 
                    onClick={triggerGoogleSim}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    Simulate Auth
                  </button>
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    onClick={() => setShowDevGoogleModal(false)}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  Connect a real Google OAuth 2.0 Client ID. This enables real account popup panels and validates real Google tokens directly on `localhost`.
                </p>
                
                <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label className="form-label">Google Client ID</label>
                  <input 
                    type="text" 
                    value={inputClientId} 
                    onChange={(e) => setInputClientId(e.target.value)} 
                    placeholder="e.g. 1234-abcd.apps.googleusercontent.com"
                    required
                    style={{ width: '100%', padding: '0.55rem 0.8rem', fontFamily: 'monospace', fontSize: '0.75rem' }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                  <button 
                    type="button" 
                    className="btn btn-primary" 
                    onClick={saveLiveClientId}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    Activate &amp; Save
                  </button>
                  {googleClientId && (
                    <button 
                      type="button" 
                      className="btn btn-danger" 
                      onClick={clearLiveClientId}
                      style={{ flex: 1, justifyContent: 'center' }}
                    >
                      Disable Live
                    </button>
                  )}
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    onClick={() => setShowDevGoogleModal(false)}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
