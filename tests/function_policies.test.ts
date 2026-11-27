import { checkPolicies, violations, routeViolations } from "../scripts/check-arch";
import { httpRouter } from "convex/server";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { actorQuery, identityAction, namedStaffQuery, publicIdentityMutation, publicIdentityQuery, staffQuery, lineWebhookHttp, pageHttp, t3DoctorHttp, trustedCallbackMutation } from "../convex/functions";
import { completePasswordSignIn, reservePasswordSignIn, signInWithPassword } from "../convex/auth";
import { assignment, classification, routingTables } from "../convex/routing_schema";
import schema from "../convex/schema";
import { v } from "convex/values";
import { mutationGeneric, queryGeneric, actionGeneric, internalMutationGeneric, internalQueryGeneric, internalActionGeneric, httpActionGeneric } from "./fixtures/raw-registration";

const root = resolve(import.meta.dirname, "../convex");
test("every Convex export and HTTP route declares its policy across all source extensions", async () => {
  assert.deepEqual(await checkPolicies(root, url => import(url)), []);
});

test("password sign-in exposes the action and keeps reservation and admission private", () => {
  assert.equal(signInWithPassword.isPublic, true);
  assert.equal(signInWithPassword.isAction, true);
  for (const endpoint of [reservePasswordSignIn, completePasswordSignIn]) {
    assert.equal(endpoint.isInternal, true);
    assert.equal(endpoint.isMutation, true);
  }
});

test("zero-user Ticket routing exposes only local operations and rule suggestions", () => {
  const listEvaluations = staffQuery({ name: "ticket_routing:listEvaluations", args: {}, handler: () => [] });
  assert.deepEqual(violations("ticket_routing.ts", { listEvaluations }), [
    "ticket_routing.ts:listEvaluations: unexpected policy staffQuery",
  ]);
  assert.deepEqual(Object.keys(schema.tables).filter(name => name.startsWith("ticketRouting")).sort(), [
    "ticketRoutingAudit", "ticketRoutingAvailability", "ticketRoutingPolicies",
    "ticketRoutingSuggestionRequests", "ticketRoutingSuggestions",
  ]);
  assert.deepEqual(Object.keys(routingTables.ticketRoutingPolicies.validator.fields).sort(), [
    "areas", "backup", "intake", "policyGeneration", "products", "projectId", "ruleRevision", "rules", "symptoms",
  ]);
  assert.deepEqual(Object.keys(classification.fields).sort(), ["product", "restricted", "reviewed", "symptom"]);
  assert.equal(routingTables.ticketRoutingSuggestions.validator.fields.source.value, "rule");
  assert.equal(assignment.fields.source.value, "manual");
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

test("policy manifest rejects new public identity/callback exports and wrong purpose labels", () => {
  const viewer = publicIdentityQuery("viewer")({ name: "fixture", args: {}, handler: () => null });
  const preview = publicIdentityQuery("invite-preview")({ name: "fixture", args: {}, handler: () => null });
  const recover = publicIdentityMutation("customer-recover")({ name: "fixture", args: {}, handler: () => null });
  const send = identityAction("send-challenge")({ name: "fixture", args: {}, handler: () => null });
  const callback = trustedCallbackMutation({ name: "fixture", args: { callbackToken: v.optional(v.string()) }, handler: () => null });
  assert.deepEqual(violations("identity.ts", { viewer }), []);
  assert.deepEqual(violations("auth.ts", { recoverWithCode: recover }), []);
  for (const [module, exports] of [["identity.ts", { viewer: preview }], ["identity.ts", { viewer: recover }],
    ["other.ts", { viewer }], ["other.ts", { send }], ["other.ts", { callback }]] as const) {
    assert.equal(violations(module, exports).length, 1);
  }
});

test("protected registrations refuse raw token arguments at definition time", () => {
  assert.throws(() => actorQuery({ name: "fixture", args: { token: v.string() }, handler: () => null }), /raw token/);
  assert.throws(() => publicIdentityQuery("viewer")({ name: "fixture", args: { token: v.string() }, handler: () => null }), /raw token/);
  assert.throws(() => namedStaffQuery({ name: "fixture", args: { token: v.string() }, handler: () => null }), /raw token/);
});

test("HTTP routes cannot hide an untagged handler inside the router", () => {
  const router = httpRouter();
  router.route({ path: "/bypass", method: "GET", handler: httpActionGeneric(async () => new Response()) });
  assert.deepEqual(routeViolations("http.ts", router).sort(), [
    "http.ts:GET /bypass: untagged HTTP route",
    "http.ts:GET /p/*: missing manifest route",
    "http.ts:OPTIONS /v1/tickets/*: missing manifest route",
    "http.ts:POST /integrations/t3/doctor: missing manifest route",
    "http.ts:POST /line/webhook/*: missing manifest route",
    "http.ts:POST /v1/tickets/*: missing manifest route",
  ]);
});

test("a tagged doctor handler cannot be mounted at another method or path", () => {
  const router = httpRouter();
  router.route({ ...t3DoctorHttp(async () => new Response()), path: "/integrations/t3/other" });
  assert.deepEqual(routeViolations("http.ts", router).sort(), [
    "http.ts:GET /p/*: missing manifest route",
    "http.ts:OPTIONS /v1/tickets/*: missing manifest route",
    "http.ts:POST /integrations/t3/doctor: missing manifest route",
    "http.ts:POST /integrations/t3/other: unexpected HTTP policy http:t3-doctor:t3_doctor:verify",
    "http.ts:POST /line/webhook/*: missing manifest route",
    "http.ts:POST /v1/tickets/*: missing manifest route",
  ]);
});

test("HTTP routes are enumerated: page serving cannot be relabelled, widened or dropped", () => {
  const handler = async () => new Response();
  const router = httpRouter();
  router.route(t3DoctorHttp(handler));
  router.route({ ...pageHttp("publish", handler), pathPrefix: "/p/", method: "GET" });
  router.route({ ...pageHttp("publish", handler), method: "PUT" });
  assert.deepEqual(routeViolations("http.ts", router).sort(), [
    "http.ts:GET /p/*: unexpected HTTP policy http:convex-auth:pages:publish",
    "http.ts:OPTIONS /v1/tickets/*: missing manifest route",
    "http.ts:POST /line/webhook/*: missing manifest route",
    "http.ts:POST /v1/tickets/*: missing manifest route",
    "http.ts:PUT /v1/tickets/*: unexpected HTTP policy http:convex-auth:pages:publish",
  ]);
});

test("LINE signature policy is limited to the exact webhook prefix and POST", () => {
  const route = lineWebhookHttp(async () => new Response());
  const router = httpRouter();
  router.route({ ...route, method: "GET" });
  const errors = routeViolations("http.ts", router);
  assert.ok(errors.includes("http.ts:GET /line/webhook/*: unexpected HTTP policy http:line-signature:line_webhook:receive"));
  assert.ok(errors.includes("http.ts:POST /line/webhook/*: missing manifest route"));
});
