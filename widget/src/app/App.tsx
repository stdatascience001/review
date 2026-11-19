import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { isApiError } from '../shared/api';
import type { Counts, Me, MountContext, PageInfo, SelfUser, Task, TaskPage } from '../shared/types';
import type { AuthMode } from './AuthModal';
import { ConfirmProvider } from './confirm';
import { TaskCard } from './TaskCard';
import { connectLive } from './live';
import { clearPendingFocus, readPendingFocus, samePage, savePendingFocus, waitForElement, type PendingFocus } from './element';
import { ElementBox, Picker } from './Overlays';

// Views other than the task list are separate chunks, fetched when first used.
const AuthModal = lazy(() => import('./AuthModal').then((m) => ({ default: m.AuthModal })));
const CreateTask = lazy(() => import('./CreateTask').then((m) => ({ default: m.CreateTask })));
const TaskDetail = lazy(() => import('./TaskDetail').then((m) => ({ default: m.TaskDetail })));
import { Avatar, Icon, Spinner } from './ui';

type Tab = 'all' | 'open' | 'in_progress' | 'done' | 'archived';
const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'done', label: 'Done' },
  { id: 'archived', label: 'Archived' },
];

interface ListState {
  items: Task[];
  counts: Counts | null;
  page: number;
  totalPages: number;
  loading: boolean;
  loadingMore: boolean;
  error: string;
}
const emptyList: ListState = { items: [], counts: null, page: 1, totalPages: 1, loading: false, loadingMore: false, error: '' };

const useDebounced = <T,>(value: T, ms: number) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};

