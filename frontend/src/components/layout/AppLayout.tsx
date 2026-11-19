import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Bell,
  CheckSquare,
  ChevronDown,
  FolderKanban,
  Globe,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Menu,
  MessageSquare,
  ScrollText,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { notificationsApi } from '@/api/resources';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Avatar, Badge, Skeleton } from '@/components/ui/Display';
import { useAuth } from '@/hooks/useAuth';
import { RealtimeProvider, useRealtimeStatus } from '@/hooks/useRealtime';
import { useWebsiteOptions } from '@/hooks/useCommon';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  superAdminOnly?: boolean;
  /** Website owners/admins (and super admins). */
  managersOnly?: boolean;
  end?: boolean;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/analytics', label: 'Analytics', icon: BarChart3, managersOnly: true },
    ],
  },
  {
    section: 'Manage',
    items: [
      { to: '/websites', label: 'Websites', icon: Globe },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/tasks', label: 'All Tasks', icon: ListTodo, end: true },
      { to: '/tasks/mine', label: 'My Tasks', icon: CheckSquare },
      { to: '/team', label: 'Team Members', icon: Users },
      { to: '/users', label: 'Users', icon: UserCog, superAdminOnly: true },
      { to: '/audit-log', label: 'Audit Log', icon: ScrollText, superAdminOnly: true },
    ],
  },
  {
    section: 'Activity',
    items: [
      { to: '/comments', label: 'Comments', icon: MessageSquare },
      { to: '/notifications', label: 'Notifications', icon: Bell },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const PageLoading = () => (
  <div className="space-y-4" aria-busy="true" aria-label="Loading page">
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-40" />
    <Skeleton className="h-64" />
  </div>
);

/** Pushed by real-time events; polled only as a fallback while the live connection is down. */
const useUnreadCount = () => {
  const live = useRealtimeStatus() === 'live';
  return useQuery({ queryKey: ['notifications', 'unread'], queryFn: notificationsApi.unreadCount, refetchInterval: live ? false : 30_000 });
};

const LiveIndicator = () => {
  const status = useRealtimeStatus();
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-500 sm:flex"
      data-testid="live-status"
      data-status={status}
      title={status === 'live' ? 'Live updates are on' : status === 'connecting' ? 'Connecting…' : 'Live updates are off; data refreshes when you reload'}
    >
      <span className={cn('h-2 w-2 rounded-full', status === 'live' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-400' : 'bg-slate-300')} />
      {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'}
    </span>
  );
};

const Sidebar = ({ onNavigate }: { onNavigate?: () => void }) => {
  const { isSuperAdmin } = useAuth();
  const unread = useUnreadCount().data?.count ?? 0;
  const websites = useWebsiteOptions();
  const isManager = isSuperAdmin || (websites.data ?? []).some((w) => w.role === 'OWNER' || w.role === 'ADMIN');
  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-300">
      <Link to="/" onClick={onNavigate} className="flex h-16 items-center gap-2.5 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-white">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <span className="text-[15px] font-semibold text-white">Website Review</span>
      </Link>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4" aria-label="Main navigation">
        {NAV.map((group) => (
          <div key={group.section}>
            <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{group.section}</p>
            <ul className="space-y-0.5">
              {group.items
                .filter((i) => (!i.superAdminOnly || isSuperAdmin) && (!i.managersOnly || isManager))
                .map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5 hover:text-white',
                        )
                      }
                    >
                      <item.icon className="h-[18px] w-[18px] shrink-0 opacity-80" />
                      <span className="flex-1">{item.label}</span>
                      {item.to === '/notifications' && unread > 0 && (
                        <span className="rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-white/10 p-4 text-xs text-slate-500">v0.2 · Admin Dashboard</div>
    </div>
  );
};

const UserMenu = () => {
  const { user, logout, isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (!user) return null;
  const doLogout = async () => {
    await logout();
    toast.success('Signed out');
    navigate('/login', { replace: true });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-slate-100"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar user={user} size="sm" />
        <span className="hidden text-left sm:block">
          <span className="block text-sm font-medium leading-tight text-slate-900">{user.name}</span>
          <span className="block text-xs leading-tight text-slate-500">{isSuperAdmin ? 'Super Admin' : user.email}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-slate-400" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
            {isSuperAdmin && <Badge tone="violet" className="mt-2">Super Admin</Badge>}
          </div>
          <Link role="menuitem" to="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50">
            <Settings className="h-4 w-4 text-slate-400" /> Profile & settings
          </Link>
          <button role="menuitem" type="button" onClick={doLogout} className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
};

export const AppLayout = () => (
  <RealtimeProvider>
    <Shell />
  </RealtimeProvider>
);

const Shell = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const unread = useUnreadCount().data?.count ?? 0;
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <Sidebar />
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72">
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4 z-10 rounded-md p-1 text-slate-300 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1" />
          <LiveIndicator />
          <Link
            to="/notifications"
            aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
            className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <Bell className="h-5 w-5" />
            {unread > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </Link>
          <UserMenu />
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
          <ErrorBoundary key={location.pathname}>
            <Suspense fallback={<PageLoading />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
};
