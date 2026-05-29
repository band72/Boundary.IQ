import { useState, useEffect } from 'react';
import { API } from '../config';

export default function FolderBrowserModal({ onClose, onSelect, initialPath }) {
  const [currentPath, setCurrentPath] = useState(initialPath || '');
  const [parentPath, setParentPath] = useState(null);
  const [subfolders, setSubfolders] = useState([]);
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchFolder = async (path = '') => {
    setLoading(true);
    setError('');
    setSearchQuery('');
    try {
      const url = `${API}/folderscan/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Server error ${res.status}`);
      }

      setCurrentPath(data.currentPath);
      setParentPath(data.parentPath);
      setSubfolders(data.subfolders || []);
      setRoots(data.roots || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFolder(initialPath);
  }, [initialPath]);

  // Handle keyboard escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Filter subfolders by search query
  const filteredSubfolders = subfolders.filter(folder =>
    folder.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9500,
        background: 'rgba(5, 8, 18, 0.82)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        animation: 'fadeInBrowser 0.16s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <style>{`
        @keyframes fadeInBrowser { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUpBrowser { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .folder-item {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          padding: 0.55rem 0.75rem;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text-secondary);
          cursor: pointer;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.8rem;
          text-align: left;
          transition: all 0.15s ease;
          width: 100%;
        }
        .folder-item:hover {
          background: rgba(61, 127, 255, 0.08);
          border-color: rgba(61, 127, 255, 0.35);
          color: var(--accent);
          transform: translateX(2px);
        }
        .root-pill {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: 99px;
          color: var(--text-muted);
          cursor: pointer;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.72rem;
          padding: 0.2rem 0.65rem;
          transition: all 0.15s ease;
        }
        .root-pill:hover {
          border-color: var(--accent);
          color: var(--text-primary);
        }
      `}</style>

      <div
        style={{
          width: '100%',
          maxWidth: 620,
          background: '#0f1729',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 40px rgba(61,127,255,0.06)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'slideUpBrowser 0.2s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1.1rem 1.4rem',
            borderBottom: '1px solid var(--border)',
            background: '#090e1a',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ fontSize: '1.2rem' }}>📁</span>
            <div>
              <div style={{ fontWeight: 800, color: '#e8eeff', fontSize: '0.95rem' }}>
                Server Directory Browser
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                Select a folder to process metes-and-bounds deeds
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '1rem',
              padding: '0.2rem',
            }}
            title="Close"
          >✕</button>
        </div>

        {/* Browser Content */}
        <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          {/* Current Path Indicator */}
          <div
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.6rem 0.8rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.2rem',
            }}
          >
            <span style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--accent)' }}>
              Current Directory Location
            </span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
              {currentPath || 'Loading...'}
            </span>
          </div>

          {/* Search Box to Filter Subfolders */}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type="text"
                placeholder="🔍 Search folders inside current directory..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.55rem 0.85rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.8rem',
                }}
                disabled={loading}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  style={{
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* List Area */}
          <div
            style={{
              height: '240px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(5, 8, 18, 0.3)',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.35rem',
              padding: '0.6rem',
            }}
          >
            {loading ? (
              <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', gap: '0.5rem' }}>
                <span className="spinner" style={{ width: 16, height: 16 }}></span>
                <span>Retrieving directory tree...</span>
              </div>
            ) : error ? (
              <div style={{ display: 'flex', flex: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)', padding: '1rem', textAlign: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '1.2rem' }}>⚠️</span>
                <span style={{ fontSize: '0.8rem' }}>{error}</span>
                <button onClick={() => fetchFolder(roots[0] || '')} className="btn btn-sm btn-ghost" style={{ marginTop: '0.5rem' }}>
                  Reset to Allowed Root
                </button>
              </div>
            ) : (
              <>
                {/* Back button (Up one level) */}
                {parentPath && (
                  <button onClick={() => fetchFolder(parentPath)} className="folder-item" style={{ fontStyle: 'italic', opacity: 0.85 }}>
                    <span>⬆️</span>
                    <span>.. (Parent Directory)</span>
                  </button>
                )}

                {/* Subfolder list */}
                {filteredSubfolders.length === 0 ? (
                  <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.78rem', fontStyle: 'italic', padding: '2rem' }}>
                    {searchQuery ? 'No matching folders found.' : 'No subfolders present.'}
                  </div>
                ) : (
                  filteredSubfolders.map((folder) => (
                    <button
                      key={folder}
                      onClick={() => fetchFolder(`${currentPath}/${folder}`)}
                      className="folder-item"
                    >
                      <span>📁</span>
                      <span>{folder}</span>
                    </button>
                  ))
                )}
              </>
            )}
          </div>

          {/* Root Jump Points */}
          {roots.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
                Allowed Root Directories
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {roots.map((root, i) => (
                  <button
                    key={i}
                    onClick={() => fetchFolder(root)}
                    className="root-pill"
                    title={root}
                  >
                    🏠 {root.split('/').pop() || 'Root'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '0.9rem 1.25rem',
            background: '#090e1a',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.75rem',
          }}
        >
          <button onClick={onClose} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button
            onClick={() => {
              onSelect(currentPath);
              onClose();
            }}
            className="btn btn-primary btn-sm"
            disabled={loading || !!error}
          >
            ✓ Select Folder
          </button>
        </div>
      </div>
    </div>
  );
}
