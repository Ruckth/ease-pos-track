import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { retireTicketPages } from "../../convex/domain/pages";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import { pageFormData, sha256Hex } from "../../shared/ticket-pages";
import { modules } from "./modules";

const SITE = "http://127.0.0.1:3213";
const APP = "http://127.0.0.1:5173";

beforeEach(() => {
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("TICKET_APP_ORIGINS", APP);
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

// A nested entry with relative CSS, script, image and font references.
const bundle = {
  "reports/summary.html": '<!doctype html><link rel="stylesheet" href="../assets/site.css"><img src="../assets/img/dot.png"><script src="../assets/app.js"></script>',
  "assets/site.css": '@font-face{font-family:F;src:url(fonts/f.woff2)} body{background:url(img/dot.png)}',
  "assets/app.js": 'document.body.dataset.ran = "yes";',
  "assets/img/dot.png": "\x89PNG fixture",
  "assets/fonts/f.woff2": "wOF2 fixture",
};
type Files = Record<string, string>;
const form = (files: Files = bundle, entry = "reports/summary.html") =>
  pageFormData(entry, Object.entries(files).map(([path, text]) => ({ path, blob: new Blob([text]) })));

async function fixture() {
  const t = convexTest(schema, modules);
  const seed = await t.mutation(internal.seed.install, {
    passwordAlgorithm: "fixture", passwordSalt: "fixture", passwordHash: "fixture", passwordIterations: 1,
  });
  const [staff, alice, bob] = seed.sessions;
  const tickets = await t.run(async ctx => Promise.all(seed.tickets.map(async id => (await ctx.db.get(id))!)));
  const ref = (index: number) => formatTicketNumber(tickets[index].ticketNumber, tickets[index].projectKey);
  const aliceTicket = { id: seed.tickets[1], ref: ref(1) };
  const publish = (token: string | null, ticket: string, body: BodyInit, key: string | null = crypto.randomUUID(), headers: Record<string, string> = {}) =>
    t.fetch(`/v1/tickets/${ticket}/pages`, { method: "POST", body, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "Idempotency-Key": key } : {}), ...headers,
    } });
  const rows = () => t.run(ctx => ctx.db.query("ticketPages").collect());
  const blobs = () => t.run(ctx => ctx.db.system.query("_storage").collect());
  const path = (url: string) => new URL(url).pathname;
  return { t, seed, staff, alice, bob, aliceTicket, ref, publish, rows, blobs, path };
}

test("authority is checked before the body is read; nothing is reserved or stored on rejection", async () => {
  const f = await fixture();
  const garbage = "not a multipart body";
  const cases: Array<[string | null, string, number, string]> = [
    [null, f.aliceTicket.ref, 401, "AUTH_REQUIRED"],
    ["missing-session", f.aliceTicket.ref, 401, "SESSION_EXPIRED"],
    [f.bob, f.aliceTicket.ref, 404, "TICKET_UNAVAILABLE"],
    [f.alice, "POS-9999", 404, "TICKET_UNAVAILABLE"],
    [f.alice, "not-a-ticket", 404, "TICKET_UNAVAILABLE"],
  ];
  for (const [token, ticket, status, code] of cases) {
    const response = await f.publish(token, ticket, garbage, crypto.randomUUID(), { "Content-Type": "multipart/form-data; boundary=x" });
    expect([response.status, (await response.json()).code], `${token} ${ticket}`).toEqual([status, code]);
  }
  const foreign = await f.publish(f.alice, f.aliceTicket.ref, form(), crypto.randomUUID(), { Origin: "https://elsewhere.example" });
  expect([foreign.status, (await foreign.json()).code]).toEqual([403, "ORIGIN_NOT_ALLOWED"]);
  const noKey = await f.publish(f.alice, f.aliceTicket.ref, form(), null);
  expect(noKey.status).toBe(400);
  // A customer who lost Project membership is denied the same way.
  const members = await f.t.query(api.projects.listProjectMembers, { token: f.staff, projectId: f.seed.projects[0].id });
  const aliceId = members.find(member => member.email === "alice@local.test")!.customerId;
  await f.t.mutation(api.projects.removeProjectMember, { token: f.staff, projectId: f.seed.projects[0].id, customerId: aliceId });
  const removed = await f.publish(f.alice, f.aliceTicket.ref, form());
  expect([removed.status, (await removed.json()).code]).toEqual([404, "TICKET_UNAVAILABLE"]);
  expect(await f.rows()).toEqual([]);
  expect(await f.blobs()).toEqual([]);
});

