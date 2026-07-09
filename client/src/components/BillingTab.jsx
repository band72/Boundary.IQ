import { useState, useEffect } from 'react';
import { API } from '../config';

const PLAN_FEATURES = {
  free: {
    icon: '🆓', name: 'Free', color: '#aaa',
    features: ['5 deed solves per day', 'Traverse Compute (full)', 'Legal Writer (basic)', 'View Dashboard only'],
    missing: ['Batch Deed processing', 'Plat Extraction AI', 'Unlimited solves', 'Priority support'],
  },
  basic: {
    icon: '🌱', name: 'Basic', color: '#3d7fff',
    price: '$5/month',
    features: ['50 deed solves per day', 'Traverse Compute (full)', 'Legal Writer (pro)', 'Batch Deed processing (basic)'],
    missing: ['Plat Extraction AI', 'Unlimited solves', 'Priority support'],
  },
  pro: {
    icon: '⭐', name: 'Pro', color: '#50c878',
    price: '$19.99/month',
    features: ['Unlimited deed solves', 'Full Batch Deed processing', 'Plat Extraction with AI', 'Full Analytics Dashboard', 'Priority email support'],
    missing: ['Multi-seat team access', 'Custom AI models', 'API access'],
  },
  enterprise: {
    icon: '🏢', name: 'Enterprise', color: '#ffaa00',
    price: '$99/month',
    features: ['Everything in Pro', '5 team members', 'Custom AI model configuration', 'Full REST API access', 'Dedicated SLA support', 'Custom data retention'],
    missing: [],
  },
};

