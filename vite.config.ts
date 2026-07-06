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
    proxy: {
      "/api/uploadthing": "http://localhost:8787",
    },
  },
});
