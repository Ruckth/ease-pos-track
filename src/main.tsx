import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import "./index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {convexUrl ? (
      <ConvexProvider client={new ConvexReactClient(convexUrl)}>
        <App />
      </ConvexProvider>
    ) : (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-xl font-semibold">Convex is not configured</h1>
          <p className="mt-2 text-sm text-muted-foreground">Run `npx convex dev --once` to create `VITE_CONVEX_URL`.</p>
        </div>
      </main>
    )}
  </StrictMode>,
);
