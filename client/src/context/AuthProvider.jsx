import { useState, useEffect, useCallback } from 'react';
import { API } from '../config';
import { AuthContext } from './AuthContext';

const AUTH_STORAGE_KEY = 'boundaryiq_auth_token';
const USER_STORAGE_KEY = 'boundaryiq_user';

/**
 * Wrap your app (or the Router) with this provider.
 * It restores the session from localStorage on first render.
 */
export function AuthProvider({ children }) {
  const [user, setUser]               = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Session restore: read persisted user metadata from localStorage.
  // The token is kept in memory (React state) only — it is NOT stored back
  // to localStorage here. The httpOnly cookie provides the actual server-side
  // auth; localStorage is used only for UI metadata (username, plan, role).
  useEffect(() => {
    const token    = localStorage.getItem(AUTH_STORAGE_KEY);
    const userJson = localStorage.getItem(USER_STORAGE_KEY);

    if (token && userJson) {
      try {
        const parsed = JSON.parse(userJson);
        setUser({ ...parsed, token });
      } catch {
        // Corrupted storage — clear it
        localStorage.removeItem(AUTH_STORAGE_KEY);
        localStorage.removeItem(USER_STORAGE_KEY);
      }
    }

    setAuthLoading(false);
  }, []);

  // Login: persist the token to localStorage for session restore on next page load,
  // and the user object (without token) for UI metadata.
  // The httpOnly cookie is set by the server on the login response and handles
  // actual server-side authentication -- the localStorage token is a client-side
  // convenience for restoring the in-memory session on refresh.
  const login = useCallback((data) => {
    const { token, user: userData, ...rest } = data;
    const userPayload = userData || rest;
    // Explicitly exclude the token from the persisted user JSON
    const { token: _stripped, ...storableUser } = { ...userPayload, token: undefined };
    const fullUser = { ...userPayload, token };

    localStorage.setItem(AUTH_STORAGE_KEY, token);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(storableUser));
    setUser(fullUser);
  }, []);

  // ── Logout ──────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY);

    // Best-effort server-side session invalidation
    if (token) {
      try {
        await fetch(`${API}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch { /* ignore network errors during logout */ }
    }

    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    setUser(null);
  }, []);

  // ── Update user in state (e.g. after profile change) ───────────────────────
  const updateUser = useCallback((updates) => {
    setUser(prev => {
      if (!prev) return prev;
      const updated = { ...prev, ...updates };
      const storable = { ...updated };
      delete storable.token;
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(storable));
      return updated;
    });
  }, []);

  // Sync token-expiration event from centralized API layer
  useEffect(() => {
    const handleAuthExpired = () => {
      logout();
    };
    window.addEventListener('auth:expired', handleAuthExpired);
    return () => {
      window.removeEventListener('auth:expired', handleAuthExpired);
    };
  }, [logout]);

  const value = { user, authLoading, login, logout, updateUser };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
