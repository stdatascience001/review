import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Tone } from '@/lib/labels';
import { cn, initials } from '@/lib/utils';
import type { PublicUser } from '@/types/api';

const tones: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  indigo: 'bg-brand-50 text-brand-700 ring-brand-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  teal: 'bg-teal-50 text-teal-700 ring-teal-200',
};

export const Badge = ({ tone = 'gray', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
      tones[tone],
      className,
    )}
  >
    {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
    {children}
  </span>
);

const AVATAR_COLORS = ['bg-indigo-500', 'bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-violet-500', 'bg-teal-500'];

export const Avatar = ({ user, size = 'md' }: { user: Pick<PublicUser, 'name' | 'avatarUrl'> | null; size?: 'xs' | 'sm' | 'md' | 'lg' }) => {
  const dims = { xs: 'h-6 w-6 text-[10px]', sm: 'h-7 w-7 text-xs', md: 'h-9 w-9 text-sm', lg: 'h-12 w-12 text-base' }[size];
  if (!user) return <span className={cn('inline-flex items-center justify-center rounded-full bg-slate-200 text-slate-500', dims)}>?</span>;
  if (user.avatarUrl) {
    return <img src={user.avatarUrl} alt={user.name} referrerPolicy="no-referrer" className={cn('rounded-full object-cover', dims)} />;
  }
  const color = AVATAR_COLORS[[...user.name].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  return (
    <span title={user.name} className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', color, dims)}>
      {initials(user.name)}
    </span>
  );
};

export const UserCell = ({ user, subtitle }: { user: PublicUser | null; subtitle?: ReactNode }) =>
  user ? (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar user={user} size="sm" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-slate-900">{user.name}</div>
        <div className="truncate text-xs text-slate-500">{subtitle ?? user.email}</div>
      </div>
    </div>
  ) : (
    <span className="text-sm text-slate-400">Unassigned</span>
  );

export const Skeleton = ({ className }: { className?: string }) => <div className={cn('skeleton', className)} />;

export const TableSkeleton = ({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) => (
  <div className="divide-y divide-slate-100" data-testid="table-skeleton">
    {Array.from({ length: rows }, (_, r) => (
      <div key={r} className="flex items-center gap-4 px-4 py-3.5">
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} className={cn('h-4', c === 0 ? 'w-1/4' : 'flex-1')} />
        ))}
      </div>
    ))}
  </div>
);

export const EmptyState = ({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) => (
  <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
      <Icon className="h-6 w-6 text-brand-600" />
    </div>
    <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
    {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const PageHeader = ({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) => (
  <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const Pagination = ({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) => {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
      <span>
        Showing <span className="font-medium text-slate-900">{from}</span>–<span className="font-medium text-slate-900">{to}</span> of{' '}
        <span className="font-medium text-slate-900">{total}</span>
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md border border-slate-200 p-1.5 hover:bg-slate-50 disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-2">
          Page {page} of {Math.max(totalPages, 1)}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md border border-slate-200 p-1.5 hover:bg-slate-50 disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export const ProgressBar = ({ percent, className }: { percent: number; className?: string }) => (
  <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-slate-100', className)} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
    <div
      className={cn('h-full rounded-full transition-all', percent >= 100 ? 'bg-emerald-500' : 'bg-brand-500')}
      style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
    />
  </div>
);

/** Simple responsive table shell. */
export const Table = ({ children }: { children: ReactNode }) => (
  <div className="overflow-x-auto">
    <table className="min-w-full divide-y divide-slate-100 text-sm">{children}</table>
  </div>
);

export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th scope="col" className={cn('whitespace-nowrap bg-slate-50/80 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', className)}>
    {children}
  </th>
);

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cn('px-4 py-3 align-middle text-slate-700', className)}>{children}</td>
);

export const StatCard = ({
  label,
  value,
  icon: Icon,
  tone = 'indigo',
  hint,
  loading,
  onClick,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone?: Tone;
  hint?: ReactNode;
  loading?: boolean;
  onClick?: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={!onClick}
    data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}
    className={cn('card flex items-start justify-between p-5 text-left transition', onClick && 'hover:border-brand-200 hover:shadow-md')}
  >
    <div>
      <p className="text-sm font-medium text-slate-500">{label}</p>
      {loading ? <Skeleton className="mt-2 h-8 w-16" /> : <p className="mt-1 text-3xl font-semibold tracking-tight text-slate-900" data-value>{value}</p>}
      {hint && !loading && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
    <span className={cn('flex h-10 w-10 items-center justify-center rounded-lg ring-1 ring-inset', tones[tone])}>
      <Icon className="h-5 w-5" />
    </span>
  </button>
);
