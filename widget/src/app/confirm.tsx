import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

/** Confirmation dialog rendered inside the widget panel (never window.confirm on the host page). */
export const ConfirmProvider = ({ children }: { children: ReactNode }) => {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => undefined);

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setOpts(o);
      }),
    [],
  );
  const close = (v: boolean) => {
    setOpts(null);
    resolver.current(v);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="wrtm-confirm-title">
            <div className="form">
              <h3 id="wrtm-confirm-title">{opts.title}</h3>
              <p className="sub" style={{ margin: 0 }}>
                {opts.message}
              </p>
              <div className="row">
                <button type="button" className="btn btn-secondary" onClick={() => close(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={opts.danger ? { background: 'var(--danger)' } : undefined}
                  autoFocus
                  onClick={() => close(true)}
                >
                  {opts.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};
