import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isApiError, type Session, type WidgetApi } from '../shared/api';
import type { SelfUser, WidgetConfig } from '../shared/types';
import { GoogleIcon, Icon, Spinner } from './ui';

export type AuthMode = 'login' | 'register' | 'forgot';

interface Props {
  api: WidgetApi;
  config: WidgetConfig;
  initialMode?: AuthMode;
  onClose: () => void;
  onSignedIn: (user: SelfUser) => void;
}

const errorText = (err: unknown) => {
  if (isApiError(err)) {
    if (err.code === 'VALIDATION_ERROR' && err.details?.length) return err.details.map((d) => d.message).join('\n');
    return err.message;
  }
  return 'Something went wrong. Please try again.';
};

const GOOGLE_ERRORS: Record<string, string> = {
  google_denied: 'Google sign-in was cancelled.',
  account_suspended: 'This account is suspended.',
  invalid_state: 'Google sign-in expired. Please try again.',
  google_failed: 'Google sign-in failed. Please try again.',
};

/**
 * Sign-in popup shown when a visitor tries a protected action. Uses the Task 1 auth
 * endpoints through the widget API, which issues a session bound to this website.
 */
export const AuthModal = ({ api, config, initialMode = 'login', onClose, onSignedIn }: Props) => {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'form' | 'google' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const firstField = useRef<HTMLInputElement>(null);
  const popup = useRef<Window | null>(null);

  useEffect(() => {
    setError('');
    setNotice('');
    firstField.current?.focus();
  }, [mode]);

  // Google: the popup finishes on an API page that postMessages the session to this origin.
  useEffect(() => {
    const apiOrigin = new URL(api.apiBase).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== apiOrigin || e.data?.type !== 'wrtm:auth') return;
      setBusy(null);
      if (e.data.ok) {
        api.setSession(e.data.session as Session);
        onSignedIn(e.data.user as SelfUser);
      } else setError(GOOGLE_ERRORS[e.data.error as string] ?? GOOGLE_ERRORS.google_failed!);
    };
    window.addEventListener('message', onMessage);
    const watch = setInterval(() => {
      if (popup.current?.closed) {
        popup.current = null;
        setBusy((b) => (b === 'google' ? null : b));
      }
    }, 500);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(watch);
    };
  }, [api, onSignedIn]);

  const google = () => {
    setError('');
    const url = `${api.apiBase}/widget/auth/google?siteId=${encodeURIComponent(api.siteId)}&origin=${encodeURIComponent(location.origin)}`;
    const w = 480;
    const h = 640;
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
    popup.current = window.open(url, 'wrtm-google-signin', `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup.current) setError('Your browser blocked the sign-in popup. Allow popups for this site and try again.');
    else setBusy('google');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy('form');
    try {
      if (mode === 'forgot') {
        await api.request('/auth/forgot-password', { method: 'POST', auth: false, body: { siteId: api.siteId, email } });
        setNotice('If an account exists for that email, we sent a link to reset your password.');
        return;
      }
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = mode === 'login' ? { siteId: api.siteId, email, password } : { siteId: api.siteId, name, email, password };
      const res = await api.request<{ user: SelfUser; session: Session }>(path, { method: 'POST', auth: false, body });
      api.setSession(res.session);
      onSignedIn(res.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const title = mode === 'login' ? 'Sign in to review' : mode === 'register' ? 'Create your account' : 'Reset your password';
  const sub =
    mode === 'forgot'
      ? "Enter your email and we'll send you a reset link."
      : `Leave feedback and track tasks on ${config.site.name}.`;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="wrtm-auth-title">
        <button type="button" className="icon-btn close" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
        <form className="form" onSubmit={submit} noValidate>
          <div>
            <h3 id="wrtm-auth-title">{title}</h3>
            <p className="sub">{sub}</p>
          </div>

          {mode !== 'forgot' && config.auth.google && (
            <>
              <button type="button" className="btn btn-google btn-block" onClick={google} disabled={busy !== null}>
                {busy === 'google' ? <Spinner /> : <GoogleIcon />} Continue with Google
              </button>
              <div className="divider">or</div>
            </>
          )}

          {mode === 'register' && (
            <label className="field">
              <span className="label">Name</span>
              <input ref={firstField} className="input" name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span className="label">Email</span>
            <input
              ref={mode === 'register' ? undefined : firstField}
              className="input"
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {mode !== 'forgot' && (
            <label className="field">
              <span className="label">Password</span>
              <input
                className="input"
                type="password"
                name="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode === 'register' && <span className="hint">At least 8 characters, with a letter and a number.</span>}
            </label>
          )}
          {mode === 'login' && (
            <button type="button" className="link-btn" style={{ alignSelf: 'flex-end', marginTop: -6 }} onClick={() => setMode('forgot')}>
              Forgot password?
            </button>
          )}

          {error && (
            <div className="alert" role="alert" style={{ whiteSpace: 'pre-line' }}>
              {error}
            </div>
          )}
          {notice && (
            <div className="alert ok" role="status">
              {notice}
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy !== null}>
            {busy === 'form' && <Spinner />}
            {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}
          </button>

          <p className="center" style={{ margin: 0 }}>
            {mode === 'login' ? (
              <>
                No account?{' '}
                <button type="button" className="link-btn" onClick={() => setMode('register')}>
                  Create one
                </button>
              </>
            ) : (
              <button type="button" className="link-btn" onClick={() => setMode('login')}>
                Back to sign in
              </button>
            )}
          </p>
        </form>
      </div>
    </div>
  );
};
