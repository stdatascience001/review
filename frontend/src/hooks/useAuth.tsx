import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { authApi } from '@/api/auth';
import { onSessionExpired } from '@/lib/api';
import type { Me } from '@/types/api';

interface AuthContextValue {
  user: Me | null;
  isLoading: boolean;
  isSuperAdmin: boolean;
  setUser: (user: Me | null) => void;
  refetch: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
export const ME_KEY = ['me'] as const;

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await authApi.me();
      } catch (err) {
        if (axios.isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403)) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  /**
   * Signs the UI out: the 'me' query is set to null in place (observers stay subscribed;
   * qc.clear() would orphan them and keep showing the old user), and every other cached
   * query is dropped so no tenant data survives the session.
   */
  const resetSession = useCallback(() => {
    qc.setQueryData(ME_KEY, null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
  }, [qc]);

  const setUser = useCallback((user: Me | null) => qc.setQueryData(ME_KEY, user), [qc]);

  // When a background request discovers the session is gone, drop all cached data.
  useEffect(
    () =>
      onSessionExpired(() => {
        // Only react when someone was signed in; otherwise the initial anonymous /users/me
        // probe would clear the cache and re-trigger itself.
        if (!qc.getQueryData(ME_KEY)) return;
        resetSession();
      }),
    [qc, resetSession],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      resetSession();
    }
  }, [resetSession]);

  return (
    <AuthContext.Provider
      value={{
        user: data ?? null,
        isLoading,
        isSuperAdmin: data?.role === 'SUPER_ADMIN',
        setUser,
        refetch,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
