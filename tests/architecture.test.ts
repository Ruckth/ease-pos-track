import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { architectureErrors, checkArchitecture, sourceFiles, checkPolicies } from "../scripts/check-arch";

const root = resolve(import.meta.dirname, "..");
const aliases = { "@/*": ["./src/*"], "@convex/*": ["./convex/*"], "@server/*": ["./server/*"] };
function fixture(sources: Record<string, string>) {
  return architectureErrors(root, new Map(Object.entries(sources).map(([file, source]) => [resolve(root, file), source])), aliases);
}

test("repository dependencies obey the architecture", () => assert.deepEqual(checkArchitecture(root), []));

test("negative fixtures reject every forbidden dependency, including aliases and re-exports", () => {
  const forbidden = [
    ["shared/x.ts", "convex/domain/x.ts", "../convex/domain/x"],
    ["shared/x.ts", "server/x.ts", "../server/x"],
    ["shared/x.ts", "src/x.ts", "@/x"],
    ["shared/x.ts", "scripts/x.ts", "../scripts/x"],
    ["src/components/x.tsx", "server/x.ts", "@server/x"],
    ["src/components/x.tsx", "convex/domain/x.ts", "@convex/domain/x"],
    ["src/components/x.tsx", "convex/functions.ts", "../../convex/functions"],
    ["convex/domain/x.ts", "src/x.ts", "@/x"],
    ["convex/x.ts", "server/x.ts", "../server/x"],
    ["api/x.ts", "src/x.ts", "../src/x"],
    ["server/x.ts", "src/x.ts", "@/x"],
  ];
  for (const [from, to, spec] of forbidden) {
    for (const statement of [`import { x } from "${spec}";`, `export { x } from "${spec}";`, `export * from "${spec}";`, `const x = import("${spec}");`]) {
      assert.equal(fixture({ [from]: statement, [to]: "export const x = 1;" }).length, 1, `${from}: ${statement}`);
    }
  }
  for (const spec of ["convex/react", "convex/browser"]) {
    assert.equal(fixture({ "src/components/x.tsx": `import * as transport from "${spec}";` }).length, 1);
    assert.equal(fixture({ "src/features/tickets/adapters/bridge.ts": `export * from "${spec}";` }).length, 1);
  }
  // A barrel cannot conceal the server edge from a rendering consumer.
  assert.equal(fixture({ "src/components/x.tsx": 'import { x } from "@/lib/bridge";',
    "src/lib/bridge.ts": 'export * from "@server/x";', "server/x.ts": 'export const x = 1;' }).length, 1);
});

test("generated types and named adapter entry points pass while generated values in rendering fail", () => {
  const sources = { "convex/_generated/api.d.ts": "export declare const api: unknown;", "convex/_generated/dataModel.d.ts": "export type Id = string;" };
  assert.deepEqual(fixture({ ...sources,
    "shared/contracts.ts": 'import type { api } from "../convex/_generated/api.js";',
    "src/components/x.tsx": 'import { useData } from "../features/tickets/adapters/data"; import type { Id } from "@convex/_generated/dataModel";',
    "src/features/tickets/adapters/data.ts": 'import { api } from "@convex/_generated/api"; import { useQuery } from "convex/react"; export const useData = () => useQuery(api);',
  }), []);
  assert.equal(fixture({ ...sources, "src/components/x.tsx": 'import { api } from "@convex/_generated/api";' }).length, 1);
  assert.equal(fixture({ "convex/raw.mjs": 'export { mutation as bypass } from "./_generated/server.js";',
    "convex/_generated/server.d.ts": 'export declare const mutation: unknown;' }).length, 1);
});

test("policy discovery catches raw registrations in js, mjs and tsx and hidden HTTP routes", async () => {
  const dir = mkdtempSync(resolve(root, "tests/fixtures/policy-"));
  try {
    const raw = pathToFileURL(resolve(root, "tests/fixtures/raw-registration.ts")).href;
    for (const extension of ["js", "mjs", "tsx"]) writeFileSync(resolve(dir, `raw.${extension}`),
      `import { mutationGeneric as renamed } from "${raw}"; export const bypass = renamed({ handler: () => null });`);
    const routerModule = pathToFileURL(resolve(root, "node_modules/convex/dist/esm/server/index.js")).href;
    writeFileSync(resolve(dir, "http.ts"), `import { httpRouter } from "${routerModule}";
      import { httpActionGeneric as hidden } from "${raw}";
      const router = httpRouter(); router.route({ path: "/hidden", method: "GET", handler: hidden(async () => new Response()) }); export default router;`);
    assert.equal(sourceFiles(dir).length, 4);
    const errors = await checkPolicies(dir, url => import(url));
    for (const extension of ["js", "mjs", "tsx"]) assert.ok(errors.includes(`raw.${extension}:bypass: untagged registration`), errors.join("\n"));
    assert.ok(errors.includes("http.ts:GET /hidden: untagged HTTP route"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("negative fixtures reject runtime, unresolved and generic constructor imports", () => {
  for (const [from, statement, rule] of [
    ["shared/x.ts", 'import React from "react";', "shared runtime"],
    ["src/x.ts", 'import "./missing";', "unresolved import"],
    ["convex/x.ts", 'import { mutationGeneric as renamed } from "convex/server";', "registration constructor"],
    ["convex/x.ts", 'const { queryGeneric } = require("convex/server");', "registration constructor"],
  ]) assert.match(fixture({ [from]: statement }).join("\n"), new RegExp(rule), statement);
});

test("negative fixtures reject template, require, import-equals, glob and URL boundary bypasses", () => {
  for (const statement of [
    'const x = import(`../../server/x`);',
    'const x = require("../../server/x");',
    'const x = require(`../../server/x`);',
    'import x = require("../../server/x");',
    'const x = import.meta.glob("../../server/**/*.ts");',
    'const x = import.meta.glob(`../../server/**/*.ts`);',
    'const x = import.meta.glob("/server/**/*.ts");',
    'const x = import.meta.glob("../../**/*.ts");',
    'const x = import.meta.glob(["./*.tsx", "!./skip.tsx", "@server/**/*.ts"]);',
    'const x = new URL("../../server/x.ts", import.meta.url);',
    'const x = new URL(`../../server/x.ts`, import.meta.url);',
  ]) assert.match(fixture({ "src/components/x.tsx": statement, "server/x.ts": "export const x = 1;" }).join("\n"), /browser boundary/, statement);
});

test("negative fixtures reject nonliteral loaders, unresolvable subpaths and dynamic globs", () => {
  for (const statement of [
    'const x = import(path);', 'const x = import(`../../${path}`);',
    'const x = require(path);', 'const x = require(`../../${path}`);',
    'const x = import.meta.glob(pattern);', 'const x = import.meta.glob(["./*.ts", pattern]);',
    'import x from "#hidden";', 'import "#hidden.css";', 'const x = require("#hidden");',
    'const x = import("#hidden");', 'const x = import.meta.glob("#hidden/*.ts");',
  ]) assert.match(fixture({ "src/x.ts": statement }).join("\n"), /nonliteral|unresolved import/, statement);
});


test("local glob bases, literal loaders and same-layer URLs remain permitted", () => {
  assert.deepEqual(fixture({
    "src/x.ts": 'const a = import.meta.glob(["./components/*.tsx", "!./components/skip.tsx"]); const b = require(`./components/x`); const c = new URL("./components/x.tsx", import.meta.url);',
    "src/components/x.tsx": "export const x = 1;",
  }), []);
});
