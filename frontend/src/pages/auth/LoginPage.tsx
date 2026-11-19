import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { authApi } from '@/api/auth';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Form';
import { useAuth } from '@/hooks/useAuth';
import { getErrorMessage } from '@/lib/api';
import { AuthLayout, GoogleIcon } from './AuthLayout';

const OAUTH_ERRORS: Record<string, string> = {
  google_denied: 'Google sign-in was cancelled.',
  invalid_state: 'Google sign-in expired. Please try again.',
  google_failed: 'Google sign-in failed. Please try again.',
  account_suspended: 'Your account is suspended.',
};

export const GoogleButton = ({ redirect }: { redirect: string }) => {
  const { data } = useQuery({ queryKey: ['auth-providers'], queryFn: authApi.providers, staleTime: Infinity });
  const enabled = data?.google ?? false;
  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        icon={<GoogleIcon />}
        disabled={!enabled}
        title={enabled ? undefined : 'Google sign-in is not configured on the server'}
        onClick={() => (window.location.href = authApi.googleUrl(redirect))}
      >
        Continue with Google
      </Button>
      {data && !enabled && <p className="mt-1.5 text-center text-xs text-slate-400">Google sign-in is not configured yet</p>}
    </>
  );
};

export const Divider = () => (
  <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
    <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
  </div>
);

export const LoginPage = () => {
  const [params] = useSearchParams();
  const redirect = params.get('redirect') || '/';
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const e = params.get('error');
    if (e) toast.error(OAUTH_ERRORS[e] ?? 'Sign-in failed');
  }, [params]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user } = await authApi.login({ email, password });
      setUser(user);
      toast.success(`Welcome back, ${user.name.split(' ')[0]}!`);
      navigate(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Sign in to your account" subtitle="Welcome back! Please enter your details.">
      <GoogleButton redirect={redirect} />
      <Divider />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm font-medium text-brand-600 hover:text-brand-700">
            Forgot password?
          </Link>
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        Don't have an account?{' '}
        <Link to={`/register${redirect !== '/' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`} className="font-medium text-brand-600 hover:text-brand-700">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
};
