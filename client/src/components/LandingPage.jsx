import { useState } from 'react';

export default function LandingPage({ onEnterApp }) {
  return (
    <div className="login-wrapper landing-wrapper" style={{ display: 'block', overflowY: 'auto', padding: '4rem 1.5rem 3rem 1.5rem' }}>
      {/* Background Glowing Orbs */}
      <div className="orb orb-1" style={{ width: '450px', height: '450px', top: '-10%', left: '-10%', filter: 'blur(150px)' }}></div>
      <div className="orb orb-2" style={{ width: '500px', height: '500px', bottom: '-15%', right: '-10%', filter: 'blur(160px)' }}></div>
      <div className="orb orb-3" style={{ width: '350px', height: '350px', top: '40%', left: '60%', filter: 'blur(130px)', background: 'rgba(80, 200, 120, 0.15)' }}></div>

      <div style={{ maxWidth: '1000px', margin: '0 auto', width: '100%', position: 'relative', zIndex: 2 }}>
        
        {/* Navigation Header */}
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1.25rem 2rem',
          background: 'rgba(255, 255, 255, 0.03)',
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          borderRadius: 'var(--radius-md)',
          marginBottom: '3rem',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
        }}>
          <div className="logo-mark" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div className="logo-icon" style={{ fontSize: '1.6rem', color: 'var(--accent)' }}>⬡</div>
            <div className="logo-text" style={{ fontSize: '1.35rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>
              Boundary<span style={{ color: 'var(--accent)' }}>.IQ</span>
            </div>
          </div>
          <button 
            onClick={onEnterApp}
            className="btn btn-primary" 
            style={{ padding: '0.55rem 1.25rem', fontSize: '0.82rem', fontWeight: 700 }}
          >
            Enter Engine
          </button>
        </header>

        {/* Hero Section */}
        <section style={{ textAlign: 'center', marginBottom: '4rem', padding: '1rem 0' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'rgba(80, 200, 120, 0.08)',
            border: '1px solid rgba(80, 200, 120, 0.25)',
            borderRadius: '100px',
            padding: '0.35rem 0.9rem',
            marginBottom: '1.5rem',
            fontSize: '0.72rem',
            fontWeight: 800,
            color: '#50c878',
            letterSpacing: '0.05em',
            textTransform: 'uppercase'
          }}>
            <span>✨ Commercial Release v1.0</span>
          </div>

          <h1 style={{
            fontSize: 'clamp(2rem, 5vw, 3.5rem)',
            fontWeight: 900,
            lineHeight: 1.15,
            color: '#fff',
            marginBottom: '1.25rem',
            letterSpacing: '-0.03em'
          }}>
            Survey Intelligence &amp;<br />
            <span style={{
              background: 'linear-gradient(135deg, var(--accent) 0%, #50c878 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent'
            }}>
              Boundary Geometry Engine
            </span>
          </h1>

          <p style={{
            fontSize: 'clamp(0.95rem, 2vw, 1.15rem)',
            color: 'var(--text-secondary)',
            maxWidth: '650px',
            margin: '0 auto 2.25rem auto',
            lineHeight: 1.6
          }}>
            Process legal descriptions, analyze boundary closes, generate LandXML files, and map traverses automatically using AI-assisted geometric diagnostics.
          </p>

          <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
            <button 
              onClick={onEnterApp}
              className="btn btn-primary" 
              style={{ padding: '0.8rem 2rem', fontSize: '0.95rem', fontWeight: 800, minWidth: '160px', justifyContent: 'center' }}
            >
              Get Started
            </button>
            <a 
              href="#gemini-guide" 
              className="btn btn-ghost" 
              style={{ padding: '0.8rem 1.75rem', fontSize: '0.95rem', fontWeight: 600, border: '1px solid rgba(255,255,255,0.1)' }}
            >
              Get Free API Key
            </a>
          </div>
        </section>

        {/* Feature Cards Grid */}
        <section style={{ marginBottom: '5rem' }}>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: '#fff', textAlign: 'center', marginBottom: '2rem', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.8 }}>
            Engine Capabilities
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            
            <div className="card" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '2rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>📐</div>
              <h4 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff', marginBottom: '0.6rem' }}>COGO Core Solver</h4>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Compute compass rule adjustments, calculate closure error automatically, and export clean coordinates to CAD or GIS systems instantly.
              </p>
            </div>

            <div className="card" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '2rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🛰️</div>
              <h4 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff', marginBottom: '0.6rem' }}>AI Deed Parsing</h4>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Extract bearings, distances, curve parameters, and point of beginning (POB) details straight from text documents using specialized LLMs.
              </p>
            </div>

            <div className="card" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '2rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>📄</div>
              <h4 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff', marginBottom: '0.6rem' }}>Batch Plat OCR</h4>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Upload multiple scanned PDF drawings or survey plans to recognize legal descriptions and boundary tables in a single operation.
              </p>
            </div>

          </div>
        </section>

        {/* Gemini API Key Guide */}
        <section id="gemini-guide" style={{
          background: 'rgba(9, 14, 26, 0.4)',
          border: '1px solid rgba(80, 200, 120, 0.15)',
          borderRadius: 'var(--radius-lg)',
          padding: '2.5rem',
          backdropFilter: 'blur(20px)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
          marginBottom: '5rem',
          position: 'relative',
          overflow: 'hidden'
        }}>
          {/* Accent corner light */}
          <div style={{ position: 'absolute', top: 0, right: 0, width: '150px', height: '150px', background: 'rgba(80, 200, 120, 0.08)', filter: 'blur(50px)' }}></div>

          <h3 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            🔑 Free AI Processing Setup
          </h3>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginBottom: '2rem', lineHeight: 1.6, maxWidth: '750px' }}>
            Boundary.IQ leverages Gemini models to parse deed text. You can obtain a permanent, **100% free personal API key** directly from Google to power all your AI computations.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
            
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', padding: '1.25rem', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--accent)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Step 1</div>
              <h5 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fff', margin: '0 0 0.4rem 0' }}>Visit AI Studio</h5>
              <p style={{ fontSize: '0.74rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
                Navigate to <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>aistudio.google.com</a> on your browser.
              </p>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', padding: '1.25rem', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--accent)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Step 2</div>
              <h5 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fff', margin: '0 0 0.4rem 0' }}>Get API Key</h5>
              <p style={{ fontSize: '0.74rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
                Log in with your standard Google Account and click on the **"Get API key"** button.
              </p>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', padding: '1.25rem', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--accent)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Step 3</div>
              <h5 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fff', margin: '0 0 0.4rem 0' }}>Create Key</h5>
              <p style={{ fontSize: '0.74rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
                Click **"Create API key"** (select a free project template) to generate your key, and copy it.
              </p>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', padding: '1.25rem', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--accent)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Step 4</div>
              <h5 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fff', margin: '0 0 0.4rem 0' }}>Paste in Settings</h5>
              <p style={{ fontSize: '0.74rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
                Open **Settings** inside the platform and paste your key to activate unlimited free solves.
              </p>
            </div>

          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', background: 'rgba(80, 200, 120, 0.05)', border: '1px solid rgba(80, 200, 120, 0.12)', borderRadius: 'var(--radius-sm)', padding: '0.8rem 1rem' }}>
            <span style={{ fontSize: '1.1rem' }}>💡</span>
            <span style={{ fontSize: '0.78rem', color: '#50c878', lineHeight: 1.4 }}>
              <strong>Free Tier Benefits:</strong> Google provides 15 RPM (Requests Per Minute) and 1,500 RPD (Requests Per Day) for free under the standard tier — plenty for survey analysis!
            </span>
          </div>
        </section>

        {/* Footer */}
        <footer style={{
          textAlign: 'center',
          padding: '2rem 0',
          borderTop: '1px solid rgba(255, 255, 255, 0.06)',
          fontSize: '0.78rem',
          color: 'var(--text-muted)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem'
        }}>
          <span>&copy; {new Date().getFullYear()} Boundary.IQ. All rights reserved.</span>
          <div style={{ display: 'flex', gap: '1.25rem' }}>
            <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Google AI Studio</a>
            <span style={{ color: 'rgba(255,255,255,0.1)' }}>|</span>
            <span style={{ color: 'var(--text-muted)' }}>Powered by GeometryEngine</span>
          </div>
        </footer>

      </div>
    </div>
  );
}
