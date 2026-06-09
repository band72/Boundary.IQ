import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Global window.fetch Interceptor for Commercial Release token authorization.
// SECURITY: Only inject the Authorization header for requests targeting the
// local API server — never for third-party URLs (fonts, CDNs, analytics, etc.)
const API_ORIGIN = new URL(
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:5050'
).origin;

const originalFetch = window.fetch;
window.fetch = async function (url, options = {}) {
  try {
    const requestOrigin = new URL(url, window.location.href).origin;
    if (requestOrigin === API_ORIGIN) {
      const token = localStorage.getItem('boundaryiq_auth_token');
      if (token) {
        options.headers = {
          ...options.headers,
          'Authorization': `Bearer ${token}`
        };
      }
    }
  } catch {
    // If URL parsing fails (e.g. relative path with unusual format), fall through
    // and let the request proceed without the Authorization header.
  }
  return originalFetch(url, options);
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
