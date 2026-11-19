import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

/** Mirrors the backend's TaskEventPayload (backend/src/lib/realtime.ts). */
export interface TaskEvent {
  id: string;
  type:
    | 'task.created'
    | 'task.assigned'
    | 'task.started'
    | 'task.status_updated'
    | 'task.completed'
    | 'task.reopened'
    | 'task.updated'
    | 'task.deleted'
    | 'comment.created'
    | 'comment.reply';
  message: string;
  personal: boolean;
  task: { id: string; key: string; title: string; status: string; websiteId: string; projectId: string; assigneeId: string | null; creatorId: string | null };
  actor: { id: string; name: string } | null;
  at: string;
}

export type RealtimeStatus = 'connecting' | 'live' | 'offline';
const RealtimeContext = createContext<RealtimeStatus>('offline');
export const useRealtimeStatus = () => useContext(RealtimeContext);

/** Socket.IO lives on the API's origin (same origin in development through the Vite proxy). */
const socketOrigin = () => {
  const api = import.meta.env.VITE_API_URL ?? '/api/v1';
  return /^https?:\/\//.test(api) ? new URL(api).origin : window.location.origin;
};

// Data that a task event can change, refreshed without reloading the page.
const AFFECTED = [['tasks'], ['dashboard'], ['projects'], ['comments'], ['notifications'], ['analytics'], ['websites']] as const;

/**
 * Live updates for the signed-in user: one authenticated socket (HTTP-only cookie), cache
 * invalidation in small batches, and a toast for events that concern the user personally
 * (assigned to them, their task progressed, a reply to them) and for new tasks.
 */
export const RealtimeProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState<RealtimeStatus>('offline');
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;
    setStatus('connecting');
    const socket: Socket = io(socketOrigin(), { path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });

    const refresh = () => {
      if (flush.current) return;
      flush.current = setTimeout(() => {
        flush.current = null;
        AFFECTED.forEach((key) => qc.invalidateQueries({ queryKey: [...key] }));
      }, 250);
    };

    socket.on('ready', () => setStatus('live'));
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', () => setStatus('offline'));
    socket.io.on('reconnect', () => refresh()); // catch up on anything missed while offline
    socket.on('task:event', (e: TaskEvent) => {
      refresh();
      if (e.actor?.id === userId) return;
      if (e.personal || e.type === 'task.created') {
        toast(e.message, {
          id: e.id,
          description: e.task.title,
          action: e.type === 'task.deleted' ? undefined : { label: 'Open', onClick: () => navigate(`/tasks/${e.task.id}`) },
          duration: 6000,
        });
      }
    });

    return () => {
      if (flush.current) clearTimeout(flush.current);
      flush.current = null;
      socket.close();
      setStatus('offline');
    };
  }, [userId, qc, navigate]);

  return <RealtimeContext.Provider value={status}>{children}</RealtimeContext.Provider>;
};