export default function BillingTab({ user }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('success');

  const token = localStorage.getItem('boundaryiq_auth_token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const flash = (text, type = 'success') => {
    setMsg(text);
    setMsgType(type);
    setTimeout(() => setMsg(''), 5000);
  };

  useEffect(() => {
    // Check for billing return in URL
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing') === 'success') {
      flash('🎉 Payment successful! Your plan has been upgraded.', 'success');
      window.history.replaceState({}, '', window.location.pathname);
    }

    fetch(`${API}/billing/status`, { headers })
      .then(r => r.json())
      .then(statusData => {
        setStatus(statusData);
      })
      .catch(e => flash(e.message, 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUpgrade = async (plan) => {
    setUpgrading(true);
    try {
      const res = await fetch(`${API}/billing/create-checkout`, {
        method: 'POST', headers,
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.mockMode) {
        flash(`✓ ${data.message} Refresh to see your updated plan.`, 'success');
        // Reload status
        const newStatus = await fetch(`${API}/billing/status`, { headers }).then(r => r.json());
        setStatus(newStatus);
      } else {
        // Redirect to Stripe Checkout
        window.location.href = data.checkoutUrl;
      }
    } catch (e) {
      flash(e.message, 'error');
    } finally {
      setUpgrading(false);
    }
  };

  const handlePortal = async () => {
    try {
      const res = await fetch(`${API}/billing/portal`, { method: 'POST', headers });
      const data = await res.json();
      if (data.mockMode) {
        flash('Billing portal is only available with live Stripe. Use the Admin Panel to manage plans.', 'info');
        return;
      }
      if (!res.ok) throw new Error(data.error);
      window.location.href = data.portalUrl;
    } catch (e) {
      flash(e.message, 'error');
    }
  };

  const currentPlan = status?.plan || user?.plan || 'free';
  const isAdmin = user?.role === 'admin';
  const planInfo = PLAN_FEATURES[currentPlan] || PLAN_FEATURES.free;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, gap: '0.75rem', color: 'var(--text-muted)' }}>
        <span className="spinner" style={{ width: 28, height: 28, borderWidth: 2 }} />
        <span>Loading billing info…</span>
      </div>
    );
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: 920, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          💳 Subscription & Billing
        </h1>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          Manage your plan, upgrade for more features, or access your billing history.
        </p>
      </div>

      {/* Flash */}
      {msg && (
        <div style={{
          padding: '0.65rem 1rem', borderRadius: 'var(--radius-md)', marginBottom: '1.25rem',
          background: msgType === 'error' ? 'rgba(255,70,70,0.12)' : 'rgba(80,200,120,0.12)',
          border: `1px solid ${msgType === 'error' ? 'rgba(255,70,70,0.3)' : 'rgba(80,200,120,0.3)'}`,
          color: msgType === 'error' ? '#ff7070' : '#50c878',
          fontSize: '0.83rem',
        }}>
          {msg}
        </div>
      )}

      {/* Mock mode notice */}
      {status?.mockMode && (
        <div style={{
          padding: '0.65rem 1rem', borderRadius: 'var(--radius-md)', marginBottom: '1.25rem',
          background: 'rgba(61,127,255,0.08)', border: '1px solid rgba(61,127,255,0.25)',
          color: 'var(--accent)', fontSize: '0.79rem', display: 'flex', gap: '0.5rem', alignItems: 'center',
        }}>
          <span>⚡</span>
          <span><strong>Mock Mode</strong> — No real payments. Set <code>STRIPE_SECRET_KEY</code> in <code>.env</code> to enable live Stripe billing.</span>
        </div>
      )}

      {/* Current Plan Card */}
      <div className="card" style={{
        background: 'rgba(9,14,26,0.4)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: '1.25rem', marginBottom: '1.5rem',
        display: 'flex', alignItems: 'center', gap: '1.25rem',
        borderLeft: `3px solid ${planInfo.color}`,
      }}>
        <div style={{ fontSize: '2rem' }}>{planInfo.icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700, marginBottom: '0.25rem' }}>Current Plan</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: planInfo.color }}>{planInfo.name}</div>
          {status?.subscription?.periodEnd && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
              Renews {new Date(status.subscription.periodEnd).toLocaleDateString()}
            </div>
          )}
        </div>
        {currentPlan !== 'free' && (
          <button className="btn btn-ghost" onClick={handlePortal} style={{ fontSize: '0.78rem' }}>
            Manage Billing →
          </button>
        )}
        {isAdmin && (
          <span style={{ fontSize: '0.68rem', color: '#ffaa00', padding: '2px 8px', background: 'rgba(255,170,0,0.1)', border: '1px solid rgba(255,170,0,0.3)', borderRadius: 99 }}>
            🔑 Admin Override
          </span>
        )}
      </div>

      {/* Plan grid */}
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginBottom: '0.9rem' }}>Available Plans</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.9rem', marginBottom: '2rem' }}>
        {Object.entries(PLAN_FEATURES).map(([planId, plan]) => {
          const isCurrent = planId === currentPlan;
          const isUpgrade = !isCurrent && planId !== 'free';
          const isEntUpgrade = false; // Simplified upgrade check for all active upgrades

          return (
            <div key={planId} style={{
              background: isCurrent ? 'rgba(61,127,255,0.06)' : 'rgba(9,14,26,0.4)',
              border: `1px solid ${isCurrent ? plan.color + '55' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)', padding: '1.25rem',
              display: 'flex', flexDirection: 'column', gap: '0.75rem',
              position: 'relative', overflow: 'hidden',
              transition: 'transform 0.15s, box-shadow 0.15s',
            }}
              onMouseEnter={e => { if (!isCurrent) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.3)'; }}}
              onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
            >
              {isCurrent && (
                <div style={{ position: 'absolute', top: 12, right: 12, fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', padding: '2px 8px', borderRadius: 99, background: plan.color + '22', border: `1px solid ${plan.color}55`, color: plan.color }}>
                  Current
                </div>
              )}

              <div>
                <div style={{ fontSize: '1.4rem', marginBottom: '0.35rem' }}>{plan.icon}</div>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: plan.color }}>{plan.name}</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff', marginTop: '0.2rem' }}>
                  {plan.price || 'Free'}
                </div>
              </div>

              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {plan.features.map(f => (
                  <li key={f} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.4rem' }}>
                    <span style={{ color: '#50c878', flexShrink: 0 }}>✓</span> {f}
                  </li>
                ))}
                {plan.missing?.map(f => (
                  <li key={f} style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', gap: '0.4rem' }}>
                    <span style={{ flexShrink: 0 }}>✗</span> {f}
                  </li>
                ))}
              </ul>

              {!isCurrent && planId !== 'free' && (
                <button
                  className={`btn ${isUpgrade || isEntUpgrade ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => handleUpgrade(planId)}
                  disabled={upgrading}
                  style={{ marginTop: 'auto', justifyContent: 'center', width: '100%' }}
                >
                  {upgrading ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Processing…</> : `Upgrade to ${plan.name}`}
                </button>
              )}
              {planId === 'free' && currentPlan !== 'free' && (
                <button className="btn btn-ghost" onClick={handlePortal} style={{ marginTop: 'auto', justifyContent: 'center', width: '100%', fontSize: '0.78rem' }}>
                  Downgrade / Cancel
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* FAQ */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        {[
          { q: 'Can I cancel anytime?', a: 'Yes. Cancellations take effect at end of billing period. Your data is preserved.' },
          { q: 'What happens to my solves if I downgrade?', a: 'You go back to 5 deed solves/day. Existing data and results are kept.' },
          { q: 'Is there a trial period?', a: 'The free tier gives you full access to Traverse Compute and Writer indefinitely.' },
          { q: 'How are payments processed?', a: 'All payments are handled securely via Stripe. We never store card details.' },
        ].map(faq => (
          <div key={faq.q} style={{ padding: '0.9rem', background: 'rgba(9,14,26,0.3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff', marginBottom: '0.3rem' }}>{faq.q}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{faq.a}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
