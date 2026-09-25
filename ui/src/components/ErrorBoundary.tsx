// If rendering throws, say so instead of leaving a blank window. The usual cause
// after an update is a server still running the previous build.

import { Component, type ReactNode } from "react";

type State = { error: Error | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("MHO Studio could not draw its window", error);
  }

  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash-card">
          <h2>MHO Studio could not draw this window</h2>
          <p className="body-text">
            If you have just updated it, an older copy of the server may still be running. Quit it (or run <span className="mono">./install.sh</span> again,
            which stops it) and open MHO Studio again.
          </p>
          <pre className="code">{e.message}</pre>
          <div className="actions">
            <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
