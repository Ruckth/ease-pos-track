import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { router, type RouterContext } from "../src/app/router";
import { currentInvitation } from "../src/app/auth-store";

type Auth = RouterContext["auth"];
type Viewer = Extract<Auth, { status: "signed-in" }>["viewer"];
const signedIn = (viewer: Partial<Viewer> & { kind: Viewer["kind"] }) => ({ status: "signed-in", viewer } as Auth);
const out: Auth = { status: "signed-out" };
const staff = signedIn({ kind: "staff", staffId: "s1" as never, role: "owner", name: "Owner", email: "owner@example.com" });
const customer = signedIn({ kind: "customer", customerId: "c1" as never });
const pending = signedIn({ kind: "pending", email: "new@example.com" });

/**
 * Node loads through the router's server path, which records a thrown redirect
 * instead of navigating. Follow redirects the way the browser router would.
 */
async function land(href: string, auth: Auth) {
  for (let hop = 0; hop < 4; hop++) {
    const memory = createRouter({ ...router.options, history: createMemoryHistory({ initialEntries: [href] }), context: { auth } });
    await memory.load();
    const result = memory._serverResult;
    if (result?.type !== "redirect") return { href, matches: memory.state.matches.map(match => match.routeId) };
    assert.ok(result.redirect.options.href);
    href = result.redirect.options.href;
  }
  throw new Error(`redirect loop from ${href}`);
}

test("the code-based tree keeps main's URL paths and their guards", async () => {
  assert.deepEqual(await land("/", out), { href: "/staff/login", matches: ["__root__", "/staff/login"] });
  assert.deepEqual(await land("/customer/register", out), { href: "/customer/login", matches: ["__root__", "/customer/login"] });
  for (const path of ["/customer/join", "/customer/recover", "/staff/invite"]) {
    assert.deepEqual(await land(path, out), { href: path, matches: ["__root__", path] });
  }
  assert.equal((await land("/staff?project=POS", out)).href, "/staff/login?redirect=%2Fstaff%3Fproject%3DPOS");
  assert.equal((await land("/customer/anything", out)).href, "/customer/login");
  assert.equal((await land("/nowhere", customer)).href, "/customer");
  assert.equal((await land("/customer/login?redirect=%2Fstaff", staff)).href, "/staff");
});

test("T3 settings is a child of the one staff workspace and keeps its query", async () => {
  assert.deepEqual(await land("/staff/settings/t3?project=POS", staff),
    { href: "/staff/settings/t3?project=POS", matches: ["__root__", "/staff", "/staff/settings/t3"] });
  assert.deepEqual((await land("/staff", staff)).matches, ["__root__", "/staff", "/staff/"]);
  assert.equal((await land("/staff/settings/t3", out)).href, "/staff/login?redirect=%2Fstaff%2Fsettings%2Ft3");
  assert.equal((await land("/staff/settings/t3", customer)).href, "/customer");
});

test("a pending Google identity stays on its URL behind the Gate", async () => {
  assert.deepEqual(await land("/staff", pending), { href: "/staff", matches: ["__root__", "/staff", "/staff/"] });
  assert.equal((await land("/customer", pending)).href, "/customer");
  assert.equal((await land("/staff/invite", pending)).href, "/staff/invite");
});

test("a same-role return target survives sign-in with its literal query", async () => {
  const back = await land("/staff/login?redirect=%2Fstaff%3Fproject%3DPOS%26q%3D007", staff);
  assert.deepEqual(back.matches, ["__root__", "/staff", "/staff/"]);
  assert.equal(back.href, "/staff?project=POS&q=007");
  assert.equal((await land("/customer/login?redirect=%2Fstaff%3Fproject%3DPOS", customer)).href, "/customer");
});

test("a customer invitation is held only through the join, sign-in and recovery flow", async () => {
  await land("/customer/join#invite=secret-1", out);
  assert.equal(currentInvitation(), "secret-1");
  await land("/customer/login", out);
  assert.equal(currentInvitation(), "secret-1");
  // A customer who signs in while holding it returns to finish joining.
  assert.equal((await land("/customer/login", customer)).href, "/customer/join");
  await land("/staff/login", out);
  assert.equal(currentInvitation(), "");
});
