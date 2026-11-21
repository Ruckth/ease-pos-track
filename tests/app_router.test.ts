import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { router, type RouterContext } from "../src/app/router";

type Auth = RouterContext["auth"];
const out: Auth = { status: "signed-out" };
const staff: Auth = { status: "signed-in", token: "t", role: "staff", email: null };
const customer: Auth = { status: "signed-in", token: "t", role: "customer", email: "c@example.com" };

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

test("the code-based tree keeps the six URL paths and their guards", async () => {
  assert.deepEqual(await land("/", out), { href: "/staff/login", matches: ["__root__", "/staff/login"] });
  assert.deepEqual(await land("/customer/register", out), { href: "/customer/register", matches: ["__root__", "/customer/register"] });
  assert.equal((await land("/staff?project=POS", out)).href, "/staff/login?redirect=%2Fstaff%3Fproject%3DPOS");
  assert.equal((await land("/customer/anything", out)).href, "/customer/login");
  assert.equal((await land("/nowhere", customer)).href, "/customer");
  assert.equal((await land("/customer/login?redirect=%2Fstaff", staff)).href, "/staff");
});

test("a same-role return target survives sign-in with its literal query", async () => {
  const back = await land("/staff/login?redirect=%2Fstaff%3Fproject%3DPOS%26q%3D007", staff);
  assert.deepEqual(back.matches, ["__root__", "/staff"]);
  assert.equal(back.href, "/staff?project=POS&q=007");
  assert.equal((await land("/customer/login?redirect=%2Fstaff%3Fproject%3DPOS", customer)).href, "/customer");
  assert.equal((await land("/customer/register?redirect=%2Fapi%2Fuploads", customer)).href, "/customer");
});
