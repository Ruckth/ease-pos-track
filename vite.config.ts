import { validNoticeUrl } from "./shared/privacy-notice";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadPorts } from "./scripts/worktree-ports.mjs";

// This checkout's ports (.env.worktree in parallel worktrees, see AGENTS.md).
const ports = loadPorts();
const uploadApi = `http://localhost:${ports.UPLOAD_API_PORT}`;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "pilot-privacy-notices",
      apply: "build",
      async configResolved({ env, mode }) {
        if (mode !== "named-pilot" && process.env.TICKET_DEPLOYMENT_MODE !== "named-pilot" && process.env.VERCEL_ENV !== "production") return;
        if (process.env.VERCEL_ENV === "production") {
          if (!env.VITE_CONVEX_URL) throw new Error("Production requires VITE_CONVEX_URL");
          // Exercise the same signed-out query used on entry, without a session or any write.
          const response = await fetch(new URL("/api/query", env.VITE_CONVEX_URL), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: "identity:viewer", args: {}, format: "json" }),
            signal: AbortSignal.timeout(15000),
          });
          const viewer = response.ok ? await response.json() : null;
          if (viewer?.status !== "success" || viewer.value !== null) {
            throw new Error("Production backend does not serve the signed-out identity:viewer query required by this frontend");
          }
        }
        for (const name of ["VITE_PILOT_PRIVACY_NOTICE_TH", "VITE_PILOT_PRIVACY_NOTICE_EN"]) {
          if (!validNoticeUrl(env[name])) throw new Error(`A named pilot build requires an approved HTTPS URL in ${name}`);
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@convex": path.resolve(__dirname, "./convex"),
    },
  },
  server: {
    host: true,
    port: ports.VITE_PORT,
    strictPort: true,
    proxy: {
      "/api/uploadthing": uploadApi,
      // Upload cancellation runs on the same local API; without this the dev
      // server answers with index.html and cleanup silently fails.
      "/api/uploads": uploadApi,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/convex/")) return "convex-vendor";
          return undefined;
        },
      },
    },
  },
});
