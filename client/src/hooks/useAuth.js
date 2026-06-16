/**
 * useAuth — convenience hook wrapping AuthContext.
 *
 * Usage:
 *   const { user, login, logout, authLoading, updateUser } = useAuth();
 */

import { useAuthContext } from '../context/AuthContext';

export function useAuth() {
  return useAuthContext();
}
