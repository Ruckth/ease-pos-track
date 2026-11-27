import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate from Vite's browser configuration and the Node suite's discovery.
export default defineConfig({
  // argon2id WASM cannot load in edge-runtime; tests/convex/fixtures/argon2-stub.ts.
  resolve: { alias: { "password-hash-wasm/argon2id": fileURLToPath(new URL("./tests/convex/fixtures/argon2-stub.ts", import.meta.url)) } },
  test: {
    server: { deps: { inline: ["@convex-dev/auth", "@convex-dev/rate-limiter"] } },
    include: ["tests/convex/**/*.test.ts"],
    setupFiles: ["tests/convex/setup.ts"],
    environment: "edge-runtime",
    env: { TICKET_DEPLOYMENT_MODE: "legacy" },
    // Leave room for typecheck/build and the password fixtures in pnpm check.
    maxWorkers: 2,
    // The first test in a file also pays for transforming the auth components.
    testTimeout: 30_000,
  },
});
