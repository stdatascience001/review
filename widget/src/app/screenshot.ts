/**
 * Captures what the reviewer currently sees (the visible part of the page) as a JPEG.
 * html-to-image is loaded only when a screenshot is actually taken. The widget itself is
 * excluded. Cross-origin images that don't allow CORS may appear blank (browser security).
 */
export const captureViewport = async (exclude: Element): Promise<Blob> => {
  const { toCanvas } = await import('html-to-image');
  const width = window.innerWidth;
  const height = window.innerHeight;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  const transparent = (c: string) => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';

  const canvas = await toCanvas(document.documentElement, {
    width,
    height,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
    backgroundColor: !transparent(bodyBg) ? bodyBg : !transparent(htmlBg) ? htmlBg : '#ffffff',
    skipFonts: true, // avoids fetching the host's (possibly cross-origin) font CSS
    filter: (node) => node !== exclude && !(node instanceof HTMLScriptElement),
    style: {
      transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
      transformOrigin: '0 0',
    },
  });
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Screenshot failed'))), 'image/jpeg', 0.82),
  );
};
