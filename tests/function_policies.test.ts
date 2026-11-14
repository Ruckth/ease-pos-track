import { checkPolicies, violations, routeViolations } from "../scripts/check-arch";
import { httpRouter } from "convex/server";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { publicAuthMutation, publicAuthQuery, trustedCallbackMutation } from "../convex/functions";
import { v } from "convex/values";
import { mutationGeneric, queryGeneric, actionGeneric, internalMutationGeneric, internalQueryGeneric, internalActionGeneric, httpActionGeneric } from "./fixtures/raw-registration";

const root = resolve(import.meta.dirname, "../convex");
test("every Convex export and HTTP route declares its policy across all source extensions", async () => {
  assert.deepEqual(await checkPolicies(root, url => import(url)), []);
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
  const login = publicAuthMutation("staff-login")({ name: "fixture", args: {}, handler: () => null });
  const wrong = publicAuthMutation("logout")({ name: "fixture", args: {}, handler: () => null });
  const query = publicAuthQuery("current-session")({ name: "fixture", args: {}, handler: () => null });
  const callback = trustedCallbackMutation({ name: "fixture", args: { token: v.optional(v.string()), callbackToken: v.optional(v.string()) }, handler: () => null });
  assert.deepEqual(violations("auth.ts", { login }), []);
  for (const [module, exports] of [["auth.ts", { login: wrong }], ["auth.ts", { login: query }],
    ["other.ts", { login }], ["other.ts", { callback }]] as const) {
    assert.equal(violations(module, exports).length, 1);
  }
});

test("HTTP routes cannot hide an untagged handler inside the router", () => {
  const router = httpRouter();
  router.route({ path: "/bypass", method: "GET", handler: httpActionGeneric(async () => new Response()) });
  assert.deepEqual(routeViolations("http.ts", router), ["http.ts:GET /bypass: untagged HTTP route"]);
});
