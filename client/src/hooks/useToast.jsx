import { useState, useCallback, useRef } from 'react';

/**
 * Lightweight toast notification hook.
 * Usage:
 *   const { toast, showToast, ToastPortal } = useToast();
 *   <button onClick={() => showToast('Copied!')}>Copy</button>
 *   <ToastPortal />
 */
export function useToast(durationMs = 2200) {
  const [toast, setToast] = useState(null);    // { message, type }
  const timerRef = useRef(null);

  const showToast = useCallback((message, type = 'success') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type });
    timerRef.current = setTimeout(() => setToast(null), durationMs);
  }, [durationMs]);

  /** Drop <ToastPortal /> anywhere in your render tree — it renders at fixed bottom-right. */
  function ToastPortal() {
    if (!toast) return null;
    const colors = {
      success: { bg: 'rgba(0, 212, 168, 0.12)', border: 'rgba(0, 212, 168, 0.4)', text: '#00d4a8' },
      error:   { bg: 'rgba(220, 50, 50, 0.12)',  border: 'rgba(220, 50, 50, 0.4)',  text: '#f87171' },
      info:    { bg: 'rgba(66, 133, 244, 0.12)', border: 'rgba(66, 133, 244, 0.4)', text: '#93c5fd' },
    };
    const c = colors[toast.type] || colors.success;
    return (
      <div style={{
        position: 'fixed',
        bottom: '1.5rem',
        right: '1.5rem',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        padding: '0.65rem 1.1rem',
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: '10px',
        backdropFilter: 'blur(12px)',
        boxShadow: `0 4px 24px rgba(0,0,0,0.3), 0 0 0 1px ${c.border}`,
        color: c.text,
        fontSize: '0.82rem',
        fontWeight: 600,
        letterSpacing: '-0.01em',
        animation: 'slideInRight 0.22s cubic-bezier(.16,1,.3,1)',
        pointerEvents: 'none',
        maxWidth: '320px',
      }}>
        <span style={{ fontSize: '1rem' }}>
          {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✗' : 'ℹ'}
        </span>
        {toast.message}
      </div>
    );
  }

  return { toast, showToast, ToastPortal };
}
