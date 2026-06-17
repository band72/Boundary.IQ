/**
 * api/index.js — Centralized API module.
 *
 * Provides an authenticated fetch helper that:
 *   - Automatically injects the Authorization: Bearer <token> header
 *   - Handles 401 responses by dispatching a custom 'auth:expired' event
 *     (AuthContext listens for this and clears the session)
 *   - Provides typed helpers for common endpoints
 *
 * Usage:
 *   import { authFetch, api } from '../api';
 *
 *   // Low-level:
 *   const data = await authFetch('/auth/me');
 *
 *   // High-level typed helpers:
 *   const stats = await api.diagnostics.getStats();
 */

import { API } from '../config';

const AUTH_STORAGE_KEY = 'boundaryiq_auth_token';

// ── Core authenticated fetch ──────────────────────────────────────────────────

export function getAuthHeaders(customHeaders = {}) {
  const token = localStorage.getItem(AUTH_STORAGE_KEY);
  const headers = { ...customHeaders };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * authFetch — wraps window.fetch with:
 *   - Automatic Bearer token injection from localStorage
 *   - 401 → dispatches 'auth:expired' CustomEvent (picked up by AuthContext)
 *   - Throws on non-ok responses with a normalized Error
 *
 * @param {string} path       - Route path relative to API base (e.g. '/auth/me')
 * @param {RequestInit} opts  - Standard fetch options (method, body, headers, …)
 * @returns {Promise<any>}    - Parsed JSON response body
 */
export async function authFetch(path, opts = {}) {
  const token = localStorage.getItem(AUTH_STORAGE_KEY);

  const headers = {
    'Content-Type': 'application/json',
    ...opts.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API}${path}`, { ...opts, headers });

  // Session expired or token revoked
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Session expired. Please log in again.');
  }

  // Parse body (even for error responses — server always returns JSON)
  let body;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }

  if (!res.ok) {
    const message = (typeof body === 'object' ? body?.error : body) || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

/**
 * authFetchRaw — same as authFetch but returns the raw Response object.
 * Use this for endpoints that return non-JSON (e.g. ZIP downloads, DXF files).
 */
export async function authFetchRaw(path, opts = {}) {
  const token = localStorage.getItem(AUTH_STORAGE_KEY);
  const headers = { ...opts.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Session expired.');
  }
  return res;
}

// ── Typed API helpers ─────────────────────────────────────────────────────────

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: {
    login:       (username, password)    => authFetch('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    register:    (username, password)    => authFetch('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout:      ()                      => authFetch('/auth/logout', { method: 'POST' }),
    me:          ()                      => authFetch('/auth/me'),
    googleLogin: (credential)            => authFetch('/auth/google-login', { method: 'POST', body: JSON.stringify({ credential }) }),
    forgotPw:    (username)              => authFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ username }) }),
    updateProfile: (data)                => authFetch('/auth/profile', { method: 'PUT', body: JSON.stringify(data) }),
    changePassword: (currentPassword, newPassword) =>
      authFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  },

  // ── Diagnostics ───────────────────────────────────────────────────────────
  diagnostics: {
    getStats:      ()                   => authFetch('/diagnostics/stats'),
    getBatches:    ()                   => authFetch('/diagnostics/batches'),
    getBatchStats: (batchId)            => authFetch(`/diagnostics/batch/${batchId}`),
    getFailedList: (limit, bucket)      => authFetch(`/diagnostics/failed?limit=${limit}&bucket=${bucket || ''}`),
    getDeedDetail: (fileName)           => authFetch(`/diagnostics/deed-detail?fileName=${encodeURIComponent(fileName)}`),
    getSolutionSteps: (fileName)        => authFetch(`/diagnostics/solution-steps?fileName=${encodeURIComponent(fileName)}`),
    search:         (q, status, maxErr) => authFetch(`/diagnostics/search?q=${encodeURIComponent(q)}&status=${status || ''}&maxError=${maxErr ?? ''}`),
    purgeStale:     (fileName)          => authFetch(`/diagnostics/purge-stale${fileName ? `?fileName=${encodeURIComponent(fileName)}` : ''}`, { method: 'DELETE' }),
    clearFailed:    ()                  => authFetch('/diagnostics/clear-failed', { method: 'DELETE' }),
    clearAll:       ()                  => authFetch('/diagnostics/clear-all', { method: 'DELETE' }),
  },

  // ── Folder Scan ───────────────────────────────────────────────────────────
  folderScan: {
    scan:        (folderPath)          => authFetch(`/folderscan/scan?path=${encodeURIComponent(folderPath)}`),
    status:      ()                    => authFetch('/folderscan/status'),
    resetLock:   ()                    => authFetch('/folderscan/reset-lock', { method: 'POST' }),
    downloadZip: (folderPath)          => authFetchRaw(`/folderscan/download-batch-zip?path=${encodeURIComponent(folderPath)}`),
  },

  // ── Deed Solver ───────────────────────────────────────────────────────────
  deed: {
    models:      ()                    => authFetch('/deed/models'),
    solve:       (body)                => authFetch('/deed/solve', { method: 'POST', body: JSON.stringify(body) }),
    solveText:   (body)                => authFetch('/deed/solve-text', { method: 'POST', body: JSON.stringify(body) }),
    solveDirect: (body)                => authFetch('/deed/solve-direct', { method: 'POST', body: JSON.stringify(body) }),
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: {
    get:    ()       => authFetch('/settings'),
    update: (data)   => authFetch('/settings', { method: 'PUT', body: JSON.stringify(data) }),
  },

  // ── Billing ───────────────────────────────────────────────────────────────
  billing: {
    createCheckout: (plan) => authFetch('/billing/create-checkout', { method: 'POST', body: JSON.stringify({ plan }) }),
    getPortalUrl:   ()     => authFetch('/billing/portal'),
    getStatus:      ()     => authFetch('/billing/status'),
  },

  // ── Admin ─────────────────────────────────────────────────────────────────
  admin: {
    users:      ()                => authFetch('/auth/admin/users'),
    auditLog:   (params = {})     => authFetch(`/auth/admin/audit-log?${new URLSearchParams(params)}`),
    orders:     ()                => authFetch('/auth/admin/orders'),
    setRole:    (userId, role)    => authFetch(`/auth/admin/users/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
    setPlan:    (userId, plan)    => authFetch(`/auth/admin/users/${userId}/plan`, { method: 'PUT', body: JSON.stringify({ plan }) }),
    deleteUser: (userId)          => authFetch(`/auth/admin/users/${userId}`, { method: 'DELETE' }),
    resetPw:    (userId)          => authFetch(`/auth/admin/users/${userId}/reset-password`, { method: 'POST' }),
    invites:    ()                => authFetch('/auth/admin/invites'),
    createInvite: (data)          => authFetch('/auth/admin/invites', { method: 'POST', body: JSON.stringify(data) }),
    revokeInvite: (token)         => authFetch(`/auth/admin/invites/${token}`, { method: 'DELETE' }),
  },
};