export const App = ({ ctx }: { ctx: MountContext }) => {
  const { api, config } = ctx;
  const [open, setOpen] = useState(ctx.isOpen());
  const [signedIn, setSignedIn] = useState(Boolean(api.getSession()));
  const [me, setMe] = useState<Me | null>(ctx.me);
  const [meLoading, setMeLoading] = useState(false);
  const [page, setPage] = useState<PageInfo>(ctx.getPage());
  const [tab, setTab] = useState<Tab>('all');
  const [scope, setScope] = useState<'all' | 'page'>('all');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [view, setView] = useState<'list' | 'create'>('list');
  /** Task opened in the detail view (focus = jump to the comments). */
  const [detail, setDetail] = useState<{ id: string; focus?: 'comments' } | null>(null);
  const [auth, setAuth] = useState<AuthMode | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [list, setList] = useState<ListState>(emptyList);
  const [toastMsg, setToastMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  // "Add a Comment": element picking mode, and the element picked for the new comment
  // (a stack, so "Wider" / "Narrower" can walk up and back down the page structure).
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Element[]>([]);
  const pickedEl = picked[picked.length - 1] ?? null;
  // "Show on page": the element of a comment, located and highlighted on the page.
  const [located, setLocated] = useState<{ el: Element | null; focus: PendingFocus; missing?: boolean } | null>(null);
  const siteId = config.site.siteId;
  const panelRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  const toast = useCallback((text: string, error?: boolean) => setToastMsg({ text, error }), []);
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3500);
    return () => clearTimeout(t);
  }, [toastMsg]);

  // ── wiring to the loader ──
  useEffect(() => ctx.onOpenChange(setOpen), [ctx]);
  useEffect(() => ctx.onPageChange(setPage), [ctx]);
  useEffect(
    () =>
      api.onSession((s) => {
        setSignedIn(Boolean(s));
        if (!s) {
          setMe(null);
          setList(emptyList);
          ctx.setBadge(null);
        }
      }),
    [api, ctx],
  );

  const meLoadedAt = useRef(ctx.me ? Date.now() : 0);
  const loadMe = useCallback(async () => {
    if (!api.getSession()) return null;
    setMeLoading(true);
    try {
      const m = await api.request<Me>('/me');
      meLoadedAt.current = Date.now();
      setMe(m);
      ctx.setBadge(m.access ? (m.counts?.open ?? null) : null);
      return m;
    } catch {
      return null;
    } finally {
      setMeLoading(false);
    }
  }, [api, ctx]);

  // Refresh the profile when the panel opens or the visitor signs in (access may have
  // changed), but not on every quick close/reopen.
  useEffect(() => {
    if (open && signedIn && Date.now() - meLoadedAt.current > 30_000) void loadMe();
  }, [open, signedIn, loadMe]);

  const ready = Boolean(me?.access && me.user.emailVerified);

  // Run the action the visitor attempted before signing in; drop it if they have no access.
  useEffect(() => {
    if (me && !me.access) pendingAction.current = null;
    if (ready && pendingAction.current) {
      const action = pendingAction.current;
      pendingAction.current = null;
      action();
    }
  }, [ready, me]);

  /** Protected actions: open the login popup first when needed. */
  const requireAuth = useCallback(
    (action: () => void) => {
      if (!api.getSession()) {
        pendingAction.current = action;
        setAuth('login');
        return;
      }
      if (!me?.user.emailVerified) return toast('Verify your email address first.', true);
      if (!me.access) return toast("You don't have access to review this website.", true);
      action();
    },
    [api, me, toast],
  );

  // ── tasks ──
  const fetchPage = useCallback(
    async (pageNo: number) => {
      const params = new URLSearchParams({ tab, page: String(pageNo), pageSize: '20' });
      if (scope === 'page') params.set('pageUrl', page.url);
      if (mine) params.set('mine', 'true');
      if (q) params.set('q', q);
      return api.request<TaskPage>(`/tasks?${params}`);
    },
    [api, tab, scope, page.url, mine, q],
  );

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    setList((l) => ({ ...l, loading: true, error: '' }));
    try {
      const res = await fetchPage(1);
      if (seq !== requestSeq.current) return;
      setList({ ...emptyList, items: res.items, counts: res.counts, page: 1, totalPages: res.pagination.totalPages });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setList((l) => ({ ...l, loading: false, error: isApiError(err) ? err.message : 'Could not load tasks' }));
    }
  }, [fetchPage]);

  useEffect(() => {
    if (open && ready && view === 'list' && !detail) void reload();
  }, [open, ready, view, detail, reload]);

  const loadMore = async () => {
    setList((l) => ({ ...l, loadingMore: true }));
    try {
      const res = await fetchPage(list.page + 1);
      setList((l) => ({ ...l, items: [...l.items, ...res.items], page: l.page + 1, counts: res.counts, totalPages: res.pagination.totalPages, loadingMore: false }));
    } catch (err) {
      setList((l) => ({ ...l, loadingMore: false }));
      toast(isApiError(err) ? err.message : 'Could not load more', true);
    }
  };

  const archive = async (task: Task, archived: boolean) => {
    try {
      await api.request<Task>(`/tasks/${task.id}/archive`, { method: archived ? 'POST' : 'DELETE' });
      toast(archived ? 'Task archived' : 'Task restored');
      await Promise.all([reload(), loadMe()]);
    } catch (err) {
      toast(isApiError(err) ? err.message : 'Could not update the task', true);
    }
  };

  const openTask = useCallback((task: Task, focus?: 'comments') => setDetail({ id: task.id, focus }), []);

  // ── element comments ──
  useEffect(() => {
    ctx.host.toggleAttribute('data-picking', picking);
  }, [picking, ctx]);

  const startPicking = useCallback(() => {
    setDetail(null);
    setLocated(null);
    setMenuOpen(false);
    setPicking(true);
  }, []);
  const cancelPicking = () => setPicking(false);
  const finishCreate = () => {
    setView('list');
    setPicked([]);
  };

  /** Locates and highlights a comment's element on this page (waits for late content). */
  const runFocus = useCallback(
    async (f: PendingFocus) => {
      if (!f.element) return setLocated({ el: null, focus: f });
      const el = await waitForElement(f.element);
      if (!el) return setLocated({ el: null, focus: f, missing: true });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (window.innerWidth < 640) ctx.setOpen(false); // full-screen popup would cover it
      setLocated({ el, focus: f });
    },
    [ctx],
  );

  /** "Show on page": same page → scroll + highlight; other page → go there, then highlight. */
  const showOnPage = useCallback(
    (task: Task) => {
      if (!task.pageUrl) return;
      const f = { taskId: task.id, key: task.key, pageUrl: task.pageUrl, element: task.element };
      savePendingFocus(siteId, f);
      if (samePage(task.pageUrl, location.href)) void runFocus({ ...f, at: Date.now() });
      else window.location.assign(task.pageUrl);
    },
    [siteId, runFocus],
  );
  const dismissLocated = () => {
    clearPendingFocus(siteId);
    setLocated(null);
  };

  // After a redirect (or a refresh), highlight the element the visitor asked to see.
  useEffect(() => {
    const f = readPendingFocus(siteId);
    if (f && samePage(f.pageUrl, location.href)) void runFocus(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // SPA navigation away from the page: the highlight no longer applies.
  useEffect(() => {
    setLocated((l) => (l && !samePage(l.focus.pageUrl, page.url) ? null : l));
  }, [page.url]);

  // Links from the dashboard: …?wrtm_task=<id> opens that comment's element on the page.
  const linkedTask = useRef<string | null>(null);
  if (linkedTask.current === null) {
    try {
      linkedTask.current = new URL(location.href).searchParams.get('wrtm_task') ?? '';
    } catch {
      linkedTask.current = '';
    }
  }
  useEffect(() => {
    const id = linkedTask.current;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    const consume = () => {
      linkedTask.current = '';
      try {
        const u = new URL(location.href);
        u.searchParams.delete('wrtm_task');
        history.replaceState(history.state, '', u.href);
      } catch {
        /* ignore */
      }
    };
    const run = async () => {
      try {
        showOnPage(await api.request<Task>(`/tasks/${id}`));
      } catch {
        ctx.notify('Could not open that comment.');
      }
    };
    if (ready) {
      consume();
      void run();
    } else if (!signedIn) {
      consume();
      pendingAction.current = () => void run();
      ctx.setOpen(true);
      setAuth('login');
    } else if (!me) {
      void loadMe(); // signed in: the profile isn't loaded until the popup opens
    }
  }, [ready, signedIn, me, api, ctx, showOnPage, loadMe]);
  const detailOpen = useRef(false);
  detailOpen.current = detail !== null;
  // Something changed in the detail view (status, comments, read): keep the badge fresh, and
  // refresh the list if the change finished after the user already went back to it.
  const onDetailChanged = useCallback(() => {
    void loadMe();
    if (!detailOpen.current) void reload();
  }, [loadMe, reload]);

  // ── real-time ──
  const [detailVersion, setDetailVersion] = useState(0);
  const live = useRef({ open, view, detail, reload, loadMe, toast, userId: me?.user.id });
  live.current = { open, view, detail, reload, loadMe, toast, userId: me?.user.id };
  const liveReady = Boolean(signedIn && me?.access && me.user.emailVerified);
  useEffect(() => {
    if (!liveReady) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    void connectLive(api, {
      onEvent: (e) => {
        const l = live.current;
        // Batch bursts of events into one refresh of the badge/list.
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          const now = live.current;
          void now.loadMe();
          if (now.open && now.view === 'list' && !now.detail) void now.reload();
        }, 300);
        if (l.detail?.id === e.task.id) setDetailVersion((v) => v + 1);
        if (e.actor?.id !== l.userId && (e.personal || e.type === 'task.created')) {
          if (l.open) l.toast(e.message);
          else ctx.notify(e.message);
        }
      },
    }).then((s) => {
      if (cancelled) s();
      else stop = s;
    });
    return () => {
      cancelled = true;
      clearTimeout(refreshTimer);
      stop?.();
    };
  }, [liveReady, api, ctx]);

  // ── keyboard + focus ──
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (picking) return cancelPicking();
      if (auth) setAuth(null);
      else if (menuOpen) setMenuOpen(false);
      else if (detail) setDetail(null);
      else ctx.setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, auth, menuOpen, detail, ctx, picking]);

  const signOut = async () => {
    setMenuOpen(false);
    try {
      await api.request('/auth/logout', { method: 'POST' });
    } catch {
      /* revoke best-effort; local sign-out always happens */
    }
    api.setSession(null);
    setView('list');
    setDetail(null);
    toast('Signed out');
  };

  const onSignedIn = (_user: SelfUser) => {
    setAuth(null);
    meLoadedAt.current = 0; // force a fresh /me for the new account (done once, by the effect above)
    setSignedIn(true);
    toast('Signed in');
  };

  // ── on-page overlays (rendered even while the popup is closed) ──
  const overlays = (
    <>
      {picking && (
        <Picker
          host={ctx.host}
          brand={config.site.brandColor ?? '#4f46e5'}
          onPick={(el) => {
            setPicked([el]);
            setPicking(false);
            setView('create');
          }}
          onWholePage={() => {
            setPicked([]);
            setPicking(false);
            setView('create');
          }}
          onCancel={cancelPicking}
        />
      )}
      {open && !picking && view === 'create' && pickedEl && <ElementBox el={pickedEl} tone="selected" testId="selected-element" />}
      {located?.el && (
        <ElementBox el={located.el} tone="focus" testId="element-highlight" label={<span className="el-tag">{located.focus.key}</span>}>
          <button
            type="button"
            className="btn btn-primary btn-xs"
            onClick={() => {
              const id = located.focus.taskId;
              ctx.setOpen(true);
              if (ready) setDetail({ id });
              else if (!api.getSession()) requireAuth(() => setDetail({ id }));
              else {
                // Profile still loading (panel mounted early for the highlight): continue once ready.
                pendingAction.current = () => setDetail({ id });
                void loadMe();
              }
            }}
          >
            Open
          </button>
          <button type="button" className="btn btn-secondary btn-xs" aria-label="Dismiss highlight" onClick={dismissLocated}>
            <Icon name="x" size={12} />
          </button>
        </ElementBox>
      )}
      {located && !located.el && (
        <div className="focus-notice" role="status" data-testid="focus-notice">
          <span>
            {located.missing
              ? `${located.focus.key}: this element is no longer on the page. It may have been changed or removed.`
              : `${located.focus.key} is about this whole page.`}
          </span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismissLocated}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </>
  );

  if (!open) return overlays;

  const counts = list.counts;
  const canCreate = me?.access?.canCreate ?? false;

  // ── body ──
  let body: ReactElement;
  if (!signedIn) {
    body = (
      <div className="empty">
        <div className="ico">
          <Icon name="lock" size={22} />
        </div>
        <h3>Sign in to review</h3>
        <p>See comments on {config.site.name}, report issues, and reply to your team.</p>
        <button type="button" className="btn btn-primary" onClick={() => setAuth('login')}>
          Sign in
        </button>
        {config.auth.registration && (
          <button type="button" className="link-btn" onClick={() => setAuth('register')}>
            Create an account
          </button>
        )}
      </div>
    );
  } else if (!me) {
    body = <div className="empty">{meLoading ? <Spinner /> : <p>Couldn't load your profile.</p>}</div>;
  } else if (!me.user.emailVerified) {
    body = <VerifyEmail ctx={ctx} me={me} onCheck={loadMe} toast={toast} />;
  } else if (!me.access) {
    body = (
      <div className="empty">
        <div className="ico">
          <Icon name="lock" size={22} />
        </div>
        <h3>No access to this website</h3>
        <p>
          You're signed in as {me.user.email}, but you aren't a member of {config.site.name}. Ask the site owner to invite you.
        </p>
      </div>
    );
  } else if (list.loading && list.items.length === 0) {
    body = (
      <div className="list" aria-busy="true" aria-label="Loading tasks">
        {[0, 1, 2].map((i) => (
          <div className="card" key={i}>
            <div className="card-head">
              <span className="avatar skeleton" />
              <div className="who">
                <div className="skeleton" style={{ height: 12, width: '45%' }} />
              </div>
            </div>
            <div className="skeleton" style={{ height: 14, width: '80%', marginTop: 12 }} />
            <div className="skeleton" style={{ height: 12, width: '60%', marginTop: 8 }} />
          </div>
        ))}
      </div>
    );
  } else if (list.error) {
    body = (
      <div className="empty">
        <div className="ico">
          <Icon name="alert" size={22} />
        </div>
        <h3>Something went wrong</h3>
        <p>{list.error}</p>
        <button type="button" className="btn btn-secondary" onClick={() => void reload()}>
          Try again
        </button>
      </div>
    );
  } else if (list.items.length === 0) {
    const filtered = scope === 'page' || mine || q || tab !== 'all';
    body = (
      <div className="empty">
        <div className="ico">
          <Icon name="inbox" size={22} />
        </div>
        <h3>{filtered ? 'No matching comments' : 'No comments yet'}</h3>
        <p>{filtered ? 'Try another tab or clear the filters.' : 'Spotted something? Add the first comment for this website.'}</p>
      </div>
    );
  } else {
    body = (
      <>
        <div className="list" aria-busy={list.loading}>
          {groupByPage(list.items, page.url).map((g) => (
            <section key={g.key} className="page-group" data-testid="page-group" aria-label={`Comments on ${g.label}`}>
              <h3 className="page-head">
                <span className="page-path" title={g.url}>
                  {g.label}
                </span>
                {g.here && <span className="here">This page</span>}
                <span className="n">{g.items.length}</span>
              </h3>
              {g.items.map((t) => (
                <TaskCard key={t.id} task={t} signedIn={signedIn} requireAuth={requireAuth} onOpen={openTask} onArchive={archive} onShow={showOnPage} />
              ))}
            </section>
          ))}
        </div>
        {list.page < list.totalPages && (
          <div className="more">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadMore()} disabled={list.loadingMore}>
              {list.loadingMore && <Spinner />} Load more
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
    {overlays}
    {/* Hidden (not unmounted) while picking an element, so a half-written comment survives. */}
    <div className="panel" role="dialog" aria-label="Review comments" ref={panelRef} tabIndex={-1} style={picking ? { display: 'none' } : undefined}>
      <ConfirmProvider>
      <Suspense fallback={<div className="empty"><Spinner /></div>}>
      {detail && me && ready ? (
        <TaskDetail
          key={detail.id}
          version={detailVersion}
          api={api}
          taskId={detail.id}
          focus={detail.focus}
          me={me.user}
          onBack={() => setDetail(null)}
          onChanged={onDetailChanged}
          toast={toast}
          onShowOnPage={showOnPage}
        />
      ) : view === 'create' && me ? (
        <CreateTask
          api={api}
          me={me}
          page={page}
          host={ctx.host}
          element={pickedEl}
          canNarrow={picked.length > 1}
          onWider={() => {
            const parent = pickedEl?.parentElement;
            if (parent && parent !== document.body && parent !== document.documentElement) setPicked((p) => [...p, parent]);
          }}
          onNarrower={() => setPicked((p) => (p.length > 1 ? p.slice(0, -1) : p))}
          onRepick={() => setPicking(true)}
          onRemoveElement={() => setPicked([])}
          onCancel={finishCreate}
          onCreated={(task, warning) => {
            finishCreate();
            toast(warning ?? `Task created — ${task.key}`, Boolean(warning));
            void loadMe(); // open-task count + badge
          }}
        />
      ) : (
        <>
          <header className="header">
            <h2>Review Comments</h2>
            {ready && counts && <span className="count-chip" data-testid="open-count">{counts.open} open</span>}
            <span className="spacer" />
            <button type="button" className="icon-btn" aria-label="Close review comments" onClick={() => ctx.setOpen(false)}>
              <Icon name="x" size={18} />
            </button>
          </header>

          <div className="tabs" role="tablist" aria-label="Filter by status">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {ready && counts && <span className="n">{counts[t.id]}</span>}
              </button>
            ))}
          </div>

          <div className="filters">
            <label className="sr-only" htmlFor="wrtm-scope">
              Pages
            </label>
            <select id="wrtm-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'page')}>
              <option value="all">All Pages</option>
              <option value="page">This Page</option>
            </select>
            <button
              type="button"
              className="chip-toggle"
              aria-pressed={mine}
              onClick={() => requireAuth(() => setMine((m) => !m))}
            >
              Mine
            </button>
            <div className="search">
              <Icon name="search" size={14} />
              <label className="sr-only" htmlFor="wrtm-search">
                Search
              </label>
              <input
                id="wrtm-search"
                className="input"
                type="search"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="body">{body}</div>

          <footer className="footer">
            <button
              type="button"
              className="btn btn-primary"
              disabled={signedIn && Boolean(me?.access) && !canCreate}
              title={signedIn && me?.access && !canCreate ? "You can't create tasks on this website" : undefined}
              onClick={() => requireAuth(startPicking)}
            >
              <Icon name="plus" /> Add a Comment
            </button>
            {signedIn && me ? (
              <div className="profile">
                <button
                  type="button"
                  className="profile-btn"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={`Account: ${me.user.name}`}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  <Avatar user={me.user} />
                  <span className="name">{me.user.name}</span>
                </button>
                {menuOpen && (
                  <div className="menu" role="menu">
                    <div className="who">
                      <div className="name">{me.user.name}</div>
                      <div className="email">{me.user.email}</div>
                    </div>
                    <button type="button" role="menuitem" className="menu-item" onClick={() => void signOut()}>
                      <Icon name="logout" size={14} /> Sign out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              !signedIn && (
                <button type="button" className="btn btn-secondary" onClick={() => setAuth('login')}>
                  Sign in
                </button>
              )
            )}
          </footer>
        </>
      )}

      {auth && (
        <AuthModal
          api={api}
          config={config}
          initialMode={auth}
          onClose={() => {
            pendingAction.current = null;
            setAuth(null);
          }}
          onSignedIn={onSignedIn}
        />
      )}
      </Suspense>
      </ConfirmProvider>
      {toastMsg && (
        <div className={toastMsg.error ? 'toast error' : 'toast'} role={toastMsg.error ? 'alert' : 'status'}>
          {toastMsg.text}
        </div>
      )}
    </div>
    </>
  );
};

// ── page-wise grouping of the comment list ──
interface PageGroup {
  key: string;
  url: string;
  label: string;
  here: boolean;
  items: Task[];
}
const pageKey = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return url;
  }
};
const pathLabel = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
};
/** Groups the list by page (in list order: newest first), with the current page on top. */
const groupByPage = (items: Task[], currentUrl: string): PageGroup[] => {
  const groups = new Map<string, PageGroup>();
  const current = pageKey(currentUrl);
  for (const t of items) {
    const key = t.pageUrl ? pageKey(t.pageUrl) : '';
    let g = groups.get(key);
    if (!g) {
      g = { key: key || 'none', url: t.pageUrl ?? '', label: t.pageUrl ? pathLabel(t.pageUrl) : 'No page', here: key === current, items: [] };
      groups.set(key, g);
    }
    g.items.push(t);
  }
  return [...groups.values()].sort((a, b) => Number(b.here) - Number(a.here));
};

