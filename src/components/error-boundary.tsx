import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export function WorkspaceError() {
  const { t } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <main className="aurora-canvas grid min-h-screen place-items-center p-6">
      <div className="aurora-panel max-w-md space-y-3 p-6 text-center shadow-sm">
        <h1 tabIndex={-1} ref={heading} className="text-xl font-semibold">{t("appError")}</h1>
        <p role="alert" className="text-sm text-muted-foreground">{t("appErrorDescription")}</p>
        <Button type="button" onClick={() => window.location.reload()}>{t("reload")}</Button>
      </div>
    </main>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application error", error, info.componentStack);
  }

  render() {
    return this.state.failed ? <WorkspaceError /> : this.props.children;
  }
}