test("repeated, unnamed and excess multipart fields are rejected before staging", async () => {
  const f = await fixture();
  const repeated = form(); repeated.append("f0", new Blob(["<p>unhashed</p>"]), "extra.html");
  const unnamed = form(); unnamed.append("f99", new Blob(["x"]), "x.css");
  const doubled = form(); doubled.append("entry", "reports/summary.html");
  for (const body of [repeated, unnamed, doubled]) {
    const response = await f.publish(f.alice, f.aliceTicket.ref, body);
    expect([response.status, (await response.json()).code]).toEqual([400, "PAGE_FORM_INVALID"]);
  }
  const unsafe = await f.publish(f.alice, f.aliceTicket.ref, form({ "../escape.html": "<p>x</p>" }, "../escape.html"));
  expect([unsafe.status, (await unsafe.json()).code]).toEqual([400, "PAGE_PATH_INVALID"]);
  const typed = await f.publish(f.alice, f.aliceTicket.ref, form({ "index.html": "", "tool.exe": "MZ" }, "index.html"));
  expect([typed.status, (await typed.json()).code]).toEqual([400, "PAGE_FILE_TYPE_UNSUPPORTED"]);
  expect(await f.rows()).toEqual([]);
});

test("customer publishes a nested folder; replay returns the original link; changed content conflicts", async () => {
  const f = await fixture();
  const key = crypto.randomUUID();
  const created = await f.publish(f.alice, f.aliceTicket.ref, form(), key, { Origin: APP });
  expect(created.status).toBe(201);
  expect(created.headers.get("access-control-allow-origin")).toBe(APP);
  const page = await created.json();
  expect(page).toMatchObject({ ok: true, ticket: f.aliceTicket.ref, entry: "reports/summary.html", fileCount: 5, created: true, requestId: key });
  expect(page.url).toMatch(new RegExp(`^${SITE}/p/[A-Za-z0-9_-]{43}/reports/summary\\.html$`));

  const replay = await f.publish(f.alice, f.aliceTicket.ref, form(), key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ url: page.url, pageId: page.pageId, created: false });
  const changed = await f.publish(f.alice, f.aliceTicket.ref, form({ ...bundle, "assets/app.js": "changed" }), key);
  expect([changed.status, (await changed.json()).code]).toEqual([409, "PAGE_REQUEST_CONFLICT"]);
  // Another actor learns nothing about a key it does not own.
  const foreign = await f.publish(f.staff, f.aliceTicket.ref, form(), key);
  expect([foreign.status, (await foreign.json()).code]).toEqual([404, "TICKET_UNAVAILABLE"]);
  expect((await f.rows()).length).toBe(1);
  expect((await f.blobs()).length).toBe(5);

  // Staff and the owner list it; another customer cannot.
  expect((await f.t.query(api.pages.listTicketPages, { token: f.staff, id: f.aliceTicket.id })).map(row => row.url)).toEqual([page.url]);
  expect((await f.t.query(api.pages.listTicketPages, { token: f.alice, id: f.aliceTicket.id })).length).toBe(1);
  expect(await f.t.query(api.pages.listTicketPages, { token: f.bob, id: f.aliceTicket.id })).toEqual([]);
});

