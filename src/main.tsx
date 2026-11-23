import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BackendProvider } from "./app/convex-provider";
import { AppRouter } from "./app/router";
import { ErrorBoundary } from "./components/error-boundary";
import { LanguageProvider } from "./lib/i18n";
import "./index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>{convexUrl ? (
      <BackendProvider>
        <ErrorBoundary><AppRouter /></ErrorBoundary>
      </BackendProvider>
    ) : (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-xl font-semibold">Convex is not configured</h1>
          <p className="mt-2 text-sm text-muted-foreground">Run `pnpm convex:local` to start the local backend, then `pnpm dev`.</p>
        </div>
      </main>
    )}</LanguageProvider>
  </StrictMode>,
);
