import { Component, type ReactNode } from "react";
import { errorCode } from "../../shared/errors";

/** A role query can observe expiry before the shell's session subscription. */
export class SessionBoundary extends Component<{ children: ReactNode; onExpired: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    if (errorCode(error) === "SESSION_EXPIRED") this.props.onExpired();
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (errorCode(this.state.error) === "SESSION_EXPIRED") return null;
    throw this.state.error;
  }
}