test("serving checks publication, lifecycle and revocation on every HTML and asset read", async () => {
  const f = await fixture();
  const page = await (await f.publish(f.alice, f.aliceTicket.ref, form())).json();
  const entry = f.path(page.url);
  const asset = f.path(new URL("../assets/img/dot.png", page.url).href);
  const font = f.path(new URL("../assets/fonts/f.woff2", page.url).href);
  const html = await f.t.fetch(entry);
  expect(html.status).toBe(200);
  expect(await html.text()).toBe(bundle["reports/summary.html"]);
  expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const csp = html.headers.get("content-security-policy")!;
  expect(csp.split("; ")[0]).toBe("sandbox allow-scripts");
  expect(csp).toContain("connect-src 'none'");
  for (const [name, value] of [["cache-control", "no-store"], ["x-content-type-options", "nosniff"], ["referrer-policy", "no-referrer"], ["x-robots-tag", "noindex, nofollow, noarchive"]]) {
    expect(html.headers.get(name), name).toBe(value);
  }
  expect((await f.t.fetch(asset)).headers.get("content-type")).toBe("image/png");
  const fontResponse = await f.t.fetch(font);
  expect([fontResponse.status, fontResponse.headers.get("content-type"), fontResponse.headers.get("access-control-allow-origin")]).toEqual([200, "font/woff2", "*"]);
  const bare = await f.t.fetch(entry.replace(/\/reports\/summary\.html$/, ""), { redirect: "manual" });
  expect([bare.status, bare.headers.get("location")]).toEqual([302, entry]);
  for (const probe of [entry.replace("summary", "missing"), entry.replace("reports/summary.html", "%2e%2e/x.html"), "/p/short/x.html"]) {
    expect((await f.t.fetch(probe)).status, probe).toBe(404);
  }

  // Archive hides the page; restore brings the same link back.
  const ticket = (await f.t.query(api.tickets.getTicket, { token: f.alice, id: f.aliceTicket.id }))!;
  const archived = await f.t.mutation(api.tickets.archiveTicket, { token: f.alice, id: f.aliceTicket.id, expectedVersion: ticket.version });
  expect((await f.t.fetch(entry)).status).toBe(404);
  expect((await f.t.fetch(asset)).status).toBe(404);
  const blocked = await f.publish(f.alice, f.aliceTicket.ref, form());
  expect([blocked.status, (await blocked.json()).code]).toEqual([404, "TICKET_UNAVAILABLE"]);
  await f.t.mutation(api.tickets.restoreTicket, { token: f.staff, id: f.aliceTicket.id, expectedVersion: archived.version });
  expect((await f.t.fetch(entry)).status).toBe(200);

  // Another customer cannot revoke; the owner can, and every file stops opening.
  await expect(f.t.mutation(api.pages.revokeTicketPage, { token: f.bob, pageId: page.pageId })).rejects.toThrow("PAGE_UNAVAILABLE");
  expect(await f.t.mutation(api.pages.revokeTicketPage, { token: f.alice, pageId: page.pageId })).toEqual({ revoked: true });
  expect(await f.t.mutation(api.pages.revokeTicketPage, { token: f.staff, pageId: page.pageId })).toEqual({ revoked: false });
  for (const path of [entry, asset, font]) expect((await f.t.fetch(path)).status, path).toBe(404);
  expect(await f.t.query(api.pages.listTicketPages, { token: f.alice, id: f.aliceTicket.id })).toEqual([]);
  const reused = await f.publish(f.alice, f.aliceTicket.ref, form(), page.requestId);
  expect([reused.status, (await reused.json()).code]).toEqual([409, "PAGE_REVOKED"]);
});

