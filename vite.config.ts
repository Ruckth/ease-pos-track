import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
      "/api/uploadthing": "http://localhost:8787",
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
