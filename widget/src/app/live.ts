import type { WidgetApi } from '../shared/api';
import type { LiveEvent } from '../shared/types';

/**
 * Real-time connection for the widget (Socket.IO "/widget" namespace). socket.io-client is
 * loaded lazily, only for signed-in reviewers. The site-bound access token is sent in the
 * handshake; when it has expired, the shared API client refreshes it (single flight) and we
 * reconnect. The server re-checks the website's allowed domains for every connection.
 */
export const connectLive = async (
  api: WidgetApi,
  handlers: { onEvent: (e: LiveEvent) => void; onStatus?: (live: boolean) => void },
): Promise<() => void> => {
  const { io } = await import('socket.io-client');
  let closed = false;
  let authFailures = 0;
  const socket = io(`${new URL(api.apiBase).origin}/widget`, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    withCredentials: false,
    auth: (cb) => cb({ token: api.getSession()?.accessToken }),
  });

  socket.on('ready', () => {
    authFailures = 0;
    handlers.onStatus?.(true);
  });
  socket.on('disconnect', () => handlers.onStatus?.(false));
  socket.on('task:event', (e: LiveEvent) => handlers.onEvent(e));
  socket.on('connect_error', async (err) => {
    handlers.onStatus?.(false);
    // Rejected by the server's auth middleware: the client won't retry by itself.
    if (closed || !/TOKEN_INVALID|SESSION_EXPIRED/.test(err.message) || ++authFailures > 3 || !api.getSession()) return;
    try {
      await api.request('/me'); // refreshes the access token if it expired
    } catch {
      return;
    }
    if (!closed && api.getSession()) setTimeout(() => !closed && socket.connect(), 300 * authFailures);
  });

  return () => {
    closed = true;
    socket.close();
  };
};
