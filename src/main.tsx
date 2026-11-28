import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BackendProvider } from "./app/convex-provider";
import { AppRouter } from "./app/router";
import { Button } from "./components/ui/button";
import { ErrorBoundary } from "./components/error-boundary";
import { LanguageProvider, useI18n } from "./lib/i18n";
import "./index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

function UnavailableWorkspace() {
  const { t } = useI18n();
  return <main className="aurora-canvas flex min-h-screen items-center justify-center p-6">
    <div className="aurora-panel max-w-md space-y-3 p-6">
      <h1 className="text-xl font-semibold">{t("serviceUnavailable")}</h1>
      <p>{t("serviceUnavailableHint")}</p>
      <Button onClick={() => window.location.reload()}>{t("reload")}</Button>
      {import.meta.env.DEV && <p className="text-sm text-muted-foreground"><code>VITE_CONVEX_URL</code></p>}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>{convexUrl ? (
      <BackendProvider>
        <ErrorBoundary><AppRouter /></ErrorBoundary>
      </BackendProvider>
    ) : (
      <UnavailableWorkspace />
    )}</LanguageProvider>
  </StrictMode>,
);
