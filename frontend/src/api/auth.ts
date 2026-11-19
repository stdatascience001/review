import { api, unwrap } from '@/lib/api';
import type { Me, Session } from '@/types/api';

export const authApi = {
  providers: () => unwrap<{ password: boolean; google: boolean }>(api.get('/auth/providers')),
  login: (body: { email: string; password: string }) => unwrap<{ user: Me }>(api.post('/auth/login', body)),
  register: (body: { email: string; password: string; name: string }) =>
    unwrap<{ user: Me }>(api.post('/auth/register', body)),
  logout: () => api.post('/auth/logout'),
  logoutAll: () => api.post('/auth/logout-all'),
  me: () => unwrap<Me>(api.get('/users/me')),
  updateMe: (body: { name?: string; avatarUrl?: string | null }) => unwrap<Me>(api.patch('/users/me', body)),
  changePassword: (body: { currentPassword?: string; newPassword: string }) => api.patch('/users/me/password', body),
  verifyEmail: (token: string) => unwrap<{ user: Me }>(api.post('/auth/verify-email', { token })),
  resendVerification: () => api.post('/auth/resend-verification'),
  forgotPassword: (email: string) => unwrap<{ message: string }>(api.post('/auth/forgot-password', { email })),
  resetPassword: (token: string, password: string) =>
    unwrap<{ message: string }>(api.post('/auth/reset-password', { token, password })),
  sessions: () => unwrap<Session[]>(api.get('/auth/sessions')),
  revokeSession: (id: string) => api.delete(`/auth/sessions/${id}`),
  /** Full-page redirect into the Google OAuth flow (handled by the backend). */
  googleUrl: (redirect = '/') =>
    `${(import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '')}/auth/google?redirect=${encodeURIComponent(redirect)}`,
};
