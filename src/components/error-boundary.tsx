import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { failed: boolean };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application error", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="grid min-h-screen place-items-center p-6">
          <div className="max-w-md space-y-3 rounded-lg border bg-card p-6 text-center shadow-sm">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">Reload the app to recover the workspace before trying again.</p>
            <Button type="button" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
