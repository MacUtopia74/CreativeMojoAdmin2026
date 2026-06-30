// App-wide error boundary. Without this, any unhandled render exception
// in any descendant of <Layout> causes React to unmount the entire
// component tree, leaving a blank white screen. We catch the throw,
// render a friendly fallback, AND post the error + user context to the
// backend so production crashes are diagnosable (frontend Sentry-lite).
import { Component } from "react";
import api from "@/lib/api";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, reported: false };
  }

  static getDerivedStateFromError(error) {
    return { error, info: null, reported: false };
  }

  componentDidCatch(error, info) {
    // Best-effort report. Failure to post is intentionally swallowed —
    // we don't want the boundary itself to crash if the backend is down.
    if (this.state.reported) return;
    this.setState({ info, reported: true });
    try {
      const payload = {
        message: String(error?.message || error),
        stack: String(error?.stack || ""),
        component_stack: String(info?.componentStack || ""),
        location: typeof window !== "undefined" ? window.location.href : "",
        user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        // Mirror /auth/me so we know who hit it without forcing the
        // backend to look it up by token (the boundary doesn't have an
        // axios interceptor pre-applied for tokens).
      };
      api.post("/errors/log", payload).catch(() => { /* noop */ });
    } catch {
      /* ignore */
    }
    // Also surface in the console for any user with devtools open.
    // eslint-disable-next-line no-console
    console.error("[CM:ErrorBoundary] caught:", error, info);
  }

  reset = () => this.setState({ error: null, info: null, reported: false });
  reload = () => { if (typeof window !== "undefined") window.location.reload(); };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F9F9F8] p-6" data-testid="error-boundary-fallback">
        <div className="max-w-lg w-full bg-white border border-stone-200 rounded-2xl p-8 shadow-sm">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-red-600 mb-2">Something went wrong</div>
          <h1 className="font-display text-2xl text-stone-950 mb-3">We hit a snag rendering this page.</h1>
          <p className="text-sm text-stone-600 mb-5 leading-relaxed">
            The error has been reported automatically. Try reloading — if it keeps happening, share
            the message below with support and we can dig in.
          </p>
          <div className="bg-stone-100 border border-stone-200 rounded-lg p-3 mb-5 text-[11px] font-mono text-stone-800 break-words max-h-40 overflow-auto">
            {String(this.state.error?.message || this.state.error)}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.reload}
              data-testid="error-boundary-reload"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg"
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={this.reset}
              data-testid="error-boundary-retry"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 text-stone-800 hover:bg-stone-50 rounded-lg"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
