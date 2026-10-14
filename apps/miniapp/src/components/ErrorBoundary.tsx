import { Component, type ReactNode } from "react";

/**
 * Catches render errors and failed lazy chunks (an old bundle after a deploy asks for a chunk that no
 * longer exists): shows a reload button instead of a blank screen.
 */
export class ErrorBoundary extends Component<{ message: string; action: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error("screen crashed", err);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="stack center">
        <p>{this.props.message}</p>
        <button className="primary" onClick={() => window.location.reload()}>
          {this.props.action}
        </button>
      </div>
    );
  }
}
