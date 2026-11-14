import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uploadApi = `http://localhost:${process.env.UPLOAD_API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@convex": path.resolve(__dirname, "./convex"),
    },
  },
  server: {
    host: true,
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
          if (id.includes("uploadthing")) return "upload-vendor";
          return undefined;
        },
      },
    },
  },
});
