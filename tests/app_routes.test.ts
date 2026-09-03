import assert from "node:assert/strict";
import test from "node:test";
import { APP_PATHS, homePathForRole, loginPathForRole, resolveAppRoute } from "../src/lib/app-routes";

test("staff and customer use separate canonical URLs", () => {
  assert.equal(homePathForRole("staff"), "/staff");
  assert.equal(loginPathForRole("staff"), "/staff/login");
  assert.equal(homePathForRole("customer"), "/customer");
  assert.equal(loginPathForRole("customer"), "/customer/login");
  assert.equal(APP_PATHS.customerRegister, "/customer/register");
});

test("signed-out visitors reach role-specific authentication pages", () => {
  assert.deepEqual(resolveAppRoute("/staff/login", "signed-out"), { page: "staff-login" });
  assert.deepEqual(resolveAppRoute("/customer/login", "signed-out"), { page: "customer-login" });
  assert.deepEqual(resolveAppRoute("/customer/register", "signed-out"), { page: "customer-register" });
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

test("session validation blocks rendering until the role is known", () => {
  assert.deepEqual(resolveAppRoute("/customer/login", "loading"), { page: "loading" });
});
