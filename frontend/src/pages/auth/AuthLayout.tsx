import { CheckCircle2, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

export const AuthLayout = ({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) => (
  <div className="flex min-h-screen">
    <div className="relative hidden w-[44%] flex-col justify-between overflow-hidden bg-slate-900 p-12 text-white lg:flex">
      <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-600/30 blur-3xl" />
      <div className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-sky-500/20 blur-3xl" />
      <div className="relative flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <span className="text-lg font-semibold">Website Review</span>
      </div>
      <div className="relative">
        <h2 className="text-3xl font-semibold leading-tight">Collect website feedback.<br />Ship fixes faster.</h2>
        <ul className="mt-8 space-y-3 text-sm text-slate-300">
          {[
            'Manage every client website from one dashboard',
            'Turn feedback into prioritised, assignable tasks',
            'Track team progress and developer performance',
          ].map((t) => (
            <li key={t} className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-brand-200" /> {t}
            </li>
          ))}
        </ul>
      </div>
      <p className="relative text-xs text-slate-500">© {new Date().getFullYear()} Website Review & Task Management</p>
    </div>
    <div className="flex flex-1 items-center justify-center bg-white px-4 py-12 sm:px-8">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </div>
  </div>
);

export const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
  </svg>
);
