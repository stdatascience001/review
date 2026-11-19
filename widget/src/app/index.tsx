import { createRoot } from 'react-dom/client';
import type { MountContext, MountedWidget } from '../shared/types';
import { App } from './App';
import css from './styles.css?inline';

/** Called by the loader (dist/widget.js) the first time the Review button is used. */
export const mount = (ctx: MountContext): MountedWidget => {
  const style = document.createElement('style');
  style.textContent = css;
  const container = document.createElement('div');
  container.className = 'root';
  ctx.shadow.append(style, container);

  const root = createRoot(container);
  root.render(<App ctx={ctx} />);
  return {
    unmount: () => {
      root.unmount();
      container.remove();
      style.remove();
    },
  };
};
