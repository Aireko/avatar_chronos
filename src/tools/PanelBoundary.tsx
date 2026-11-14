// Keeps one broken tool panel from taking the whole app down with it. React
// unmounts everything above a render error unless a boundary catches it, so a
// bug in, say, the PR reviews panel would otherwise leave a blank window.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Shown in the message, e.g. "PR reviews". */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.name} panel crashed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-crash" role="alert">
        <p className="section-title">{this.props.name} hit a snag</p>
        <p className="quiet">{this.state.error.message || "Something went wrong while drawing this panel."}</p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
