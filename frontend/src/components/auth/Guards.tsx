import { Loader2, MailWarning, ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { toast } from 'sonner';
import { authApi } from '@/api/auth';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Display';
import { useAuth } from '@/hooks/useAuth';
import { getErrorMessage } from '@/lib/api';
import type { UserRole } from '@/types/api';

export const FullPageLoader = () => (
  <div className="flex min-h-screen items-center justify-center" aria-label="Loading">
    <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
  </div>
);

/** Requires a signed-in user with a verified email. */
export const ProtectedRoute = () => {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullPageLoader />;
  if (!user) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!user.emailVerified) return <VerifyEmailNotice email={user.email} />;
  return <Outlet />;
};

/** Only for signed-out visitors (login, register…). */
export const GuestRoute = () => {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullPageLoader />;
  if (user) {
    const redirect = new URLSearchParams(location.search).get('redirect');
    return <Navigate to={redirect?.startsWith('/') && !redirect.startsWith('//') ? redirect : '/'} replace />;
  }
  return <Outlet />;
};

/** Platform role gate (e.g. SUPER_ADMIN only pages). */
export const RequireRole = ({ roles, children }: { roles: UserRole[]; children: ReactNode }) => {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Access restricted"
        description="You don't have permission to view this page. Contact a platform administrator if you need access."
      />
    );
  }
  return <>{children}</>;
};

const VerifyEmailNotice = ({ email }: { email: string }) => {
  const { logout, refetch } = useAuth();
  const [sending, setSending] = useState(false);
  const resend = async () => {
    setSending(true);
    try {
      await authApi.resendVerification();
      toast.success('Verification email sent');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="card w-full max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
          <MailWarning className="h-6 w-6 text-amber-600" />
        </div>
        <h1 className="text-lg font-semibold">Verify your email</h1>
        <p className="mt-2 text-sm text-slate-600">
          We sent a verification link to <strong>{email}</strong>. Open it to activate your account.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button onClick={resend} loading={sending}>
            Resend verification email
          </Button>
          <Button variant="secondary" onClick={() => refetch()}>
            I've verified — continue
          </Button>
          <Button variant="ghost" onClick={() => logout()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
};
