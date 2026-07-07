import { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import TraverseMap from './TraverseMap';

const WELCOME_MESSAGE = {
  role: 'ai',
  content: `Welcome to Boundary.IQ AI, your specialized surveying intelligence assistant.

I can help you:
📄 Extract bearing and distance courses from metes & bounds legal descriptions.
🛰 Analyze visual subdivision plats by uploading a JPG, PNG, or WEBP image.
📐 Compute COGO traverses and analyze linear closure precision.
🔧 Diagnose and correct misclosure errors in deeds and surveys.

Please upload a plat map image or paste a legal description below to begin.`
};

export default function ChatTab() {
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [activeTractIndex, setActiveTractIndex] = useState(0);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() && !imageFile) return;

    const userMsg = {
      role: 'user',
      content: input,
      hasImage: !!imageFile,
      imageName: imageFile ? imageFile.name : null
    };

    const fileToUpload = imageFile;
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setImageFile(null);
    setLoading(true);

    try {
      // Build history context (map roles to user/model)
      const history = messages
        .filter(m => m.content !== WELCOME_MESSAGE.content)
        .map(m => ({
          role: m.role === 'ai' ? 'model' : 'user',
          content: m.content
        }));

      const res = await api.chat.sendMessage(userMsg.content, history, fileToUpload);

      setMessages(prev => [
        ...prev,
        {
          role: 'ai',
          content: res.response,
          pipelineResult: res.pipelineResult
        }
      ]);

      if (res.pipelineResult) {
        setLastResult(res.pipelineResult);
        setActiveTractIndex(0);
      }
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          role: 'ai',
          content: `❌ Error communicating with agent: ${err.message}`
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDownloadDxf = (dxfContent, filename = 'ChatExtract.dxf') => {
    if (!dxfContent) return;
    const blob = new Blob([dxfContent], { type: 'application/dxf;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Build tracts for the TraverseMap
  const tracts = lastResult?.parcels?.map(p => ({
    name: p.parcelName,
    stations: p.stations || [],
    adjustedStations: p.adjustedStations || [],
    courses: p.courses || []
  })) || [];

  const activeTract = tracts[activeTractIndex] || {
    stations: lastResult?.stations || lastResult?.points || [],
    adjustedStations: lastResult?.adjustedStations || [],
    courses: lastResult?.courses || []
  };

  return (
    <div className="chat-layout">
      <style>{`
        .chat-layout {
          display: grid;
          grid-template-columns: 1fr 400px;
          gap: 24px;
          height: calc(100vh - 120px);
          align-items: stretch;
        }
        .chat-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: rgba(30, 41, 59, 0.25);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        }
        .chat-messages-container {
          flex: 1;
          overflow-y: auto;
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .chat-message-row {
          display: flex;
          gap: 16px;
          max-width: 85%;
        }
        .chat-message-row.user {
          align-self: flex-end;
          flex-direction: row-reverse;
        }
        .chat-message-row.ai {
          align-self: flex-start;
        }
        .chat-avatar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1rem;
          flex-shrink: 0;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        .chat-avatar.user {
          background: linear-gradient(135deg, #3b82f6, #1d4ed8);
          color: #fff;
        }
        .chat-avatar.ai {
          background: linear-gradient(135deg, #10b981, #047857);
          color: #fff;
        }
        .chat-bubble-content {
          padding: 12px 16px;
          border-radius: 12px;
          line-height: 1.6;
          font-size: 0.88rem;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
        }
        .chat-message-row.user .chat-bubble-content {
          background: #2563eb;
          color: #fff;
          border-bottom-right-radius: 4px;
        }
        .chat-message-row.ai .chat-bubble-content {
          background: rgba(30, 41, 59, 0.7);
          color: #e2e8f0;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-bottom-left-radius: 4px;
        }
        .chat-input-row {
          padding: 16px;
          background: rgba(15, 23, 42, 0.3);
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          gap: 12px;
          align-items: center;
        }
        .chat-textarea {
          flex: 1;
          background: rgba(15, 23, 42, 0.45);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #fff;
          border-radius: 10px;
          padding: 10px 14px;
          resize: none;
          font-size: 0.88rem;
          line-height: 1.4;
          transition: all 0.2s;
          height: 42px;
          outline: none;
        }
        .chat-textarea:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
        }
        .preview-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: rgba(30, 41, 59, 0.25);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        }
        .spinner-dots {
          display: inline-flex;
          gap: 4px;
          padding: 4px 8px;
        }
        .spinner-dots span {
          width: 8px;
          height: 8px;
          background: #e2e8f0;
          border-radius: 50%;
          animation: bounce 1.4s infinite both;
        }
        .spinner-dots span:nth-child(2) { animation-delay: 0.2s; }
        .spinner-dots span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }
        .lot-selector {
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          background: rgba(15, 23, 42, 0.3);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          overflow-x: auto;
        }
        .lot-chip {
          padding: 6px 12px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 20px;
          color: #94a3b8;
          font-size: 0.75rem;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.2s;
        }
        .lot-chip.active {
          background: var(--accent);
          border-color: var(--accent);
          color: #fff;
        }
        @media (max-width: 900px) {
          .chat-layout {
            grid-template-columns: 1fr;
            grid-template-rows: 1fr 350px;
            height: calc(100vh - 120px);
          }
          .chat-panel {
            height: 100%;
          }
          .preview-panel {
            height: 350px;
          }
        }
      `}</style>

      {/* Left Chat Window */}
      <div className="chat-panel">
        <div className="chat-messages-container">
          {messages.map((msg, i) => (
            <div key={i} className={`chat-message-row ${msg.role}`}>
              <div className={`chat-avatar ${msg.role}`}>
                {msg.role === 'ai' ? '⬡' : '👤'}
              </div>
              <div className="chat-bubble-content">
                {msg.hasImage && (
                  <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginBottom: '6px', fontStyle: 'italic' }}>
                    📎 Attached: {msg.imageName || 'Image'}
                  </div>
                )}
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {msg.content}
                </div>
                {msg.pipelineResult && (
                  <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                    {msg.pipelineResult.closure && (
                      <span style={{
                        fontSize: '0.75rem',
                        padding: '3px 8px',
                        background: msg.pipelineResult.closure.status === 'PASS' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                        border: `1px solid ${msg.pipelineResult.closure.status === 'PASS' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                        color: msg.pipelineResult.closure.status === 'PASS' ? '#10b981' : '#ef4444',
                        borderRadius: '4px'
                      }}>
                        Error: {msg.pipelineResult.closure.linearError?.toFixed(4)} ft
                      </span>
                    )}
                    {msg.pipelineResult.dxfContent && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleDownloadDxf(msg.pipelineResult.dxfContent)}
                        style={{ height: 'auto', padding: '4px 8px', fontSize: '0.75rem' }}
                      >
                        ⬇ Download DXF
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="chat-message-row ai">
              <div className="chat-avatar ai">⬡</div>
              <div className="chat-bubble-content" style={{ display: 'flex', alignItems: 'center' }}>
                <div className="spinner-dots">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="chat-input-row">
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp"
            hidden
            onChange={(e) => setImageFile(e.target.files[0])}
          />
          <button
            className="btn btn-ghost"
            onClick={() => fileInputRef.current?.click()}
            title="Attach plat image"
            style={{
              padding: '8px 12px',
              color: imageFile ? '#10b981' : 'var(--text-muted)'
            }}
          >
            {imageFile ? '✅ Attached' : '📎 Attach Map'}
          </button>
          <textarea
            className="chat-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question or paste a deed description..."
          />
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={loading || (!input.trim() && !imageFile)}
          >
            Send ↑
          </button>
        </div>
      </div>

      {/* Right Map Preview Panel */}
      <div className="preview-panel">
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          background: 'rgba(15, 23, 42, 0.2)'
        }}>
          <h3 style={{ margin: 0, fontSize: '0.85rem', color: '#fff', fontWeight: 600 }}>
            📐 Geometry Live Preview
          </h3>
        </div>

        {/* Multi-parcel tabs if lots present */}
        {tracts.length > 1 && (
          <div className="lot-selector">
            {tracts.map((t, idx) => (
              <div
                key={idx}
                className={`lot-chip ${activeTractIndex === idx ? 'active' : ''}`}
                onClick={() => setActiveTractIndex(idx)}
              >
                {t.name || `Parcel ${idx + 1}`}
              </div>
            ))}
          </div>
        )}

        <div style={{ flex: 1, position: 'relative', background: '#070a13' }}>
          <TraverseMap
            key={`${activeTractIndex}_${activeTract.stations?.length || 0}_${lastResult ? 1 : 0}`}
            stations={activeTract.stations || []}
            adjusted={activeTract.adjustedStations || []}
            courses={activeTract.courses || []}
            pob={{ northing: 5000, easting: 5000 }}
          />
          {!lastResult && (
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontSize: '0.8rem',
              pointerEvents: 'none',
              textAlign: 'center',
              padding: '24px'
            }}>
              Attach a plat map or paste a legal description to see the reconstructed drawing live here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
