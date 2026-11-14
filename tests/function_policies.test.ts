import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { registrationPolicy, publicAuthMutation, publicAuthQuery, trustedCallbackMutation } from "../convex/functions";
import { v } from "convex/values";
import { mutationGeneric, queryGeneric, actionGeneric, internalMutationGeneric, internalQueryGeneric, internalActionGeneric, httpActionGeneric } from "./fixtures/raw-registration";

const root = resolve(import.meta.dirname, "../convex");
const exceptions: Record<string, string> = {
  "auth.ts:login": "publicAuthMutation:staff-login",
  "auth.ts:logout": "publicAuthMutation:logout",
  "auth.ts:currentSession": "publicAuthQuery:current-session",
  "customers.ts:login": "publicAuthAction:customer-login",
  "customers.ts:register": "publicAuthAction:customer-register",
  "uploads.ts:recordUploadedFile": "trustedCallbackMutation",
};

function violations(module: string, exports: Record<string, unknown>) {
  return Object.entries(exports).flatMap(([name, value]) => {
    if (!value || (typeof value !== "function" && typeof value !== "object")
      || !["isQuery", "isMutation", "isAction", "isHttp"].some(key => key in value && value[key as keyof typeof value])) return [];
    const policy = registrationPolicy(value);
    const pair = `${module}:${name}`;
    if (!policy) return [`${pair}: untagged registration`];
    if ((policy.startsWith("publicAuth") || policy === "trustedCallbackMutation" || pair in exceptions)
      && exceptions[pair] !== policy) return [`${pair}: unexpected policy ${policy}`];
    return [];
  });
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.name === "_generated" ? [] : item.isDirectory()
    ? files(resolve(dir, item.name)) : item.name.endsWith(".ts") && !item.name.endsWith(".d.ts") ? [resolve(dir, item.name)] : []);
}

test("every Convex function export is tagged and exceptional policies match the manifest", async () => {
  const seen = new Set<string>();
  for (const file of files(root)) {
    const module = relative(root, file);
    const exports = await import(pathToFileURL(file).href);
    assert.deepEqual(violations(module, exports), []);
    for (const name of Object.keys(exports)) seen.add(`${module}:${name}`);
  }
  for (const pair of Object.keys(exceptions)) assert.ok(seen.has(pair), `missing manifest export ${pair}`);
});

test("policy check rejects raw registrations through re-exports, including inside functions.ts", () => {
  const raw = [queryGeneric({ handler: () => null }), mutationGeneric({ handler: () => null }),
    actionGeneric({ handler: () => null }), internalQueryGeneric({ handler: () => null }),
    internalMutationGeneric({ handler: () => null }), internalActionGeneric({ handler: () => null }),
    httpActionGeneric(async () => new Response())];
  for (const module of ["bypass.ts", "functions.ts"]) {
    for (const bypass of raw) assert.deepEqual(violations(module, { bypass }), [`${module}:bypass: untagged registration`]);
  }
});

test("policy manifest rejects new public auth/callback exports and wrong purpose labels", () => {
  const login = publicAuthMutation("staff-login")({ args: {}, handler: () => null });
  const wrong = publicAuthMutation("logout")({ args: {}, handler: () => null });
  const query = publicAuthQuery("current-session")({ args: {}, handler: () => null });
  const callback = trustedCallbackMutation({ args: { token: v.optional(v.string()), callbackToken: v.optional(v.string()) }, handler: () => null });
  assert.deepEqual(violations("auth.ts", { login }), []);
  for (const [module, exports] of [["auth.ts", { login: wrong }], ["auth.ts", { login: query }],
    ["other.ts", { login }], ["other.ts", { callback }]] as const) {
    assert.equal(violations(module, exports).length, 1);
  }
});