test("an unexpected storage failure is retryable; the same key stages only missing files", async () => {
  const f = await fixture();
  const files = { "index.html": "<p>retry</p>", "style.css": "x".repeat(777) };
  const key = crypto.randomUUID();
  // The second digest of the 777-byte file is the storage write, after hashing and reservation.
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let seen = 0;
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    if ((data as ArrayBuffer).byteLength === 777 && ++seen === 2) throw new TypeError("storage unavailable");
    return digest(algorithm, data);
  });
  const failed = await f.publish(f.alice, f.aliceTicket.ref, form(files, "index.html"), key);
  expect([failed.status, failed.headers.get("retry-after")]).toEqual([503, "2"]);
  expect(await failed.json()).toEqual({ ok: false, code: "PAGE_PUBLISH_UNKNOWN", retryable: true });
  const [staged] = await f.rows();
  expect([staged.state, staged.files.map(file => file.path), staged.shareKey]).toEqual(["staging", ["index.html"], undefined]);
  vi.restoreAllMocks();

  const retried = await f.publish(f.alice, f.aliceTicket.ref, form(files, "index.html"), key);
  expect(retried.status).toBe(201);
  const [row] = await f.rows();
  expect([row.state, row.files.map(file => file.path).sort(), row.discarded]).toEqual(["published", ["index.html", "style.css"], []]);
  expect((await f.blobs()).length).toBe(2);
});

test("commit rechecks access; expiry records abandonment and only gated reclaim deletes recorded blobs", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const manifest = [{ path: "index.html", size: 3, sha256: await sha256Hex(new TextEncoder().encode("<p>")) }];
  const reserve = (requestId: string) => f.t.mutation(internal.pages.reserve, { token: f.alice, ticket: f.aliceTicket.ref, requestId, entry: "index.html", manifest });
  const stage = async (pageId: Id<"ticketPages">) => {
    const storageId = await f.t.run(ctx => ctx.storage.store(new Blob(["<p>"])));
    await f.t.mutation(internal.pages.recordStaged, { pageId, path: "index.html", sha256: manifest[0].sha256, size: 3, storageId });
  };
  const first = await reserve("commit-recheck");
  if (first.state !== "staging") throw new Error("expected staging");
  await stage(first.pageId);
  const members = await f.t.query(api.projects.listProjectMembers, { token: f.staff, projectId: f.seed.projects[0].id });
  const aliceId = members.find(member => member.email === "alice@local.test")!.customerId;
  await f.t.mutation(api.projects.removeProjectMember, { token: f.staff, projectId: f.seed.projects[0].id, customerId: aliceId });
  await expect(f.t.mutation(internal.pages.commit, { token: f.alice, pageId: first.pageId })).rejects.toThrow("TICKET_UNAVAILABLE");
  await f.t.mutation(api.projects.addProjectMember, { token: f.staff, projectId: f.seed.projects[0].id, email: "alice@local.test" });

  vi.advanceTimersByTime(16 * 60 * 1000);
  expect(await f.t.mutation(internal.pages.expireStaging, {})).toBe(1);
  expect((await f.rows())[0].state).toBe("abandoned");
  // Cleanup disabled: nothing is deleted.
  expect(await f.t.mutation(internal.pages.reclaim, {})).toBe(0);
  expect((await f.blobs()).length).toBe(1);
  // A same-key retry after expiry resumes with the recorded file and publishes.
  const resumed = await reserve("commit-recheck");
  expect(resumed).toMatchObject({ state: "staging", staged: [{ path: "index.html" }] });
  if (resumed.state !== "staging") throw new Error("expected staging");
  expect(await f.t.mutation(internal.pages.commit, { token: f.alice, pageId: resumed.pageId })).toMatchObject({ entryPath: "index.html" });

  // Purge retires pages; enabled reclaim deletes only blobs recorded on retired rows.
  const unrelated = await f.t.run(ctx => ctx.storage.store(new Blob(["unrelated"])));
  await f.t.run(ctx => retireTicketPages(ctx, f.aliceTicket.id));
  expect((await f.rows())[0].state).toBe("revoked");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.pages.reclaim, {})).toBe(1);
  expect((await f.blobs()).map(blob => blob._id)).toEqual([unrelated]);
  expect((await f.rows())[0].files).toEqual([]);
});
