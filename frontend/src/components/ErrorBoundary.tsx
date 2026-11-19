import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render errors so one broken view doesn't blank the whole app. A failed lazy chunk
 * (e.g. after a new deployment) is fixed by reloading, which the button offers.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunk = /Loading chunk|dynamically imported module|Importing a module script failed/i.test(this.state.error.message);
    return (
      <div role="alert" className="card mx-auto my-10 max-w-lg p-8 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
        <h2 className="mt-3 text-lg font-semibold">{chunk ? 'A new version is available' : 'Something went wrong'}</h2>
        <p className="mt-1 text-sm text-slate-500">
          {chunk ? 'Reload the page to continue.' : 'This part of the page failed to load. Try again, or reload the page.'}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          {!chunk && (
            <button type="button" className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          )}
          <button type="button" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
