import type { ElementAnchor } from '../shared/types';

/**
 * Element anchors: how a comment remembers *which element* of the page it is about, and how
 * that element is found again later (after a refresh, on another visit, after small page edits).
 *
 *  - selector: a CSS path that was unique when the comment was made (ids where stable,
 *    otherwise tag + :nth-of-type steps);
 *  - tag + text: the element's own visible text, used to confirm the selector still points at
 *    the same thing, and to find the element again when the selector no longer matches;
 *  - rect: its position in the document, used to pick between equal candidates.
 */

const TEXT_MAX = 160;
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** What a person would call this element's text. */
export const elementText = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') return norm((el as HTMLImageElement).alt) || fileName((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src);
  if (tag === 'input' || tag === 'textarea') {
    const i = el as HTMLInputElement;
    return norm(i.placeholder || i.name || i.getAttribute('aria-label') || i.type);
  }
  if (tag === 'video' || tag === 'iframe') return fileName(el.getAttribute('src') || '');
  return norm((el as HTMLElement).innerText ?? el.textContent).slice(0, TEXT_MAX);
};

const fileName = (src: string) => {
  try {
    return decodeURIComponent(new URL(src, location.href).pathname.split('/').pop() || '').slice(0, TEXT_MAX);
  } catch {
    return '';
  }
};

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

/** Framework-generated ids (React ":r1:", hashes, long numbers) change between visits. */
const stableId = (id: string) => Boolean(id) && !/^[:\d]|:|\d{4,}|[a-f0-9]{8,}/i.test(id);

const isUnique = (selector: string) => {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
};

/** A short CSS selector that matches exactly this element right now. */
export const buildSelector = (el: Element): string => {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    if (stableId(node.id) && isUnique(`#${esc(node.id)}`)) {
      parts.unshift(`#${esc(node.id)}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    let part = tag;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    // Two levels at least, so the selector survives a sibling being added elsewhere.
    if (parts.length >= 2 && isUnique(parts.join(' > '))) break;
    if (tag === 'body') break;
    node = parent;
  }
  return parts.join(' > ');
};

export const describeElement = (el: Element): ElementAnchor => {
  const r = el.getBoundingClientRect();
  const text = elementText(el);
  return {
    selector: buildSelector(el).slice(0, 1000),
    tag: el.tagName.toLowerCase(),
    ...(text ? { text: text.slice(0, TEXT_MAX) } : {}),
    rect: {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    },
    viewportWidth: window.innerWidth,
  };
};

const sameText = (el: Element, text: string | undefined) => {
  if (!text) return true;
  const now = elementText(el);
  return now === text || now.startsWith(text.slice(0, 60)) || text.startsWith(now.slice(0, 60) || '\u0000');
};

const docY = (el: Element) => el.getBoundingClientRect().top + window.scrollY;

const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
};

/**
 * Finds the anchored element on the current page:
 *  1. the selector, when it still points at an element with the same tag and text;
 *  2. otherwise any element with that tag and text (the one nearest its old position);
 *  3. otherwise the selector alone, when the tag still matches (text was edited).
 */
export const resolveElement = (a: ElementAnchor, exclude?: Element): Element | null => {
  let bySelector: Element | null = null;
  try {
    bySelector = document.querySelector(a.selector);
  } catch {
    bySelector = null;
  }
  if (bySelector && bySelector !== exclude && bySelector.tagName.toLowerCase() === a.tag && sameText(bySelector, a.text)) return bySelector;

  if (a.text) {
    const candidates = Array.from(document.getElementsByTagName(a.tag)).filter((el) => el !== exclude && visible(el) && sameText(el, a.text));
    if (candidates.length) {
      const y = a.rect?.y ?? 0;
      return candidates.sort((p, q) => Math.abs(docY(p) - y) - Math.abs(docY(q) - y))[0]!;
    }
  }
  if (bySelector && bySelector !== exclude && bySelector.tagName.toLowerCase() === a.tag) return bySelector;
  return null;
};

/** Same page, ignoring query string, hash and a trailing slash (matches the server's page filter). */
export const samePage = (a: string, b: string) => {
  try {
    const u = new URL(a);
    const v = new URL(b);
    const path = (x: URL) => x.pathname.replace(/\/+$/, '') || '/';
    return u.origin === v.origin && path(u) === path(v);
  } catch {
    return false;
  }
};

/** "H3 · 718×84" */
export const anchorLabel = (a: Pick<ElementAnchor, 'tag' | 'rect'>) =>
  `${a.tag.toUpperCase()}${a.rect ? ` · ${a.rect.width}×${a.rect.height}` : ''}`;

// ───────────── "Show on page" across navigations ─────────────

export interface PendingFocus {
  taskId: string;
  key: string;
  pageUrl: string;
  element: ElementAnchor | null;
  at: number;
}

const FOCUS_TTL = 10 * 60_000;
const focusKey = (siteId: string) => `wrtm-focus:${siteId}`;

/** Remembered in this tab until dismissed, so a refresh highlights the element again. */
export const savePendingFocus = (siteId: string, f: Omit<PendingFocus, 'at'>) => {
  try {
    sessionStorage.setItem(focusKey(siteId), JSON.stringify({ ...f, at: Date.now() }));
  } catch {
    /* storage blocked: same-page focus still works */
  }
};

export const readPendingFocus = (siteId: string): PendingFocus | null => {
  try {
    const raw = sessionStorage.getItem(focusKey(siteId));
    if (!raw) return null;
    const f = JSON.parse(raw) as PendingFocus;
    if (!f.taskId || Date.now() - f.at > FOCUS_TTL) {
      sessionStorage.removeItem(focusKey(siteId));
      return null;
    }
    return f;
  } catch {
    return null;
  }
};

export const clearPendingFocus = (siteId: string) => {
  try {
    sessionStorage.removeItem(focusKey(siteId));
  } catch {
    /* ignore */
  }
};

/** Waits for the element to appear (pages that render late, SPAs), up to `timeoutMs`. */
export const waitForElement = (a: ElementAnchor, timeoutMs = 6000): Promise<Element | null> =>
  new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = resolveElement(a);
      if (el) return resolve(el);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
