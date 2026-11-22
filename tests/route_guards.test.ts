import assert from "node:assert/strict";
import test from "node:test";
import { guardRedirect, safeReturnTarget } from "../src/app/route-guards";

const loginWith = (login: string, target: string) => `${login}?${new URLSearchParams({ redirect: target })}`;
const withRedirect = (target: string) => "?" + new URLSearchParams({ redirect: target });

test("renderable locations need no redirect", () => {
  assert.equal(guardRedirect("/staff/login", "", "signed-out"), null);
  assert.equal(guardRedirect("/customer/login", "?redirect=%2Fcustomer", "signed-out"), null);
  assert.equal(guardRedirect("/customer/join", "", "signed-out"), null);
  assert.equal(guardRedirect("/customer/recover", "", "signed-out"), null);
  assert.equal(guardRedirect("/staff/invite", "", "signed-out"), null);
  assert.equal(guardRedirect("/staff", "?project=POS&ticket=abc", "staff"), null);
  assert.equal(guardRedirect("/staff/settings/t3", "?project=POS", "staff"), null);
  assert.equal(guardRedirect("/customer/", "", "customer"), null);
  assert.equal(guardRedirect("/customer/join", "", "staff"), null);
});

test("a pending Google identity is never redirected; the Gate renders its page", () => {
  for (const path of ["/", "/staff", "/staff/login", "/customer", "/staff/invite", "/customer/join", "/nowhere"]) {
    assert.equal(guardRedirect(path, "", "pending"), null, path);
  }
});

test("signed-out deep links keep their path and query for after sign-in", () => {
  assert.equal(guardRedirect("/staff", "?project=POS&ticket=abc", "signed-out"), loginWith("/staff/login", "/staff?project=POS&ticket=abc"));
  assert.equal(guardRedirect("/staff/settings/t3", "", "signed-out"), loginWith("/staff/login", "/staff/settings/t3"));
  assert.equal(guardRedirect("/customer", "filter=done", "signed-out"), loginWith("/customer/login", "/customer?filter=done"));
  assert.equal(guardRedirect("/staff", "", "signed-out"), loginWith("/staff/login", "/staff"));
});

test("root, retired and unknown paths keep main's redirects", () => {
  assert.equal(guardRedirect("/", "", "signed-out"), "/staff/login");
  assert.equal(guardRedirect("/customer/register", "", "signed-out"), "/customer/login");
  assert.equal(guardRedirect("/missing", "?x=1", "signed-out"), "/staff/login");
  assert.equal(guardRedirect("/customer/missing", "", "signed-out"), "/customer/login");
  assert.equal(guardRedirect("/", "", "customer"), "/customer");
  assert.equal(guardRedirect("/missing", "", "staff"), "/staff");
  // Within the role's namespace, main's shell kept the query.
  assert.equal(guardRedirect("/staff/invite", "?project=POS", "staff"), "/staff?project=POS");
  assert.equal(guardRedirect("/customer/recover", "?project=POS", "customer"), "/customer?project=POS");
});

test("sign-in returns to an allowlisted same-role target", () => {
  assert.equal(guardRedirect("/staff/login", withRedirect("/staff?project=POS&ticket=abc"), "staff"), "/staff?project=POS&ticket=abc");
  assert.equal(guardRedirect("/staff/login", withRedirect("/staff/settings/t3?project=POS"), "staff"), "/staff/settings/t3?project=POS");
  assert.equal(guardRedirect("/customer/login", withRedirect("/customer?filter=done"), "customer"), "/customer?filter=done");
  assert.equal(guardRedirect("/staff/login", "", "staff"), "/staff");
});

test("a Google return target is consumed only on the sign-in page and still validated", () => {
  let taken = 0;
  const take = (value: string) => () => { taken++; return value; };
  assert.equal(guardRedirect("/staff/login", "", "staff", { takeStoredReturn: take("/staff?project=POS") }), "/staff?project=POS");
  assert.equal(guardRedirect("/staff/login", "", "staff", { takeStoredReturn: take("/customer") }), "/staff");
  assert.equal(guardRedirect("/staff/login", withRedirect("/staff?q=a"), "staff", { takeStoredReturn: take("/staff?q=b") }), "/staff?q=a");
  assert.equal(guardRedirect("/staff", "", "staff", { takeStoredReturn: take("/staff?q=c") }), null);
  assert.equal(guardRedirect("/missing", "", "staff", { takeStoredReturn: take("/staff?q=c") }), "/staff");
  assert.equal(taken, 3);
});

test("a customer holding an invitation returns from sign-in to the join page", () => {
  assert.equal(guardRedirect("/customer/login", withRedirect("/customer?filter=done"), "customer", { invitation: true }), "/customer/join");
  assert.equal(guardRedirect("/customer/login", "", "customer", { invitation: false }), "/customer");
});

test("wrong-role, foreign and API targets fall back to the role home", () => {
  for (const target of ["/customer?filter=done", "/api/uploads/cancel", "//evil.example/staff", "https://evil.example/staff",
    "/\\evil.example", "/\t/evil.example/staff", "staff", "/staff/login", "/staff/invite", "/staff/../api", "/%2e%2e/api"]) {
    assert.equal(guardRedirect("/staff/login", withRedirect(target), "staff"), "/staff", target);
  }
  assert.equal(safeReturnTarget("/staff/settings/t3", "customer"), null);
  // A customer signed in on a staff sign-in URL lands in their own workspace.
  assert.equal(guardRedirect("/staff/login", withRedirect("/staff"), "customer"), "/customer");
  // Signed-in visitors never keep another role's query.
  assert.equal(guardRedirect("/staff", "?project=POS", "customer"), "/customer");
  assert.equal(guardRedirect("/staff/settings/t3", "?project=POS", "customer"), "/customer");
});

test("return targets are bounded and drop fragments", () => {
  assert.equal(safeReturnTarget("/staff?q=a#frag", "staff"), "/staff?q=a");
  assert.equal(safeReturnTarget("/staff/", "staff"), "/staff");
  assert.equal(safeReturnTarget(`/staff?q=${"a".repeat(2048)}`, "staff"), null);
  assert.equal(safeReturnTarget(undefined, "staff"), null);
  assert.equal(safeReturnTarget(["/staff"], "staff"), null);
});
