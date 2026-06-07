import { useState, useEffect, useCallback } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { API } from '../config';

export default function SettingsTab({
  hideTraverse: propHideTraverse,
  setHideTraverse: propSetHideTraverse,
  hidePlat: propHidePlat,
  setHidePlat: propSetHidePlat,
  hideWriter: propHideWriter,
  setHideWriter: propSetHideWriter,
}) {
  // Safe fallbacks to support both standalone and prop-driven usage
  const [localHideTraverse, localSetHideTraverse] = useLocalStorage('boundaryiq_hide_traverse', false);
  const [localHidePlat, localSetHidePlat]         = useLocalStorage('boundaryiq_hide_plat', false);
  const [localHideWriter, localSetHideWriter]     = useLocalStorage('boundaryiq_hide_writer', false);

  const hideTraverse = propHideTraverse !== undefined ? propHideTraverse : localHideTraverse;
  const setHideTraverse = propSetHideTraverse || localSetHideTraverse;

  const hidePlat = propHidePlat !== undefined ? propHidePlat : localHidePlat;
  const setHidePlat = propSetHidePlat || localSetHidePlat;

  const hideWriter = propHideWriter !== undefined ? propHideWriter : localHideWriter;
  const setHideWriter = propSetHideWriter || localSetHideWriter;
  const [concurrentAgents, setConcurrentAgents] = useLocalStorage('boundaryiq_concurrent_agents', 5);
  const [parallelBatches, setParallelBatches]   = useLocalStorage('boundaryiq_parallel_batches', 1);
  const [maxFileSize, setMaxFileSize]           = useLocalStorage('boundaryiq_max_file_size', 51);
  const [retentionDays, setRetentionDays]       = useLocalStorage('boundaryiq_retention_days', 90);
  const [autoOutput, setAutoOutput]             = useLocalStorage('boundaryiq_auto_output', true);
  const [shortFileNames, setShortFileNames]     = useLocalStorage('boundaryiq_short_file_names', true);
  const [showConceptualDetail, setShowConceptualDetail] = useLocalStorage('boundaryiq_show_conceptual_detail', true);

  // Database stats
  const [dbStats, setDbStats]       = useState(null);
  const [dbLoading, setDbLoading]   = useState(false);
  const [dbMessage, setDbMessage]   = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  // Server system configurations state
  const [systemDbPath, setSystemDbPath] = useState('');
  const [systemScanRoots, setSystemScanRoots] = useState('');
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemMsg, setSystemMsg] = useState('');

  // ── AI Model Provider state ────────────────────────────────────
  const [modelConfig, setModelConfig]   = useState(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelMsg, setModelMsg]         = useState('');
  const [switchingTo, setSwitchingTo]   = useState(null);
  const [startingOllama, setStartingOllama] = useState(false);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useLocalStorage('boundaryiq_openai_base_url', 'http://127.0.0.1:11434/v1');

  // API Keys state
  const [geminiKey, setGeminiKey] = useLocalStorage('boundaryiq_gemini_key', '');
  const [openaiKey, setOpenaiKey] = useLocalStorage('boundaryiq_openai_key', '');
  const [saveKeysLoading, setSaveKeysLoading] = useState(false);
  const [keysMsg, setKeysMsg] = useState('');

  // Dropdown selectors state
  const [selectedVendor, setSelectedVendor] = useState('gemini');
  const [selectedModel, setSelectedModel] = useState('gemini-3.5-flash');
  const [allowApiFallback, setAllowApiFallback] = useState(true);

  const saveKeysToBackend = async (gKey, oKey, silent = false) => {
    if (!silent) setSaveKeysLoading(true);
    try {
      const res = await fetch(`${API}/settings/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiApiKey: gKey, openAiApiKey: oKey }),
      });
      const data = await res.json();
      if (res.ok) {
        if (!silent) setKeysMsg('✓ API keys saved and loaded on server memory.');
        fetchModelConfig();
      } else {
        if (!silent) setKeysMsg(`✗ Error: ${data.error}`);
      }
    } catch (e) {
      if (!silent) setKeysMsg(`✗ Connection Error: ${e.message}`);
    } finally {
      if (!silent) setSaveKeysLoading(false);
    }
  };

  // Sync dropdown selectors with active config on load
  useEffect(() => {
    if (modelConfig) {
      setSelectedVendor(modelConfig.activeProvider || 'gemini');
      setSelectedModel(modelConfig.activeModel || 'gemini-3.5-flash');
      if (modelConfig.allowApiFallback !== undefined) {
        setAllowApiFallback(modelConfig.allowApiFallback);
      }
    }
  }, [modelConfig]);

  // Load API keys to backend on mount
  useEffect(() => {
    if (geminiKey || openaiKey) {
      saveKeysToBackend(geminiKey, openaiKey, true);
    }
  }, []);

  const fetchModelConfig = useCallback(async () => {
    setModelLoading(true);
    try {
      const res = await fetch(`${API}/settings/model`);
      if (res.ok) setModelConfig(await res.json());
    } catch (e) {
      console.error('Failed to fetch model config:', e);
    } finally {
      setModelLoading(false);
    }
  }, []);

  const switchModel = async (provider, model) => {
    setSwitchingTo(`${provider}/${model}`);
    setModelLoading(true); setModelMsg('');
    try {
      const body = { provider, model, allowApiFallback };
      if (provider === 'openai') body.openaiBaseUrl = openaiBaseUrl;
      const res = await fetch(`${API}/settings/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setModelMsg(`✓ ${data.message}`);
        fetchModelConfig();
      } else {
        setModelMsg(`✗ ${data.error}`);
      }
    } catch (e) { setModelMsg(`✗ ${e.message}`); }
    finally { setModelLoading(false); setSwitchingTo(null); }
  };

  const toggleAllowApiFallback = async (newValue) => {
    setAllowApiFallback(newValue);
    if (!modelConfig) return;
    try {
      const body = { 
        provider: modelConfig.activeProvider, 
        model: modelConfig.activeModel, 
        allowApiFallback: newValue 
      };
      if (modelConfig.activeProvider === 'openai') {
        body.openaiBaseUrl = openaiBaseUrl;
      }
      const res = await fetch(`${API}/settings/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        fetchModelConfig();
      } else {
        setModelMsg(`✗ Failed to update fallback: ${data.error}`);
      }
    } catch (e) {
      setModelMsg(`✗ Fallback Connection Error: ${e.message}`);
    }
  };

  const startOllama = async () => {
    setStartingOllama(true);
    setModelMsg('⏳ Starting Ollama…');
    try {
      const res = await fetch(`${API}/settings/ollama/start`, { method: 'POST' });
      const data = await res.json();
      if (data.started) {
        setModelMsg(`✓ ${data.message}`);
        fetchModelConfig();
      } else if (data.error) {
        // Not up yet — poll every 2s up to 15s
        setModelMsg('⏳ Waiting for Ollama to initialize…');
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          const s = await fetch(`${API}/settings/ollama/status`).then(r => r.json()).catch(() => ({}));
          if (s.online) {
            clearInterval(poll);
            setModelMsg(`✓ Ollama is online — ${s.models?.length || 0} model(s) ready.`);
            setStartingOllama(false);
            fetchModelConfig();
          } else if (attempts >= 8) {
            clearInterval(poll);
            setModelMsg(`✗ Ollama did not start in time. Try running 'ollama serve' in a terminal.`);
            setStartingOllama(false);
          }
        }, 2000);
        return; // don't set startingOllama=false here, poll will do it
      } else {
        setModelMsg(`✓ ${data.message}`);
        fetchModelConfig();
      }
    } catch (e) {
      setModelMsg(`✗ ${e.message}`);
    }
    setStartingOllama(false);
  };

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/diagnostics/stats`);
      if (res.ok) setDbStats(await res.json());
    } catch (e) { console.error('Failed to fetch DB stats:', e); }
  }, []);

  const fetchSystemSettings = useCallback(async () => {
    setSystemLoading(true);
    try {
      const res = await fetch(`${API}/settings/system`);
      if (res.ok) {
        const data = await res.json();
        setSystemDbPath(data.dbPath || '');
        setSystemScanRoots(data.rawScanRoots || '');
      }
    } catch (e) {
      console.error('Failed to fetch system settings:', e);
    } finally {
      setSystemLoading(false);
    }
  }, []);

  const saveSystemSettings = async () => {
    setSystemLoading(true);
    setSystemMsg('');
    try {
      const res = await fetch(`${API}/settings/system`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbPath: systemDbPath, scanRoots: systemScanRoots }),
      });
      const data = await res.json();
      if (res.ok) {
        setSystemMsg('✓ Server database and scan settings updated successfully in memory and persisted.');
        fetchSystemSettings();
        fetchStats();
      } else {
        setSystemMsg(`✗ Error: ${data.error}`);
      }
    } catch (e) {
      setSystemMsg(`✗ Connection Error: ${e.message}`);
    } finally {
      setSystemLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { 
    fetchStats(); 
    fetchModelConfig(); 
    fetchSystemSettings();
  }, [fetchStats, fetchModelConfig, fetchSystemSettings]);

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

  // ── Helper: provider color + icon ──────────────────────────────
  const providerMeta = {
    gemini: { color: '#4285F4', icon: '☁️', gradient: 'linear-gradient(135deg, #4285F4 0%, #8AB4F8 100%)', label: 'Cloud' },
    ollama: { color: '#00d4a8', icon: '🖥️', gradient: 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)', label: 'Local' },
    openai: { color: '#a855f7', icon: '🔌', gradient: 'linear-gradient(135deg, #a855f7 0%, #7c3aed 100%)', label: 'Compat' },
  };

  // isOllamaOffline is derived below inline where needed

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

      {/* ── AI Model Provider Section ──────────────────────────────── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(66, 133, 244, 0.3)',
        boxShadow: '0 4px 24px rgba(66, 133, 244, 0.1)',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              🧠 AI Model Provider
            </div>
            <button className="btn btn-ghost btn-sm" onClick={fetchModelConfig} style={{ fontSize: '0.72rem' }}>↻ Refresh</button>
          </div>
        </div>

        {/* Dynamic Card-level Shimmer Progress Bar */}
        {(modelLoading || startingOllama) && (
          <div className="progress-bar-container">
            <div className="progress-bar-fill" />
          </div>
        )}

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {startingOllama && (
            <div className="alert alert-info" style={{ animation: 'slideDown 0.2s ease', display: 'flex', alignItems: 'center' }}>
              <span className="spinner" style={{ width: 14, height: 14, marginRight: '0.6rem', flexShrink: 0 }} />
              <span><strong>Server Initialization in Progress:</strong> Spawning local Ollama backend & loading system drivers...</span>
            </div>
          )}

          {!modelConfig && modelLoading && (
            <div className="alert alert-info" style={{ animation: 'slideDown 0.2s ease', display: 'flex', alignItems: 'center' }}>
              <span className="spinner" style={{ width: 14, height: 14, marginRight: '0.6rem', flexShrink: 0 }} />
              <span><strong>Loading AI Model Configurations:</strong> Probing local and cloud LLM providers...</span>
            </div>
          )}

          {/* Active Model Badge */}
          {modelConfig && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
            }}>
              <div style={{
                background: providerMeta[modelConfig.activeProvider]?.gradient || 'var(--bg-elevated)',
                padding: '0.5rem 1.2rem',
                borderRadius: '99px',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                boxShadow: `0 0 20px ${providerMeta[modelConfig.activeProvider]?.color || '#fff'}33`,
              }}>
                <span style={{ fontSize: '1rem' }}>{providerMeta[modelConfig.activeProvider]?.icon}</span>
                <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '-0.01em' }}>
                  {modelConfig.activeModel}
                </span>
              </div>
              <span style={{
                fontSize: '0.72rem',
                color: providerMeta[modelConfig.activeProvider]?.color,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}>
                {providerMeta[modelConfig.activeProvider]?.label} · Active
              </span>
            </div>
          )}

          {/* Ollama Status */}
          {modelConfig && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '0.6rem 1rem',
              background: modelConfig.ollama.online ? 'rgba(0, 212, 168, 0.06)' : 'rgba(220, 50, 50, 0.06)',
              border: `1px solid ${modelConfig.ollama.online ? 'rgba(0, 212, 168, 0.25)' : 'rgba(220, 50, 50, 0.25)'}`,
              borderRadius: 'var(--radius-md)',
              fontSize: '0.78rem',
              flexWrap: 'wrap',
            }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                background: modelConfig.ollama.online ? '#00d4a8' : '#dc3232',
                boxShadow: modelConfig.ollama.online ? '0 0 8px #00d4a8' : '0 0 8px #dc3232',
                animation: modelConfig.ollama.online ? 'pulse 2s infinite' : 'none',
              }} />
              <span style={{ color: modelConfig.ollama.online ? 'var(--success)' : '#dc3232', fontWeight: 600 }}>
                Ollama {modelConfig.ollama.online ? 'Online' : 'Offline'}
              </span>
              {modelConfig.ollama.online && (
                <span style={{ color: 'var(--text-muted)' }}>
                  · {modelConfig.ollama.modelCount} model{modelConfig.ollama.modelCount !== 1 ? 's' : ''} · {modelConfig.ollama.url}
                </span>
              )}
              {!modelConfig.ollama.online && modelConfig.ollama.error && (
                <span style={{ color: 'var(--text-muted)', flex: 1 }}>
                  · {modelConfig.ollama.error}
                </span>
              )}
              {!modelConfig.ollama.online && (
                <button
                  onClick={startOllama}
                  disabled={startingOllama}
                  style={{
                    marginLeft: 'auto',
                    padding: '0.3rem 0.85rem',
                    background: startingOllama
                      ? 'rgba(0,212,168,0.08)'
                      : 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)',
                    border: '1px solid rgba(0,212,168,0.5)',
                    borderRadius: '99px',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: '0.72rem',
                    cursor: startingOllama ? 'wait' : 'pointer',
                    letterSpacing: '0.04em',
                    transition: 'all 0.2s',
                    boxShadow: startingOllama ? 'none' : '0 0 12px rgba(0,212,168,0.3)',
                    animation: startingOllama ? 'pulse 1s infinite' : 'none',
                  }}
                >
                  {startingOllama ? '⏳ Starting…' : '▶ Start Ollama'}
                </button>
              )}
            </div>
          )}

          {/* API Keys Configuration Section */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}>
            <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '0.2rem' }}>
              <span>🔑</span> API Keys & Credentials
            </div>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              {/* Gemini Key Input */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '240px' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Google Gemini API Key
                </label>
                <input
                  type="password"
                  placeholder="Paste your Gemini API Key here (starts with AIza...)"
                  value={geminiKey}
                  onChange={(e) => { setGeminiKey(e.target.value); setKeysMsg(''); }}
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.55rem 0.85rem',
                    color: 'var(--text-primary)',
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                  }}
                />
              </div>
              {/* OpenAI Key Input */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '240px' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  OpenAI / Compatible API Key (optional)
                </label>
                <input
                  type="password"
                  placeholder="Paste OpenAI API Key here (starts with sk-...)"
                  value={openaiKey}
                  onChange={(e) => { setOpenaiKey(e.target.value); setKeysMsg(''); }}
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.55rem 0.85rem',
                    color: 'var(--text-primary)',
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginTop: '0.2rem' }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                🔒 Credentials are saved securely in your browser and automatically loaded to server memory on startup.
              </span>
              <button
                onClick={() => saveKeysToBackend(geminiKey, openaiKey)}
                disabled={saveKeysLoading}
                className="btn btn-primary"
                style={{
                  padding: '0.55rem 1.25rem',
                  fontSize: '0.78rem',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                {saveKeysLoading ? '⏳ Saving…' : '💾 Save API Keys'}
              </button>
            </div>

            {keysMsg && (
              <div style={{
                padding: '0.45rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                background: keysMsg.startsWith('✓') ? 'rgba(0,212,168,0.08)' : 'rgba(220,50,50,0.1)',
                border: `1px solid ${keysMsg.startsWith('✓') ? 'rgba(0,212,168,0.25)' : 'rgba(220,50,50,0.25)'}`,
                color: keysMsg.startsWith('✓') ? 'var(--success)' : '#dc3232',
                fontSize: '0.75rem',
                fontWeight: 500,
              }}>
                {keysMsg}
              </div>
            )}
          </div>

          {/* Model & Vendor Dropdown Selector */}
          {modelConfig && (
            <div style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '1.25rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              marginTop: '0.2rem',
            }}>
              <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '0.2rem' }}>
                <span>🤖</span> Vendor & Model Selector
              </div>
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {/* Vendor Dropdown */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '200px' }}>
                  <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Select Vendor</label>
                  <select
                    value={selectedVendor}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSelectedVendor(v);
                      const firstModel = modelConfig?.availableModels.find(m => m.provider === v)?.id || '';
                      setSelectedModel(firstModel);
                    }}
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.55rem 0.85rem',
                      color: 'var(--text-primary)',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                      height: '38px',
                    }}
                  >
                    <option value="gemini">☁️ Google Gemini (Cloud)</option>
                    <option value="ollama">🖥️ Ollama (Local/Offline)</option>
                    <option value="openai">🔌 OpenAI-Compatible (Custom Endpoint)</option>
                  </select>
                </div>

                {/* Model Dropdown */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1.5, minWidth: '240px' }}>
                  <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Select Model</label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.55rem 0.85rem',
                      color: 'var(--text-primary)',
                      fontSize: '0.8rem',
                      fontFamily: 'JetBrains Mono, monospace',
                      cursor: 'pointer',
                      height: '38px',
                    }}
                  >
                    {modelConfig?.availableModels
                      .filter(m => m.provider === selectedVendor)
                      .map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.id})
                        </option>
                      ))
                    }
                    {selectedVendor === 'openai' && modelConfig?.availableModels.filter(m => m.provider === 'openai').length === 0 && (
                      <option value="llama3">Default Llama 3 (compat)</option>
                    )}
                  </select>
                </div>

                {/* Switch button */}
                <button
                  className="btn btn-primary"
                  disabled={modelLoading || !selectedModel || (modelConfig?.activeProvider === selectedVendor && modelConfig?.activeModel === selectedModel)}
                  onClick={() => {
                    if (selectedVendor === 'ollama' && !modelConfig?.ollama?.online) {
                      startOllama();
                    } else {
                      switchModel(selectedVendor, selectedModel);
                    }
                  }}
                  style={{
                    height: '38px',
                    padding: '0 1.5rem',
                    background: providerMeta[selectedVendor]?.gradient || 'var(--accent)',
                    borderColor: 'transparent',
                    boxShadow: `0 0 14px ${providerMeta[selectedVendor]?.color || 'var(--accent)'}22`,
                    borderRadius: 'var(--radius-sm)',
                    fontWeight: 700,
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                  }}
                >
                  {switchingTo ? '⏳ Switching…' : '✓ Switch AI Driver'}
                </button>
              </div>

              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.85rem 1.2rem',
                marginTop: '0.75rem',
                background: !allowApiFallback ? 'rgba(255,255,255,0.01)' : 'rgba(0, 212, 168, 0.03)',
                border: `1px solid ${!allowApiFallback ? 'var(--border)' : 'rgba(0, 212, 168, 0.25)'}`,
                borderRadius: 'var(--radius-md)',
                transition: 'all 0.3s ease',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ fontSize: '1.2rem' }}>🔄</span>
                  <div>
                    <div style={{ fontWeight: 600, color: !allowApiFallback ? 'var(--text-muted)' : '#e8eeff', fontSize: '0.85rem' }}>
                      Smart API Fallback to Local Ollama
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                      Automatically fallback from Gemini to local Ollama on API quota failures or service interruptions
                    </div>
                  </div>
                </div>

                <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={allowApiFallback}
                    onChange={e => toggleAllowApiFallback(e.target.checked)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                  />
                  <div style={{
                    width: '40px', height: '20px', borderRadius: '10px',
                    background: allowApiFallback ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)' : 'rgba(255,255,255,0.1)',
                    border: `1px solid ${allowApiFallback ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
                    position: 'relative', transition: 'all 0.25s ease',
                    boxShadow: allowApiFallback ? '0 0 10px rgba(0, 212, 168, 0.3)' : 'none',
                  }}>
                    <div style={{
                      width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: '2px', left: allowApiFallback ? '22px' : '3px',
                      transition: 'left 0.25s ease',
                    }} />
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Status message */}
          {modelMsg && (
            <div style={{
              padding: '0.5rem 0.85rem', borderRadius: 'var(--radius-sm)',
              background: modelMsg.startsWith('✓') ? 'rgba(0,212,168,0.08)' : 'rgba(220,50,50,0.1)',
              border: `1px solid ${modelMsg.startsWith('✓') ? 'rgba(0,212,168,0.3)' : 'rgba(220,50,50,0.3)'}`,
              color: modelMsg.startsWith('✓') ? 'var(--success)' : '#dc3232',
              fontSize: '0.78rem', fontWeight: 500,
              transition: 'all 0.3s ease',
            }}>
              {modelMsg}
            </div>
          )}

          {/* OpenAI-Compat Status Row */}
          {modelConfig?.openaiCompat && (
            <div style={{
              display: 'flex', alignItems: 'center',
              padding: '0.6rem 1rem',
              background: modelConfig.openaiCompat.online ? 'rgba(168,85,247,0.06)' : 'rgba(100,100,120,0.06)',
              border: `1px solid ${modelConfig.openaiCompat.online ? 'rgba(168,85,247,0.25)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)',
              fontSize: '0.78rem',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                background: modelConfig.openaiCompat.online ? '#a855f7' : 'var(--text-muted)',
                boxShadow: modelConfig.openaiCompat.online ? '0 0 8px #a855f7' : 'none',
              }} />
              <span style={{ color: modelConfig.openaiCompat.online ? '#a855f7' : 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>
                🔌 OpenAI-Compat {modelConfig.openaiCompat.online ? `Online · ${modelConfig.openaiCompat.modelCount} model(s)` : 'Offline'}
              </span>
              <input
                type="text"
                value={openaiBaseUrl}
                onChange={e => setOpenaiBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:11434/v1"
                style={{
                  flex: 1, minWidth: '200px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.25rem 0.6rem',
                  color: 'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '0.72rem',
                }}
                onKeyDown={e => e.key === 'Enter' && fetchModelConfig()}
              />
              <button
                onClick={fetchModelConfig}
                style={{
                  padding: '0.3rem 0.75rem',
                  background: 'rgba(168,85,247,0.12)',
                  border: '1px solid rgba(168,85,247,0.35)',
                  borderRadius: '99px',
                  color: '#a855f7',
                  fontWeight: 700,
                  fontSize: '0.7rem',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                ↻ Probe
              </button>
            </div>
          )}

          {/* Provider Info */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '0.85rem 1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span>💡</span> Provider Information
            </div>
            <div>
              • <strong style={{ color: '#4285F4' }}>Gemini (Cloud)</strong> — Google's multimodal API. Requires API key. Best accuracy for plat image extraction.
            </div>
            <div>
              • <strong style={{ color: '#00d4a8' }}>Ollama (Local)</strong> — Run models locally. No API key. No data leaves your machine. Start with <code style={{ fontSize: '0.7rem', color: 'var(--accent)', background: 'rgba(61,127,255,0.08)', padding: '1px 5px', borderRadius: '3px' }}>ollama serve</code>.
            </div>
            <div>
              • <strong style={{ color: '#a855f7' }}>OpenAI-Compat (🔌)</strong> — Any <code style={{ fontSize: '0.7rem', color: 'var(--accent)', background: 'rgba(61,127,255,0.08)', padding: '1px 5px', borderRadius: '3px' }}>/v1/chat/completions</code> endpoint: LM Studio, llama.cpp, vLLM, or Ollama's v1 API.
            </div>
            <div>
              • Pull new models: <code style={{ fontSize: '0.7rem', color: 'var(--accent)', background: 'rgba(61,127,255,0.08)', padding: '1px 5px', borderRadius: '3px' }}>ollama pull gemma4</code> or <code style={{ fontSize: '0.7rem', color: 'var(--accent)', background: 'rgba(61,127,255,0.08)', padding: '1px 5px', borderRadius: '3px' }}>ollama pull llava</code>
            </div>
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

            {(modelConfig?.activeProvider === 'ollama' || modelConfig?.activeProvider === 'openai') && concurrentAgents > 1 && (
              <div className="alert alert-error" style={{ marginTop: '0.75rem', animation: 'slideDown 0.2s ease', fontSize: '0.78rem', padding: '0.6rem 0.85rem' }}>
                ⚠️ <strong>Local LLM Performance Notice:</strong> Concurrency of {concurrentAgents} parallel requests will exceed standard local CPU/GPU capability, causing slow prompt processing, OOM crashes, or timeouts. The system will automatically run these requests sequentially (concurrency capped to 1) to ensure stability.
              </div>
            )}
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
              <strong style={{ color: '#c97a00' }}>{parallelBatches * concurrentAgents} simultaneous {modelConfig?.activeProvider === 'ollama' ? 'Ollama' : 'Gemini'} requests</strong>.
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

      {/* ── Sidebar Navigation Customization ────────────────────────────── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            🖥️ Sidebar Navigation Customization
          </div>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Toggle the visibility of specific tools in the sidebar menu. Hidden tools remain fully operational via internal shortcuts but are hidden from the primary navigation interface.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginTop: '0.25rem' }}>
            {/* Toggle Traverse */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.85rem 1.2rem',
              background: hideTraverse ? 'rgba(255,255,255,0.02)' : 'rgba(61,127,255,0.04)',
              border: `1px solid ${hideTraverse ? 'var(--border)' : 'rgba(61,127,255,0.25)'}`,
              borderRadius: 'var(--radius-md)',
              transition: 'all 0.3s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '1.2rem' }}>📐</span>
                <div>
                  <div style={{ fontWeight: 600, color: hideTraverse ? 'var(--text-muted)' : '#e8eeff', fontSize: '0.85rem' }}>
                    Traverse Compute Tab
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    Manual coordinate entry & closure analysis
                  </div>
                </div>
              </div>
              
              <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!hideTraverse}
                  onChange={e => setHideTraverse(!e.target.checked)}
                  style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                />
                <div style={{
                  width: '40px', height: '20px', borderRadius: '10px',
                  background: !hideTraverse ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)' : 'rgba(255,255,255,0.1)',
                  border: `1px solid ${!hideTraverse ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
                  position: 'relative', transition: 'all 0.25s ease',
                  boxShadow: !hideTraverse ? '0 0 10px rgba(0, 212, 168, 0.3)' : 'none',
                }}>
                  <div style={{
                    width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: '2px', left: !hideTraverse ? '22px' : '3px',
                    transition: 'left 0.25s ease',
                  }} />
                </div>
              </label>
            </div>

            {/* Toggle Plat Extraction */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.85rem 1.2rem',
              background: hidePlat ? 'rgba(255,255,255,0.02)' : 'rgba(0,212,168,0.03)',
              border: `1px solid ${hidePlat ? 'var(--border)' : 'rgba(0,212,168,0.25)'}`,
              borderRadius: 'var(--radius-md)',
              transition: 'all 0.3s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '1.2rem' }}>🛰️</span>
                <div>
                  <div style={{ fontWeight: 600, color: hidePlat ? 'var(--text-muted)' : '#e8eeff', fontSize: '0.85rem' }}>
                    Plat Extraction Tab
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    AI-powered OCR for boundary images and PDFs
                  </div>
                </div>
              </div>

              <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!hidePlat}
                  onChange={e => setHidePlat(!e.target.checked)}
                  style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                />
                <div style={{
                  width: '40px', height: '20px', borderRadius: '10px',
                  background: !hidePlat ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)' : 'rgba(255,255,255,0.1)',
                  border: `1px solid ${!hidePlat ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
                  position: 'relative', transition: 'all 0.25s ease',
                  boxShadow: !hidePlat ? '0 0 10px rgba(0, 212, 168, 0.3)' : 'none',
                }}>
                  <div style={{
                    width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: '2px', left: !hidePlat ? '22px' : '3px',
                    transition: 'left 0.25s ease',
                  }} />
                </div>
              </label>
            </div>

            {/* Toggle Writer */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.85rem 1.2rem',
              background: hideWriter ? 'rgba(255,255,255,0.02)' : 'rgba(168,85,247,0.04)',
              border: `1px solid ${hideWriter ? 'var(--border)' : 'rgba(168,85,247,0.25)'}`,
              borderRadius: 'var(--radius-md)',
              transition: 'all 0.3s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '1.2rem' }}>✍️</span>
                <div>
                  <div style={{ fontWeight: 600, color: hideWriter ? 'var(--text-muted)' : '#e8eeff', fontSize: '0.85rem' }}>
                    Legal Description Writer Tab
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    Generate professional registry legal text
                  </div>
                </div>
              </div>

              <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!hideWriter}
                  onChange={e => setHideWriter(!e.target.checked)}
                  style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                />
                <div style={{
                  width: '40px', height: '20px', borderRadius: '10px',
                  background: !hideWriter ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)' : 'rgba(255,255,255,0.1)',
                  border: `1px solid ${!hideWriter ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
                  position: 'relative', transition: 'all 0.25s ease',
                  boxShadow: !hideWriter ? '0 0 10px rgba(0, 212, 168, 0.3)' : 'none',
                }}>
                  <div style={{
                    width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: '2px', left: !hideWriter ? '22px' : '3px',
                    transition: 'left 0.25s ease',
                  }} />
                </div>
              </label>
            </div>
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

          <div style={{
            height: '1px',
            background: 'var(--border)',
            margin: '0.25rem 0'
          }} />

          {/* Short File Names Toggle */}
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
                checked={shortFileNames}
                onChange={e => setShortFileNames(e.target.checked)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
              <div style={{
                width: '44px',
                height: '24px',
                borderRadius: '12px',
                background: shortFileNames
                  ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)'
                  : 'rgba(255,255,255,0.1)',
                border: `1px solid ${shortFileNames ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
                position: 'relative',
                transition: 'all 0.3s ease',
                boxShadow: shortFileNames ? '0 0 12px rgba(0, 212, 168, 0.3)' : 'none',
              }}>
                <div style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  background: '#fff',
                  position: 'absolute',
                  top: '2px',
                  left: shortFileNames ? '22px' : '3px',
                  transition: 'left 0.3s ease',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                }} />
              </div>
            </label>

            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem', marginBottom: '0.35rem' }}>
                Use Short File Names
              </div>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                When enabled, outputs are saved with simple standardized names (Map, OCR, Summary, Cogo, Script, DXF) inside a folder named after the deed, rather than using the deed's filename as a prefix.
              </p>
            </div>
          </div>

          <div style={{
            height: '1px',
            background: 'var(--border)',
            margin: '0.25rem 0'
          }} />

          {/* Conceptual Detail Toggle */}
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
                checked={showConceptualDetail}
                onChange={e => setShowConceptualDetail(e.target.checked)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
              <div style={{
                width: '44px',
                height: '24px',
                borderRadius: '12px',
                background: showConceptualDetail
                  ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)'
                  : 'rgba(255,255,255,0.1)',
                border: `1px solid ${showConceptualDetail ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
                position: 'relative',
                transition: 'all 0.3s ease',
                boxShadow: showConceptualDetail ? '0 0 12px rgba(0, 212, 168, 0.3)' : 'none',
              }}>
                <div style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  background: '#fff',
                  position: 'absolute',
                  top: '2px',
                  left: showConceptualDetail ? '22px' : '3px',
                  transition: 'left 0.3s ease',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                }} />
              </div>
            </label>

            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem', marginBottom: '0.35rem' }}>
                Add Conceptual Details to Maps
              </div>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                When enabled, metes-and-bounds survey check plots will automatically overlay conceptual detail backdrops including neighboring lots, a bottom roadway with street name, utility easements, and inline course dimensions.
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
            <div>• <strong style={{ color: 'var(--text-primary)' }}>Per deed:</strong> <code style={{ fontSize: '0.72rem' }}>_corrected.txt</code> + <code style={{ fontSize: '0.72rem' }}>_ocr.txt</code> + <code style={{ fontSize: '0.72rem' }}>_summary.json</code></div>
            <div>• <strong style={{ color: 'var(--text-primary)' }}>Batch summary:</strong> <code style={{ fontSize: '0.72rem' }}>_BATCH_SUMMARY.json</code> with pass/fail stats</div>
            <div>• <strong style={{ color: 'var(--text-primary)' }}>Location:</strong> Created inside the scanned source folder</div>
          </div>
        </div>
      </div>

      {/* ── Server Database & File System Configuration ── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(61, 127, 255, 0.3)',
        boxShadow: '0 4px 24px rgba(61, 127, 255, 0.1)',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              🗄️ Server Database & File System Configuration
            </div>
            <button className="btn btn-ghost btn-sm" onClick={fetchSystemSettings} style={{ fontSize: '0.72rem' }}>↻ Refresh</button>
          </div>
        </div>

        {systemLoading && (
          <div className="progress-bar-container">
            <div className="progress-bar-fill" />
          </div>
        )}

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Configure and mutate server-side host configurations. These settings direct server memory paths on the production node and are persisted in <code style={{ fontSize: '0.75rem', color: 'var(--accent)' }}>.env</code> configurations.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Database Path Input */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                📁 Production SQLite Database Path
              </label>
              <input
                type="text"
                value={systemDbPath}
                onChange={e => setSystemDbPath(e.target.value)}
                placeholder="/absolute/path/to/BoundaryQCDiagnostics.db"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.55rem 0.85rem',
                  color: 'var(--text-primary)',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                }}
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                The physical path to the Diagnostics database. Changing this will dynamically close the active connection, open/create the SQLite database at the new location, and run all required database migrations.
              </span>
            </div>

            {/* Allowed Roots Input */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                🛡️ Allowed File Scan Roots (Semicolon-Separated)
              </label>
              <input
                type="text"
                value={systemScanRoots}
                onChange={e => setSystemScanRoots(e.target.value)}
                placeholder="/home/user/allowed-folder;/var/data"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.55rem 0.85rem',
                  color: 'var(--text-primary)',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                }}
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Authorized search paths for the local host file scanner, separated by semicolons (e.g. <code style={{ fontSize: '0.65rem' }}>/home/user/project1;/var/docs</code>). Directory paths outside these scopes cannot be traversed for security.
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              🔒 These modifications apply instantly in production memory and write to server config files.
            </span>
            <button
              onClick={saveSystemSettings}
              disabled={systemLoading}
              className="btn btn-primary"
              style={{
                padding: '0.55rem 1.25rem',
                fontSize: '0.78rem',
                borderRadius: 'var(--radius-sm)',
                background: 'linear-gradient(135deg, #0070f3 0%, #00a4ff 100%)',
                border: 'none',
                boxShadow: '0 0 12px rgba(0, 112, 243, 0.3)',
              }}
            >
              {systemLoading ? '⏳ Saving…' : '💾 Persist Server Configuration'}
            </button>
          </div>

          {systemMsg && (
            <div style={{
              padding: '0.45rem 0.75rem',
              borderRadius: 'var(--radius-sm)',
              background: systemMsg.startsWith('✓') ? 'rgba(0,212,168,0.08)' : 'rgba(220,50,50,0.1)',
              border: `1px solid ${systemMsg.startsWith('✓') ? 'rgba(0,212,168,0.25)' : 'rgba(220,50,50,0.25)'}`,
              color: systemMsg.startsWith('✓') ? 'var(--success)' : '#dc3232',
              fontSize: '0.75rem',
              fontWeight: 500,
              marginTop: '0.5rem'
            }}>
              {systemMsg}
            </div>
          )}
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
                type="range" min="0" max="365" value={retentionDays}
                onChange={e => setRetentionDays(parseInt(e.target.value))}
                style={{ flex: 1, accentColor: 'var(--accent)', height: '6px', borderRadius: '3px', outline: 'none', cursor: 'pointer' }}
              />
              <input
                type="number" min="0" max="365" value={retentionDays}
                onChange={e => {
                  let val = parseInt(e.target.value);
                  if (isNaN(val)) val = 90;
                  if (val < 0) val = 0;
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
