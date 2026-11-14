import { defineConfig } from "vitest/config";

// Separate from Vite's browser configuration and the Node suite's discovery.
export default defineConfig({
  test: {
    include: ["tests/convex/**/*.test.ts"],
    environment: "edge-runtime",
  },
});
