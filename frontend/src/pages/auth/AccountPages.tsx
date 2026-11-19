import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, MailCheck, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { authApi } from '@/api/auth';
import { teamApi } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Form';
import { useAuth } from '@/hooks/useAuth';
import { getErrorMessage } from '@/lib/api';
import { WEBSITE_ROLE_LABEL } from '@/lib/labels';
import { AuthLayout } from './AuthLayout';
import { Divider, GoogleButton } from './LoginPage';

const PASSWORD_HINT = 'At least 8 characters, including a letter and a number';

// ───────────── Register ─────────────
export const RegisterPage = () => {
  const [params] = useSearchParams();
  const redirect = params.get('redirect') || '/';
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [form, setForm] = useState({ name: '', email: params.get('email') ?? '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user } = await authApi.register(form);
      setUser(user);
      toast.success('Account created. Check your inbox to verify your email.');
      navigate(redirect.startsWith('/') ? redirect : '/', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Create your account" subtitle="Start managing website feedback in minutes.">
      <GoogleButton redirect={redirect} />
      <Divider />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Full name" autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          hint={PASSWORD_HINT}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        {error && (
          <p role="alert" className="whitespace-pre-line rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link to={`/login${redirect !== '/' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`} className="font-medium text-brand-600">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
};

// ───────────── Forgot password ─────────────
export const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const mutation = useMutation({
    mutationFn: () => authApi.forgotPassword(email),
    onSuccess: () => setSent(true),
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <AuthLayout title="Forgot your password?" subtitle="We'll email you a link to reset it.">
      {sent ? (
        <div className="rounded-xl bg-emerald-50 p-5 text-sm text-emerald-800">
          <MailCheck className="mb-2 h-6 w-6" />
          If an account exists for <strong>{email}</strong>, a password reset link has been sent.
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="space-y-4"
        >
          <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" size="lg" className="w-full" loading={mutation.isPending}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link to="/login" className="font-medium text-brand-600">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
};

// ───────────── Reset password ─────────────
export const ResetPasswordPage = () => {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: () => authApi.resetPassword(token, password),
    onSuccess: (d) => {
      toast.success(d.message);
      navigate('/login', { replace: true });
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  return (
    <AuthLayout title="Set a new password">
      {!token ? (
        <p className="text-sm text-red-600">This reset link is missing its token. Request a new one.</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            if (password !== confirm) return setError('Passwords do not match');
            mutation.mutate();
          }}
        >
          <Input label="New password" type="password" autoComplete="new-password" required hint={PASSWORD_HINT} value={password} onChange={(e) => setPassword(e.target.value)} />
          <Input label="Confirm password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {error && <p role="alert" className="whitespace-pre-line rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <Button type="submit" size="lg" className="w-full" loading={mutation.isPending}>
            Reset password
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link to="/forgot-password" className="font-medium text-brand-600">Request a new link</Link>
      </p>
    </AuthLayout>
  );
};

// ───────────── Verify email ─────────────
export const VerifyEmailPage = () => {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { refetch } = useAuth();
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // tokens are single-use: guard against StrictMode double effects
    ran.current = true;
    if (!token) {
      setState('error');
      setMessage('Verification token is missing.');
      return;
    }
    authApi
      .verifyEmail(token)
      .then(async () => {
        await refetch(); // the signed-in user's profile is now verified
        setState('ok');
      })
      .catch((err) => {
        setState('error');
        setMessage(getErrorMessage(err));
      });
  }, [token, refetch]);

  return (
    <AuthLayout title="Email verification">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 p-8 text-center">
        {state === 'loading' && <Loader2 className="h-8 w-8 animate-spin text-brand-600" />}
        {state === 'ok' && (
          <>
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="font-medium">Your email has been verified.</p>
            <Link to="/" className="font-medium text-brand-600">Go to dashboard →</Link>
          </>
        )}
        {state === 'error' && (
          <>
            <XCircle className="h-10 w-10 text-red-500" />
            <p className="text-sm text-slate-600">{message}</p>
            <Link to="/" className="font-medium text-brand-600">Continue</Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
};

// ───────────── Accept invitation ─────────────
export const AcceptInvitePage = () => {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { user, refetch } = useAuth();
  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => teamApi.previewInvitation(token),
    enabled: Boolean(token),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => teamApi.acceptInvitation(token),
    onSuccess: async (d) => {
      await refetch();
      toast.success(`You joined ${d.websiteName}`);
      navigate(`/websites/${d.websiteId}`, { replace: true });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const here = `/accept-invite?token=${encodeURIComponent(token)}`;
  const inv = preview.data;

  return (
    <AuthLayout title="Team invitation">
      {preview.isLoading && <Loader2 className="mx-auto h-8 w-8 animate-spin text-brand-600" />}
      {(preview.isError || !token) && (
        <div className="rounded-xl bg-red-50 p-5 text-sm text-red-700">
          {token ? getErrorMessage(preview.error) : 'The invitation link is incomplete.'}
        </div>
      )}
      {inv && (
        <div className="space-y-5">
          <div className="rounded-xl border border-slate-200 p-5">
            <p className="text-sm text-slate-600">
              {inv.invitedBy ? <strong>{inv.invitedBy}</strong> : 'You'} invited <strong>{inv.email}</strong> to join
            </p>
            <p className="mt-2 text-lg font-semibold">{inv.website.name}</p>
            <p className="mt-1 text-sm text-slate-500">Role: {WEBSITE_ROLE_LABEL[inv.role]}</p>
          </div>
          {!user ? (
            <div className="space-y-2">
              {inv.accountExists ? (
                <Button size="lg" className="w-full" onClick={() => navigate(`/login?redirect=${encodeURIComponent(here)}`)}>
                  Sign in to accept
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => navigate(`/register?email=${encodeURIComponent(inv.email)}&redirect=${encodeURIComponent(here)}`)}
                >
                  Create account to accept
                </Button>
              )}
            </div>
          ) : user.email !== inv.email ? (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              You're signed in as {user.email}. Sign out and sign in as {inv.email} to accept this invitation.
            </p>
          ) : (
            <Button size="lg" className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>
              Accept invitation
            </Button>
          )}
        </div>
      )}
    </AuthLayout>
  );
};
