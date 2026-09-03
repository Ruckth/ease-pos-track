import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Vercel serves the SPA entry point for every direct auth and portal URL", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
    rewrites?: Array<{ source: string; destination: string }>;
  };
  const rewrites = new Map(config.rewrites?.map(({ source, destination }) => [source, destination]));

  for (const path of ["/staff", "/staff/login", "/customer", "/customer/login", "/customer/register"]) {
    assert.equal(rewrites.get(path), "/index.html", `missing SPA rewrite for ${path}`);
  }
  assert.equal(rewrites.has("/api/(.*)"), false, "API routes must not be rewritten to the SPA");
});
