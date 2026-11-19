/**
 * Review widget loader (dist/widget.js) — what customers embed:
 *
 *   <script src="https://YOUR-DOMAIN/widget.js" data-site-id="site_…" async></script>
 *
 * Kept deliberately tiny and dependency-free. It:
 *  - runs once per page, however many times the tag is included;
 *  - waits until the page is idle, so it never competes with the host page's own loading;
 *  - asks the API whether this Site ID may run on this domain, and adds nothing to the page if not;
 *  - renders only the floating Review button + badge, inside a Shadow DOM (no CSS leaks either way);
 *  - lazy-loads the React panel (widget-app/…) on first hover/focus/click.
 */
import { createApi, type WidgetApi } from '../shared/api';
import type { Me, MountContext, MountedWidget, PageInfo, WidgetConfig } from '../shared/types';
import loaderCss from './loader.css?inline';

declare const __APP_ENTRY__: string;
declare const __WIDGET_VERSION__: string;

interface PublicApi {
  version: string;
  open: () => void;
  close: () => void;
}

declare global {
  interface Window {
    __wrtmReviewWidget?: PublicApi | 'loading';
  }
}

const LOG = '[Review widget]';
const SITE_ID = /^site_[a-f0-9]{20}$/;

const findScript = (): HTMLScriptElement | null =>
  (document.currentScript as HTMLScriptElement | null) ??
  Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-site-id]')).find((s) => /\/widget\.js(\?|#|$)/.test(s.src)) ??
  null;

const whenIdle = (fn: () => void) => {
  const run = () =>
    'requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 200);
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
};

const ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

const init = () => {
  // Duplicate-initialization guard (tag included twice, SPA re-running layout scripts, …).
  if (window.__wrtmReviewWidget) return;
  const script = findScript();
  const siteId = script?.dataset.siteId?.trim() ?? '';
  if (!script || !SITE_ID.test(siteId)) {
    console.warn(`${LOG} missing or invalid data-site-id on the widget <script> tag.`);
    return;
  }
  window.__wrtmReviewWidget = 'loading';

  const scriptUrl = new URL(script.src, location.href);
  const apiBase = (script.dataset.apiUrl ?? `${scriptUrl.origin}/api/v1`).replace(/\/$/, '');
  const appUrl = new URL(__APP_ENTRY__, scriptUrl).href;
  const api: WidgetApi = createApi(apiBase, siteId);

  whenIdle(() => {
    boot(api, appUrl).catch((err) => {
      window.__wrtmReviewWidget = undefined;
      console.warn(`${LOG} ${err instanceof Error ? err.message : String(err)}`);
    });
  });
};

