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
      configResolved({ env, mode }) {
        if (mode !== "named-pilot" && process.env.TICKET_DEPLOYMENT_MODE !== "named-pilot" && process.env.VERCEL_ENV !== "production") return;
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
