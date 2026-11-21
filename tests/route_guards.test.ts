import assert from "node:assert/strict";
import test from "node:test";
import { guardRedirect, safeReturnTarget, type GuardAuth } from "../src/app/route-guards";

const out: GuardAuth = { status: "signed-out" };
const staff: GuardAuth = { status: "signed-in", role: "staff" };
const customer: GuardAuth = { status: "signed-in", role: "customer" };
const loginWith = (login: string, target: string) => `${login}?${new URLSearchParams({ redirect: target })}`;

test("renderable locations need no redirect", () => {
  assert.equal(guardRedirect("/staff/login", "", out), null);
  assert.equal(guardRedirect("/customer/login", "?redirect=%2Fcustomer", out), null);
  assert.equal(guardRedirect("/customer/register", "", out), null);
  assert.equal(guardRedirect("/staff", "?project=POS&ticket=abc", staff), null);
  assert.equal(guardRedirect("/customer/", "", customer), null);
});

test("signed-out deep links keep their path and query for after sign-in", () => {
  assert.equal(guardRedirect("/staff", "?project=POS&ticket=abc", out), loginWith("/staff/login", "/staff?project=POS&ticket=abc"));
  assert.equal(guardRedirect("/customer", "filter=done", out), loginWith("/customer/login", "/customer?filter=done"));
  assert.equal(guardRedirect("/staff", "", out), loginWith("/staff/login", "/staff"));
});

test("root and unknown paths keep existing redirects without a return target", () => {
  assert.equal(guardRedirect("/", "", out), "/staff/login");
  assert.equal(guardRedirect("/missing", "?x=1", out), "/staff/login");
  assert.equal(guardRedirect("/customer/missing", "", out), "/customer/login");
  assert.equal(guardRedirect("/", "", customer), "/customer");
  assert.equal(guardRedirect("/missing", "", staff), "/staff");
});

test("sign-in returns to an allowlisted same-role target", () => {
  assert.equal(guardRedirect("/staff/login", "?" + new URLSearchParams({ redirect: "/staff?project=POS&ticket=abc" }), staff), "/staff?project=POS&ticket=abc");
  assert.equal(guardRedirect("/customer/register", "?" + new URLSearchParams({ redirect: "/customer?filter=done" }), customer), "/customer?filter=done");
  assert.equal(guardRedirect("/staff/login", "", staff), "/staff");
});

test("wrong-role, foreign and API targets fall back to the role home", () => {
  for (const target of ["/customer?filter=done", "/api/uploads/cancel", "//evil.example/staff", "https://evil.example/staff",
    "/\\evil.example", "/\t/evil.example/staff", "staff", "/staff/login", "/staff/../api", "/%2e%2e/api"]) {
    assert.equal(guardRedirect("/staff/login", "?" + new URLSearchParams({ redirect: target }), staff), "/staff", target);
  }
  // A customer signed in on a staff sign-in URL lands in their own workspace.
  assert.equal(guardRedirect("/staff/login", "?" + new URLSearchParams({ redirect: "/staff" }), customer), "/customer");
  // Signed-in visitors never keep another role's query.
  assert.equal(guardRedirect("/staff", "?project=POS", customer), "/customer");
});

test("return targets are bounded and drop fragments", () => {
  assert.equal(safeReturnTarget("/staff?q=a#frag", "staff"), "/staff?q=a");
  assert.equal(safeReturnTarget("/staff/", "staff"), "/staff");
  assert.equal(safeReturnTarget(`/staff?q=${"a".repeat(2048)}`, "staff"), null);
  assert.equal(safeReturnTarget(undefined, "staff"), null);
  assert.equal(safeReturnTarget(["/staff"], "staff"), null);
});