const boot = async (api: WidgetApi, appUrl: string) => {
  // Verifies the Site ID and that this domain is allowed. Nothing is added to the page otherwise.
  const config = await api.request<WidgetConfig>(`/config?siteId=${encodeURIComponent(api.siteId)}`, { auth: false });

  const host = document.createElement('wrtm-review-widget');
  // Positioning lives in the shadow :host rule (it outranks any host-page CSS).
  if (config.site.brandColor) host.style.setProperty('--wrtm-brand', config.site.brandColor);
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = loaderCss;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fab';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Open review comments');
  button.innerHTML = `${ICON}<span class="label">Review</span><span class="fab-badge" hidden></span>`;
  const badge = button.querySelector<HTMLSpanElement>('.fab-badge')!;
  // Small bubble above the button for live notifications while the popup is closed.
  const nudge = document.createElement('div');
  nudge.className = 'fab-nudge';
  nudge.setAttribute('role', 'status');
  nudge.hidden = true;
  shadow.append(style, button, nudge);
  document.body.appendChild(host);

  // ── state shared with the panel ──
  let open = false;
  let me: Me | null = null;
  const openListeners = new Set<(open: boolean) => void>();
  const pageListeners = new Set<(page: PageInfo) => void>();
  const getPage = (): PageInfo => ({ url: location.href, title: document.title });

  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (text: string) => {
    if (open) return; // the open panel shows its own toast
    nudge.textContent = text;
    nudge.hidden = false;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => (nudge.hidden = true), 6000);
  };
  nudge.addEventListener('click', () => {
    nudge.hidden = true;
    void loadPanel().then(() => setOpen(true));
  });

  const setBadge = (count: number | null) => {
    badge.hidden = !count;
    badge.textContent = count ? (count > 99 ? '99+' : String(count)) : '';
    button.setAttribute('aria-label', count ? `Open review comments (${count} open)` : 'Open review comments');
  };

  // SPA navigation: History API apps don't fire events on pushState, so while the panel is
  // open we also check the URL once a second (cheap; nothing is patched on the host page).
  let lastUrl = location.href;
  let lastTitle = document.title;
  const checkPage = () => {
    if (location.href === lastUrl && document.title === lastTitle) return;
    lastUrl = location.href;
    lastTitle = document.title;
    const page = getPage();
    pageListeners.forEach((l) => l(page));
  };
  window.addEventListener('popstate', checkPage);
  window.addEventListener('hashchange', checkPage);
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener?.('navigatesuccess', checkPage);
  let poll: ReturnType<typeof setInterval> | undefined;

  const setOpen = (value: boolean) => {
    if (open === value) return;
    open = value;
    if (open) nudge.hidden = true;
    button.setAttribute('aria-expanded', String(open));
    host.toggleAttribute('data-open', open);
    clearInterval(poll);
    if (open) {
      checkPage();
      poll = setInterval(checkPage, 1000);
    } else button.focus({ preventScroll: true });
    openListeners.forEach((l) => l(open));
  };

  // ── lazy panel ──
  let mounted: Promise<MountedWidget> | null = null;
  const loadPanel = () => {
    mounted ??= import(/* @vite-ignore */ appUrl).then((mod: { mount: (ctx: MountContext) => MountedWidget }) =>
      mod.mount({
        shadow,
        host,
        api,
        config,
        me,
        getPage,
        onPageChange: (fn) => {
          pageListeners.add(fn);
          return () => pageListeners.delete(fn);
        },
        isOpen: () => open,
        onOpenChange: (fn) => {
          openListeners.add(fn);
          return () => openListeners.delete(fn);
        },
        setOpen,
        setBadge,
        notify,
      }),
    );
    mounted.catch((err) => {
      mounted = null;
      console.error(`${LOG} could not load the review panel`, err);
    });
    return mounted;
  };

  const prefetch = () => void loadPanel().catch(() => undefined);
  button.addEventListener('pointerenter', prefetch, { once: true });
  button.addEventListener('focus', prefetch, { once: true });
  button.addEventListener('click', async () => {
    if (open) return setOpen(false);
    button.setAttribute('aria-busy', 'true');
    try {
      await loadPanel();
      setOpen(true);
    } catch {
      /* logged above */
    } finally {
      button.removeAttribute('aria-busy');
    }
  });

  window.__wrtmReviewWidget = {
    version: __WIDGET_VERSION__,
    open: () => void loadPanel().then(() => setOpen(true)),
    close: () => setOpen(false),
  };

  // "Show on page": arriving from a comment link (or refreshing while one is highlighted),
  // load the panel so it can find and highlight the element.
  let wantsFocus = false;
  try {
    wantsFocus = Boolean(sessionStorage.getItem(`wrtm-focus:${api.siteId}`)) || new URL(location.href).searchParams.has('wrtm_task');
  } catch {
    /* storage blocked */
  }
  if (wantsFocus) prefetch();

  // Open-task badge for signed-in reviewers (one request; skipped for anonymous visitors).
  // Reviewers with access also get the panel mounted in the background (idle time), so its
  // live connection keeps the badge and statuses current without reloading the page.
  if (api.getSession()) {
    try {
      me = await api.request<Me>('/me');
      setBadge(me.access ? (me.counts?.open ?? null) : null);
      if (me.access && me.user.emailVerified) whenIdle(prefetch);
    } catch {
      /* signed out or offline: no badge */
    }
  }
};

init();