const VerifyEmail = ({
  ctx,
  me,
  onCheck,
  toast,
}: {
  ctx: MountContext;
  me: Me;
  onCheck: () => Promise<Me | null>;
  toast: (m: string, e?: boolean) => void;
}) => {
  const [busy, setBusy] = useState<'' | 'resend' | 'check'>('');
  return (
    <div className="empty">
      <div className="ico">
        <Icon name="mail" size={22} />
      </div>
      <h3>Verify your email</h3>
      <p>We sent a verification link to {me.user.email}. Open it, then come back here.</p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy !== ''}
        onClick={async () => {
          setBusy('check');
          const m = await onCheck();
          setBusy('');
          if (m && !m.user.emailVerified) toast('Not verified yet. Check your inbox.', true);
        }}
      >
        {busy === 'check' && <Spinner />} I've verified my email
      </button>
      <button
        type="button"
        className="link-btn"
        disabled={busy !== ''}
        onClick={async () => {
          setBusy('resend');
          try {
            await ctx.api.request('/auth/resend-verification', { method: 'POST' });
            toast('Verification email sent');
          } catch (err) {
            toast(isApiError(err) ? err.message : 'Could not send the email', true);
          } finally {
            setBusy('');
          }
        }}
      >
        Resend email
      </button>
    </div>
  );
};
