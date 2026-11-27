import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_PATHS } from "../src/lib/app-routes";

test("Vercel serves the SPA entry point for every direct auth and portal URL", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
    buildCommand: string;
    git: { deploymentEnabled: { main: boolean } };
    rewrites?: Array<{ source: string; destination: string }>;
  };
  const rewrites = new Map(config.rewrites?.map(({ source, destination }) => [source, destination]));

  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(config.buildCommand, "pnpm run build:vercel");
  assert.equal(manifest.scripts["build:vercel"], "vite build && tsc -b");
  assert.equal(config.git.deploymentEnabled.main, true);
  for (const path of [...Object.values(APP_PATHS), "/customer/register"]) {
    if (path === "/") continue;
    assert.equal(rewrites.get(path), "/index.html", `missing SPA rewrite for ${path}`);
  }
  assert.equal(rewrites.has("/api/(.*)"), false, "API routes must not be rewritten to the SPA");
});
