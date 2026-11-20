import assert from "node:assert/strict";
import test from "node:test";
import { APP_PATHS, homePathForRole, loginPathForRole, resolveAppRoute } from "../src/lib/app-routes";

test("staff and customer use separate canonical URLs", () => {
  assert.equal(homePathForRole("staff"), "/staff");
  assert.equal(loginPathForRole("staff"), "/staff/login");
  assert.equal(homePathForRole("customer"), "/customer");
  assert.equal(loginPathForRole("customer"), "/customer/login");
  assert.equal(APP_PATHS.customerJoin, "/customer/join");
  assert.equal(APP_PATHS.customerRecover, "/customer/recover");
  assert.equal(APP_PATHS.staffInvite, "/staff/invite");
});

test("signed-out visitors reach role-specific authentication pages", () => {
  assert.deepEqual(resolveAppRoute("/staff/login", "signed-out"), { page: "staff-login" });
  assert.deepEqual(resolveAppRoute("/customer/login", "signed-out"), { page: "customer-login" });
  assert.deepEqual(resolveAppRoute("/customer/join", "signed-out"), { page: "customer-join" });
  assert.deepEqual(resolveAppRoute("/customer/recover", "signed-out"), { page: "customer-recover" });
  assert.deepEqual(resolveAppRoute("/staff/invite", "signed-out"), { page: "staff-invite" });
  // Public self-registration is retired; an old link lands on sign-in.
  assert.deepEqual(resolveAppRoute("/customer/register", "signed-out"), { page: "redirect", to: "/customer/login" });
  assert.deepEqual(resolveAppRoute("/customer/login/", "signed-out"), { page: "customer-login" });
});

test("protected and unknown URLs redirect to the matching sign-in path", () => {
  assert.deepEqual(resolveAppRoute("/", "signed-out"), { page: "redirect", to: "/staff/login" });
  assert.deepEqual(resolveAppRoute("/staff", "signed-out"), { page: "redirect", to: "/staff/login" });
  assert.deepEqual(resolveAppRoute("/customer", "signed-out"), { page: "redirect", to: "/customer/login" });
  assert.deepEqual(resolveAppRoute("/customer/missing", "signed-out"), { page: "redirect", to: "/customer/login" });
  assert.deepEqual(resolveAppRoute("/missing", "signed-out"), { page: "redirect", to: "/staff/login" });
});

test("authenticated sessions can only render their own workspace", () => {
  assert.deepEqual(resolveAppRoute("/staff", "staff"), { page: "staff-home" });
  assert.deepEqual(resolveAppRoute("/customer", "customer"), { page: "customer-home" });
  assert.deepEqual(resolveAppRoute("/customer/login", "staff"), { page: "redirect", to: "/staff" });
  assert.deepEqual(resolveAppRoute("/staff/login", "customer"), { page: "redirect", to: "/customer" });
  assert.deepEqual(resolveAppRoute("/", "customer"), { page: "redirect", to: "/customer" });
});

test("a pending Google identity can only accept its invitation; joining a Project explains account switching", () => {
  assert.deepEqual(resolveAppRoute("/staff/invite", "pending"), { page: "staff-invite" });
  assert.deepEqual(resolveAppRoute("/staff", "pending"), { page: "pending-identity" });
  assert.deepEqual(resolveAppRoute("/customer", "pending"), { page: "pending-identity" });
  assert.deepEqual(resolveAppRoute("/customer/join", "staff"), { page: "customer-join" });
  assert.deepEqual(resolveAppRoute("/customer/join", "customer"), { page: "customer-join" });
  assert.deepEqual(resolveAppRoute("/customer/recover", "customer"), { page: "redirect", to: "/customer" });
});

test("session validation blocks rendering until the role is known", () => {
  assert.deepEqual(resolveAppRoute("/customer/login", "loading"), { page: "loading" });
});
