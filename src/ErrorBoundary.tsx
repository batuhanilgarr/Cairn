import { Component, type ReactNode } from "react";

/** If a bad piece of saved state ever crashes the UI, offer a way out instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 560, margin: "10vh auto", font: "14px -apple-system, system-ui, sans-serif" }}>
        <h2>Reqnest hit a problem</h2>
        <p style={{ opacity: 0.7 }}>{this.state.error.message}</p>
        <p style={{ opacity: 0.7 }}>
          Your collections on disk are untouched. Resetting clears only the app's remembered tabs, history and settings.
        </p>
        <button
          onClick={() => {
            try {
              Object.keys(localStorage).filter((k) => k.startsWith("rq.")).forEach((k) => localStorage.removeItem(k));
            } catch {
              /* ignore */
            }
            location.reload();
          }}
        >
          Reset app state and reload
        </button>
      </div>
    );
  }
}
