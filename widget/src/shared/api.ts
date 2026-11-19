/**
 * Widget API client. One instance is created by the loader and handed to the panel, so
 * there is exactly one place that refreshes tokens (refresh tokens rotate on every use).
 *
 * Sessions are site-bound (they only work on this website's widget API) and are kept in
 * the host page's localStorage under "wrtm-widget:<siteId>". No cookies are used, so
 * third-party-cookie blocking doesn't affect the widget.
 */

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export class ApiError extends Error {
  readonly isWidgetApiError = true;
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

/**
 * Use this instead of `instanceof ApiError`: the client is created by the loader bundle and
 * used by the panel bundle, so each has its own copy of the class.
 */
export const isApiError = (e: unknown): e is ApiError =>
  typeof e === 'object' && e !== null && (e as { isWidgetApiError?: boolean }).isWidgetApiError === true;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Raw body (file upload). */
  blob?: Blob;
  /** Original file name for uploads (sent URI-encoded in X-File-Name). */
  fileName?: string;
  /** Send the bearer token (default true when signed in). */
  auth?: boolean;
}

export type WidgetApi = ReturnType<typeof createApi>;

export const createApi = (apiBase: string, siteId: string) => {
  const key = `wrtm-widget:${siteId}`;
  const read = (): Session | null => {
    try {
      const raw = localStorage.getItem(key);
      const s = raw ? (JSON.parse(raw) as Session) : null;
      return s && typeof s.accessToken === 'string' && typeof s.refreshToken === 'string' ? s : null;
    } catch {
      return null;
    }
  };

  let session = read();
  const listeners = new Set<(s: Session | null) => void>();
  const emit = () => listeners.forEach((l) => l(session));

  const setSession = (s: Session | null) => {
    session = s;
    try {
      if (s) localStorage.setItem(key, JSON.stringify(s));
      else localStorage.removeItem(key);
    } catch {
      /* storage disabled: session lives for this page only */
    }
    emit();
  };

  // Keep tabs in sync (sign-in / sign-out / token rotation in another tab).
  window.addEventListener('storage', (e) => {
    if (e.key === key) {
      session = read();
      emit();
    }
  });

  let refreshing: Promise<boolean> | null = null;
  const doRefresh = async (): Promise<boolean> => {
    const used = session?.refreshToken;
    if (!used) return false;
    try {
      const res = await fetch(`${apiBase}/widget/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, refreshToken: used }),
        credentials: 'omit',
      });
      if (res.ok) {
        setSession(((await res.json()) as { data: { session: Session } }).data.session);
        return true;
      }
      // Another tab may have rotated the token a moment ago: adopt its session.
      const stored = read();
      if (stored && stored.refreshToken !== used) {
        session = stored;
        return true;
      }
      if (res.status === 401) setSession(null);
      return false;
    } catch {
      return false;
    }
  };
  const refresh = () => {
    refreshing ??= doRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const request = async <T>(path: string, opts: RequestOptions = {}): Promise<T> => {
    const useAuth = opts.auth !== false;
    const send = () => {
      const headers: Record<string, string> = {};
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      if (opts.blob) headers['Content-Type'] = opts.blob.type || 'application/octet-stream';
      if (opts.fileName) headers['X-File-Name'] = encodeURIComponent(opts.fileName);
      if (useAuth && session) headers.Authorization = `Bearer ${session.accessToken}`;
      return fetch(`${apiBase}/widget${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.blob ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        credentials: 'omit',
      });
    };

    let res: Response;
    try {
      res = await send();
      if (res.status === 401 && useAuth && session && (await refresh())) res = await send();
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the review service. Check your connection.');
    }
    if (res.status === 204) return undefined as T;

    let json: { data?: T; error?: { code: string; message: string; details?: { path: string; message: string }[] } } | null = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      if (res.status === 401 && useAuth && session) setSession(null); // refresh failed: signed out
      const e = json?.error;
      throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
    }
    return json?.data as T;
  };

  return {
    apiBase,
    siteId,
    request,
    getSession: () => session,
    setSession,
    onSession: (l: (s: Session | null) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
};
