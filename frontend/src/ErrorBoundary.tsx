import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

// Without this, any render error leaves a black screen with nothing on it —
// no message, no way back.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error", error, info);
  }

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div className="app-error" role="alert">
        <h1>The game stopped</h1>
        <p>Something in the interface failed. Reloading the page starts a fresh run.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
        <code>{error.message}</code>
      </div>
    );
  }
}
