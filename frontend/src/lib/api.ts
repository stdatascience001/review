import axios, { AxiosError, type AxiosRequestConfig } from 'axios';

/**
 * Axios client for the backend. Auth uses HTTP-only cookies set by the API, so the browser
 * never sees tokens: `withCredentials` sends them, and on a 401 we transparently call
 * POST /auth/refresh once (single-flight) and retry the original request.
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

export interface ApiErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

const NO_REFRESH = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout', '/auth/forgot-password', '/auth/reset-password'];

let refreshing: Promise<boolean> | null = null;
const refreshSession = () => {
  refreshing ??= api
    .post('/auth/refresh', undefined, { _skipRefresh: true } as AxiosRequestConfig)
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => (refreshing = null), 0);
    });
  return refreshing;
};

type RetriableConfig = AxiosRequestConfig & { _retried?: boolean; _skipRefresh?: boolean };

/** Listeners notified when the session is definitively gone (refresh failed). */
const sessionExpiredListeners = new Set<() => void>();
export const onSessionExpired = (fn: () => void) => {
  sessionExpiredListeners.add(fn);
  return () => {
    sessionExpiredListeners.delete(fn);
  };
};

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<ApiErrorBody>) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;
    if (
      status === 401 &&
      config &&
      !config._retried &&
      !config._skipRefresh &&
      !NO_REFRESH.some((p) => config.url?.startsWith(p))
    ) {
      config._retried = true;
      if (await refreshSession()) return api(config);
      sessionExpiredListeners.forEach((fn) => fn());
    }
    return Promise.reject(error);
  },
);

/** Human-readable message for any API/network error. */
export const getErrorMessage = (err: unknown, fallback = 'Something went wrong'): string => {
  if (axios.isAxiosError<ApiErrorBody>(err)) {
    const body = err.response?.data?.error;
    if (body?.details?.length) return body.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('\n');
    if (body?.message) return body.message;
    if (!err.response) return 'Cannot reach the server. Check your connection.';
  }
  return err instanceof Error && err.message ? err.message : fallback;
};

export const getErrorCode = (err: unknown): string | undefined =>
  axios.isAxiosError<ApiErrorBody>(err) ? err.response?.data?.error?.code : undefined;

/** Unwraps the `{ data }` envelope. */
export const unwrap = <T>(p: Promise<{ data: { data: T } }>): Promise<T> => p.then((r) => r.data.data);
