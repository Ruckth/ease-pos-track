import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

type ErrorBoundaryProps = { children: ReactNode; title: string; description: string; reload: string };
type ErrorBoundaryState = { failed: boolean };

class ErrorBoundaryView extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
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
            <h1 className="text-xl font-semibold">{this.props.title}</h1>
            <p className="text-sm text-muted-foreground">{this.props.description}</p>
            <Button type="button" onClick={() => window.location.reload()}>{this.props.reload}</Button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return <ErrorBoundaryView title={t("appError")} description={t("appErrorDescription")} reload={t("reload")}>{children}</ErrorBoundaryView>;
}
