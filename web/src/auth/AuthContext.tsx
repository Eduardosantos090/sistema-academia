import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import type { SessionUser } from '../api/types';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  expired: boolean;
  isOwner: boolean;
  hasOrg: boolean;
  isPlatform: boolean;
  login: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const hadSession = useRef(false);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
    qc.clear(); // nenhum dado de uma sessão permanece em cache para a próxima
  }, [qc]);

  const refresh = useCallback(async () => {
    const r = await api.get<{ user: SessionUser; csrfToken: string }>('/api/auth/me');
    setCsrfToken(r.csrfToken);
    hadSession.current = true;
    setUser(r.user);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!hadSession.current) return;
      hadSession.current = false;
      setExpired(true);
      clear();
    });
    refresh()
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 401) console.warn('Falha ao verificar sessão');
      })
      .finally(() => setLoading(false));
  }, [clear, refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await api.post<{ user: SessionUser; csrfToken: string }>('/api/auth/login', { email, password });
      qc.clear();
      setCsrfToken(r.csrfToken);
      setExpired(false);
      hadSession.current = true;
      setUser(r.user);
      return r.user;
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      hadSession.current = false;
      setExpired(false);
      clear();
    }
  }, [clear]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      expired,
      isOwner: user?.role === 'owner',
      hasOrg: !!user?.orgId,
      isPlatform: !!user?.isPlatformAdmin,
      login,
      logout,
      refresh,
    }),
    [user, loading, expired, login, logout, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider ausente');
  return v;
}
