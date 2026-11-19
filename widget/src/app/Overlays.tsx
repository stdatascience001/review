import { useEffect, useRef, useState, type ReactNode } from 'react';
import { anchorLabel, elementText } from './element';
import { Icon } from './ui';

/**
 * On-page overlays of the review widget (rendered in its shadow root, position: fixed):
 *  - <Picker>: "Add a Comment" element selection mode;
 *  - <ElementBox>: an outline + label drawn over one page element (hover, selected, located).
 * Nothing is added to the host page's DOM except, while picking, a temporary stylesheet that
 * outlines the selectable elements (removed as soon as picking ends).
 */

/** Elements offered for comments: content people talk about, not layout wrappers. */
export const SELECTABLE =
  'h1,h2,h3,h4,h5,h6,p,a,button,img,picture,video,svg,iframe,li,blockquote,figure,figcaption,input,textarea,select,label,th,td,dt,dd,pre,code,section,header,footer,nav,form,table';

const PICK_CLASS = 'wrtm-picking';
const PICK_STYLE_ID = 'wrtm-pick-style';

/** Follows an element's on-screen box (scroll, resize, layout changes) while mounted. */
const useRect = (el: Element | null) => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!el) return setRect(null);
    let frame = 0;
    let last = '';
    const tick = () => {
      if (!el.isConnected) setRect(null);
      else {
        const r = el.getBoundingClientRect();
        const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
        if (key !== last) {
          last = key;
          setRect(r);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [el]);
  return rect;
};

export const ElementBox = ({
  el,
  tone,
  label,
  children,
  testId,
}: {
  el: Element | null;
  tone: 'hover' | 'selected' | 'focus';
  label?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) => {
  const rect = useRect(el);
  if (!el || !rect) return null;
  const pad = 3;
  const top = rect.top - pad;
  // Label above the box, or inside it when the box touches the top of the screen.
  const labelInside = top < 26;
  return (
    <div
      className={`el-box ${tone}`}
      data-testid={testId}
      style={{ left: rect.left - pad, top, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
    >
      {(label || children) && (
        <div className={labelInside ? 'el-label inside' : 'el-label'}>
          {label}
          {children}
        </div>
      )}
    </div>
  );
};

const describeHover = (el: Element) => {
  const r = el.getBoundingClientRect();
  return anchorLabel({ tag: el.tagName.toLowerCase(), rect: { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) } });
};

export const Picker = ({
  host,
  brand,
  onPick,
  onWholePage,
  onCancel,
}: {
  host: HTMLElement;
  brand: string;
  onPick: (el: Element) => void;
  onWholePage: () => void;
  onCancel: () => void;
}) => {
  const [hovered, setHovered] = useState<Element | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    // Only the element under the cursor is outlined (the hover box below); the page itself
    // just gets a crosshair cursor while picking.
    const style = document.createElement('style');
    style.id = PICK_STYLE_ID;
    style.textContent = `html.${PICK_CLASS}, html.${PICK_CLASS} * { cursor: crosshair !important; }`;
    document.head.appendChild(style);
    document.documentElement.classList.add(PICK_CLASS);

    const fromWidget = (e: Event) => e.composedPath().includes(host);
    const targetOf = (e: Event): Element | null => {
      const t = e.composedPath()[0];
      if (!(t instanceof Element) || t === document.documentElement || t === document.body) return null;
      // Inside an SVG icon, take the whole <svg>.
      return t.closest('svg') ?? t;
    };
    const onMove = (e: PointerEvent) => {
      if (fromWidget(e)) return setHovered(null);
      setHovered(targetOf(e));
    };
    // While picking, the page must not react to clicks (links, menus, forms).
    const block = (e: Event) => {
      if (fromWidget(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click') {
        const el = targetOf(e);
        if (el) pickRef.current(el);
      }
    };
    const blocked = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'submit'] as const;
    window.addEventListener('pointermove', onMove, true);
    blocked.forEach((t) => window.addEventListener(t, block, true));
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      blocked.forEach((t) => window.removeEventListener(t, block, true));
      document.documentElement.classList.remove(PICK_CLASS);
      style.remove();
    };
  }, [host, brand]);

  return (
    <>
      <div className="pick-bar" role="dialog" aria-label="Select an element">
        <Icon name="target" size={16} />
        <span className="pick-text">Click any highlighted element to comment on it</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onWholePage}>
          Whole page
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ElementBox el={hovered} tone="hover" testId="pick-hover" label={hovered ? <span className="el-tag">{describeHover(hovered)}</span> : null} />
    </>
  );
};

/** One-line preview of an element for chips and the comment form. */
export const ElementSummary = ({ tag, text, size }: { tag: string; text?: string; size?: string }) => (
  <>
    <span className="el-tag">{size ?? tag.toUpperCase()}</span>
    <span className="el-text">{text || <em>(no text)</em>}</span>
  </>
);

export { elementText };
