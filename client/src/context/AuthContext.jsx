/**
 * AuthContext — centralized authentication state.
 *
 * Provides:
 *   - user:        the authenticated user object (or null if not logged in)
 *   - authLoading: true while session is being restored from localStorage
 *   - login(data): called after a successful /api/auth/login response
 *   - logout():    clears token and resets state
 *
 * Usage:
 *   import { useAuth } from '../hooks/useAuth';
 *   const { user, login, logout, authLoading } = useAuth();
 */

import { createContext, useContext } from 'react';



export const AuthContext = createContext(null);



/** Direct context accessor — use the hook from hooks/useAuth.js instead. */
export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used inside <AuthProvider>');
  return ctx;
}
