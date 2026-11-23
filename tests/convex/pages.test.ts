import { convexTest } from "convex-test";
import { fixtures, identityTest } from "./identity-harness";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { PAGE_WRITE_SCAN, pageWriteType, reconcilePageWrites, retireTicketPages } from "../../convex/domain/pages";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import { pageFingerprintInput, pageFormData, sha256Hex } from "../../shared/ticket-pages";
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
  "assets/img/dot.png": "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQqDiBFTEMLQkAAtVaAcSRe60AAAAASUVORK5CYII=",
  "assets/fonts/f.woff2": "wOF2 fixture",
};
type Files = Record<string, string>;
const form = (files: Files = bundle, entry = "reports/summary.html") =>
  pageFormData(entry, Object.entries(files).map(([path, text]) => ({ path, blob: new Blob([path === "assets/img/dot.png" ? Uint8Array.from(atob(text),c=>c.charCodeAt(0)) : text]) })));

async function fixture() {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const [staff, alice, bob] = seed.sessions;
  const tickets = await t.run(async ctx => Promise.all(seed.tickets.map(async id => (await ctx.db.get(id))!)));
  const ref = (index: number) => formatTicketNumber(tickets[index].ticketNumber, tickets[index].projectKey);
  const aliceTicket = { id: seed.tickets[1], ref: ref(1) };
  const publish = (token: string | null, ticket: string, body: BodyInit, key: string | null = crypto.randomUUID(), headers: Record<string, string> = {}) =>
    // convex-test delivers the verified JWT subject through withIdentity.
    (token ? t.raw.withIdentity({ subject: token }) : t.raw).fetch(`/v1/tickets/${ticket}/pages`, { method: "POST", body, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "Idempotency-Key": key } : {}), ...headers,
    } });
  const rows = () => t.run(ctx => ctx.db.query("ticketPages").collect());
  const blobs = () => t.run(ctx => ctx.db.system.query("_storage").collect());
  const path = (url: string) => new URL(url).pathname;
  const as = (session: string) => t.raw.withIdentity({ subject: session });
  const aliceId = async () => (await t.query(api.projects.listProjectMembers, { token: staff, projectId: seed.projects[0].id }))
    .find(member => member.username === "alice")!.customerId;
  return { t, seed, staff, alice, bob, aliceTicket, ref, publish, rows, blobs, path, as, aliceId };
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
  const aliceId = await f.aliceId();
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

test("named staff publish; a replay belongs to that staff member only", async () => {
  const f = await fixture();
  const key = crypto.randomUUID();
  const created = await f.publish(f.staff, f.aliceTicket.ref, form(), key);
  expect(created.status).toBe(201);
  const [row] = await f.rows();
  expect([row.actorRole, row.actorCustomerId]).toEqual(["staff", undefined]);
  expect(row.actorStaffId).toBeDefined();
  expect((await f.publish(f.staff, f.aliceTicket.ref, form(), key)).status).toBe(200);
  const colleague = await f.t.mutation(fixtures.staff, { email: "colleague@local.test" });
  const foreign = await f.publish(colleague.session, f.aliceTicket.ref, form(), key);
  expect([foreign.status, (await foreign.json()).code]).toEqual([404, "TICKET_UNAVAILABLE"]);
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
  const tag=(await f.t.fetch(asset)).headers.get("etag")!;
  expect((await f.t.fetch(asset,{headers:{"If-None-Match":tag}})).status).toBe(304);
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
  expect((await f.t.fetch(asset, { headers: { "If-None-Match": tag } })).status).toBe(404);
  await f.t.mutation(api.tickets.restoreTicket, { token: f.staff, id: f.aliceTicket.id, expectedVersion: archived.version });
  expect((await f.t.fetch(entry)).status).toBe(200);

  // Another customer cannot revoke; the owner can, and every file stops opening.
  await expect(f.t.mutation(api.pages.revokeTicketPage, { token: f.bob, pageId: page.pageId })).rejects.toThrow("PAGE_UNAVAILABLE");
  expect(await f.t.mutation(api.pages.revokeTicketPage, { token: f.alice, pageId: page.pageId })).toEqual({ revoked: true });
  expect(await f.t.mutation(api.pages.revokeTicketPage, { token: f.staff, pageId: page.pageId })).toEqual({ revoked: false });
  for (const path of [entry, asset, font]) expect((await f.t.fetch(path)).status, path).toBe(404);
  expect(await f.t.query(api.pages.listTicketPages, { token: f.alice, id: f.aliceTicket.id })).toEqual([]);
  expect((await f.t.fetch(asset,{headers:{"If-None-Match":tag}})).status).toBe(404);
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

test("an interrupted publish retains stored encoder output and rejects drift for a missing file", async () => {
  const f = await fixture();
  const entry = "index.html";
  const original = { [entry]: '<img src="data:image/png;base64,' + bundle["assets/img/dot.png"] + '">' };
  const sourceManifest = await manifestOf(original);
  const sourceDigest = await sha256Hex(new TextEncoder().encode(pageFingerprintInput({
    ticketId: f.aliceTicket.id, entry, files: sourceManifest, imagePolicy: "server",
  })));
  // This row represents a prior encoder which preserved the original image
  // and serialized the img element differently from the current encoder.
  const prior = original[entry] + "\n";
  const manifest = await manifestOf({ [entry]: prior });
  const reserve = (requestId: string) => f.as(f.alice).mutation(internal.pages.reserve, {
    ticket: f.aliceTicket.ref, requestId, entry, manifest, sourceDigest,
  });

  const savedKey = crypto.randomUUID();
  const saved = await reserve(savedKey);
  if (saved.state !== "staging") throw new Error("expected staging");
  const [write] = saved.writes;
  const storageId = await f.t.run(ctx => ctx.storage.store(new Blob([prior], { type: write.contentType })));
  await f.t.mutation(internal.pages.recordStaged, { pageId: saved.pageId, marker: write.marker, storageId, ...manifest[0] });
  const success = await f.publish(f.alice, f.aliceTicket.ref, form(original, entry), savedKey);
  expect(success.status).toBe(201);
  const page = await success.json();
  expect(await (await f.t.fetch(f.path(page.url))).text()).toBe(prior);

  const missingKey = crypto.randomUUID();
  await reserve(missingKey);
  const conflict = await f.publish(f.alice, f.aliceTicket.ref, form(original, entry), missingKey);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ ok: false, code: "PAGE_REQUEST_CONFLICT" });
  expect(await f.blobs()).toHaveLength(1);
});

test("commit rechecks access; expiry records abandonment and only gated reclaim deletes recorded blobs", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const manifest = [{ path: "index.html", size: 3, sha256: await sha256Hex(new TextEncoder().encode("<p>")) }];
  const reserve = (requestId: string) => f.as(f.alice).mutation(internal.pages.reserve, { ticket: f.aliceTicket.ref, requestId, entry: "index.html", manifest });
  const first = await reserve("commit-recheck");
  if (first.state !== "staging") throw new Error("expected staging");
  const [write] = first.writes;
  const storageId = await f.t.run(ctx => ctx.storage.store(new Blob(["<p>"], { type: write.contentType })));
  await f.t.mutation(internal.pages.recordStaged, { pageId: first.pageId, marker: write.marker, path: "index.html", sha256: manifest[0].sha256, size: 3, storageId });
  const aliceId = await f.aliceId();
  await f.t.mutation(api.projects.removeProjectMember, { token: f.staff, projectId: f.seed.projects[0].id, customerId: aliceId });
  await expect(f.as(f.alice).mutation(internal.pages.commit, { pageId: first.pageId })).rejects.toThrow("TICKET_UNAVAILABLE");
  await f.t.run(ctx => ctx.db.insert("projectMembers", { projectId: f.seed.projects[0].id, customerId: aliceId, createdAt: Date.now() }));

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
  expect(await f.as(f.alice).mutation(internal.pages.commit, { pageId: resumed.pageId })).toMatchObject({ entryPath: "index.html" });

  // Purge retires pages; enabled reclaim deletes only blobs recorded on retired rows.
  const unrelated = await f.t.run(ctx => ctx.storage.store(new Blob(["unrelated"])));
  await f.t.run(ctx => retireTicketPages(ctx, f.aliceTicket.id));
  expect((await f.rows())[0].state).toBe("revoked");
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.pages.reclaim, {})).toBe(1);
  expect((await f.blobs()).map(blob => blob._id)).toEqual([unrelated]);
  expect((await f.rows())[0].files).toEqual([]);
});

async function manifestOf(files: Files) {
  return Promise.all(Object.entries(files).map(async ([path, text]) => {
    const bytes = new TextEncoder().encode(text);
    return { path, size: bytes.byteLength, sha256: await sha256Hex(bytes) };
  }));
}

/** Stores bytes exactly as the publishing action does, then "crashes" before recording. */
async function interruptedWrite(f: Awaited<ReturnType<typeof fixture>>, files: Files, requestId: string) {
  const reserved = await f.as(f.alice).mutation(internal.pages.reserve, { ticket: f.aliceTicket.ref, requestId, entry: "index.html", manifest: await manifestOf(files) });
  if (reserved.state !== "staging") throw new Error("expected staging");
  const write = reserved.writes.find(item => item.path === "index.html")!;
  const orphan = await f.t.run(ctx => ctx.storage.store(new Blob([files["index.html"]], { type: write.contentType })));
  // Same bytes that this page does not own: no marker, and a marker no claim issued.
  const unrelated = await f.t.run(ctx => ctx.storage.store(new Blob([files["index.html"]])));
  const forged = await f.t.run(ctx => ctx.storage.store(new Blob([files["index.html"]], { type: pageWriteType("not-a-claim") })));
  return { reserved, write, orphan, unrelated, forged };
}

test("a blob stored before an interrupted record is adopted on retry by its private marker only", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const files = { "index.html": "<p>recovered</p>", "style.css": "body{}" };
  const key = crypto.randomUUID();
  const { reserved, write, orphan, unrelated, forged } = await interruptedWrite(f, files, key);
  expect(reserved.writes.map(item => item.path).sort()).toEqual(["index.html", "style.css"]);
  expect(write.contentType).toBe(`application/vnd.ticket-page-write; write=${write.marker}`);
  expect(write.marker).toMatch(/^[0-9a-f]{64}$/);
  expect((await f.t.run(ctx => ctx.db.system.get(orphan)))?.contentType).toBe(write.contentType);
  vi.advanceTimersByTime(1_000);

  // The interrupted reservation was made for prepared files (no server image policy).
  const retried = await f.publish(f.alice, f.aliceTicket.ref, form(files, "index.html"), key, { "X-Ticket-Image-Policy": "v1" });
  expect(retried.status).toBe(201);
  const page = await retried.json();
  expect(JSON.stringify(page)).not.toContain(write.marker);
  const [row] = await f.rows();
  expect(row.files.find(file => file.path === "index.html")?.storageId).toBe(orphan);
  // The first run's style.css write was never stored; it stays claimed until its window closes.
  const unstored = reserved.writes.find(item => item.path === "style.css")!;
  expect([row.files.length, row.discarded, row.writes?.map(item => item.marker)]).toEqual([2, [], [unstored.marker]]);
  // Only the missing file was stored again; the unrelated and forged blobs are untouched.
  const blobs = (await f.blobs()).map(blob => blob._id);
  expect(blobs.length).toBe(4);
  expect(blobs).toEqual(expect.arrayContaining([orphan, unrelated, forged]));
  expect(row.files.map(file => file.storageId)).not.toContain(unrelated);

  // A late record from the interrupted run changes nothing.
  expect(await f.t.mutation(internal.pages.recordStaged, { pageId: row._id, marker: write.marker, path: "index.html", sha256: write.marker, size: 0, storageId: orphan })).toBe(false);
  expect((await f.rows())[0].discarded).toEqual([]);
  // Serving uses the validated path type, never the stored marker.
  const served = await f.t.fetch(new URL(page.url).pathname);
  expect([served.headers.get("content-type"), await served.text()]).toEqual(["text/html; charset=utf-8", files["index.html"]]);
  vi.advanceTimersByTime(12 * 60 * 1000);
  expect(await f.t.mutation(internal.pages.reconcileWrites, {})).toBe(1);
  const [settled] = await f.rows();
  expect([settled.state, settled.writes, settled.writeCheckAt, settled.discarded, settled.files.length]).toEqual(["published", [], undefined, [], 2]);
  expect((await f.blobs()).length).toBe(4);
});

test("an interrupted write on an abandoned upload is recorded by reconciliation and reclaimed only when enabled", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const files = { "index.html": "<p>orphaned</p>", "style.css": "body{}" };
  const { reserved, orphan, unrelated, forged } = await interruptedWrite(f, files, crypto.randomUUID());
  vi.advanceTimersByTime(60_000);
  // Inside the write window a never-stored file stays claimed; nothing is concluded early.
  await f.t.run(ctx => reconcilePageWrites(ctx, reserved.pageId));
  let [row] = await f.rows();
  expect([row.files.map(file => file.storageId), row.writes?.map(write => write.path)]).toEqual([[orphan], ["style.css"]]);

  vi.advanceTimersByTime(16 * 60 * 1000);
  expect(await f.t.mutation(internal.pages.expireStaging, {})).toBe(1);
  expect(await f.t.mutation(internal.pages.reconcileWrites, {})).toBe(1);
  [row] = await f.rows();
  expect([row.state, row.writes, row.writeCheckAt]).toEqual(["abandoned", [], undefined]);
  expect(await f.t.mutation(internal.pages.reclaim, {})).toBe(0);
  expect((await f.blobs()).length).toBe(3);

  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "true");
  expect(await f.t.mutation(internal.pages.reclaim, {})).toBe(1);
  expect((await f.blobs()).map(blob => blob._id).sort()).toEqual([unrelated, forged].sort());
  expect((await f.rows())[0].files).toEqual([]);
});

test("a write never recorded on a terminal row becomes discarded ownership, never adopted", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const files = { "index.html": "<p>late</p>" };
  const { reserved, orphan, unrelated } = await interruptedWrite(f, files, crypto.randomUUID());
  await f.t.mutation(internal.pages.abandon, { pageId: reserved.pageId });
  vi.advanceTimersByTime(1_000);
  await f.t.run(ctx => reconcilePageWrites(ctx, reserved.pageId));
  const [row] = await f.rows();
  expect([row.files, row.discarded, row.writes]).toEqual([[], [orphan], []]);
  expect(row.reclaimAfter).toBeTypeOf("number");
  expect(row.discarded).not.toContain(unrelated);
});

test("reconciliation reads a bounded number of storage rows per pass and resumes where it stopped", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const files = { "index.html": "<p>busy</p>" };
  const reserved = await f.as(f.alice).mutation(internal.pages.reserve, { ticket: f.aliceTicket.ref, requestId: crypto.randomUUID(), entry: "index.html", manifest: await manifestOf(files) });
  if (reserved.state !== "staging") throw new Error("expected staging");
  await f.t.run(async ctx => { for (let index = 0; index < PAGE_WRITE_SCAN + 20; index++) await ctx.storage.store(new Blob([`other ${index}`])); });
  const orphan = await f.t.run(ctx => ctx.storage.store(new Blob([files["index.html"]], { type: reserved.writes[0].contentType })));
  vi.advanceTimersByTime(1_000);
  await f.t.run(ctx => reconcilePageWrites(ctx, reserved.pageId));
  let [row] = await f.rows();
  expect([row.files, row.writes?.length]).toEqual([[], 1]);
  expect(row.writes![0].scannedTo).toBeGreaterThan(row.createdAt - 1_000);
  await f.t.run(ctx => reconcilePageWrites(ctx, reserved.pageId));
  [row] = await f.rows();
  expect([row.files.map(file => file.storageId), row.writes]).toEqual([[orphan], []]);
});

test("raw API resizes image bytes, preserves the authored path, and rejects a forged prepared claim", async () => {
  const {default:sharp}=await import("sharp");
  const f=await fixture();
  const source=await sharp({create:{width:2500,height:500,channels:4,background:"#237c9a80"}}).png().toBuffer();
  const body=()=>pageFormData("index.html",[
    {path:"index.html",blob:new Blob(['<img src="picture.png">'])},
    {path:"picture.png",blob:new Blob([new Uint8Array(source)])},
  ]);
  const failed=await f.publish(f.alice,f.aliceTicket.ref,body(),crypto.randomUUID(),{"X-Ticket-Image-Policy":"v1"});
  expect(failed.status).toBe(400);
  const published=await f.publish(f.alice,f.aliceTicket.ref,body());
  expect(published.status).toBe(201);
  const {url}=await published.json();
  const asset=await f.t.fetch(f.path(new URL("picture.png",url).href));
  const out=Buffer.from(await asset.arrayBuffer());
  const metadata=await sharp(out).metadata();
  expect([metadata.width,metadata.height,metadata.hasAlpha]).toEqual([1920,384,true]);
  expect(asset.headers.get("content-type")).toBe("image/"+metadata.format);
});

test("browser originals are converted once on the server; the image policy is part of the request identity", async () => {
  const { default: sharp } = await import("sharp");
  const f = await fixture();
  const [w, h] = [1200, 800];
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([x * 255 / w, y * 255 / h, 128], (y * w + x) * 3);
  const jpeg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const html = `<!doctype html><h1>สรุป</h1><img alt="shot" src="data:image/jpeg;base64,${jpeg.toString("base64")}">`;
  const body = () => pageFormData("report.html", [{ path: "report.html", blob: new Blob([html]) }]);
  const key = crypto.randomUUID();
  const created = await f.publish(f.alice, f.aliceTicket.ref, body(), key, { Origin: APP });
  expect(created.status).toBe(201);
  const page = await created.json();
  const served = await (await f.t.fetch(f.path(page.url))).text();
  const [, type, base64] = /src="data:(image\/[a-z]+);base64,([^"]+)"/.exec(served)!;
  const stored = Buffer.from(base64, "base64");
  const meta = await sharp(stored).metadata();
  // Authored markup and text stay; the image changes format only when smaller.
  expect(served.startsWith("<!doctype html><h1>สรุป</h1><img alt=\"shot\" src=\"data:")).toBe(true);
  expect(type).not.toBe("image/jpeg");
  expect(type).toBe(meta.format === "heif" ? "image/avif" : "image/" + meta.format);
  expect([meta.width, meta.height]).toEqual([w, h]);
  expect(stored.length).toBeLessThan(jpeg.length);
  expect(page.totalBytes).toBe(new TextEncoder().encode(served).length);
  // The same originals declared as prepared are a different request under this key.
  const prepared = await f.publish(f.alice, f.aliceTicket.ref, body(), key, { "X-Ticket-Image-Policy": "v1" });
  expect([prepared.status, (await prepared.json()).code]).toEqual([409, "PAGE_REQUEST_CONFLICT"]);
  expect((await f.publish(f.alice, f.aliceTicket.ref, body(), key)).status).toBe(200);
});

test("temporary image chunks are consumed once and abandoned chunks expire", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const bytes = Uint8Array.of(1, 2, 3).buffer;
  const makeChunk = () => t.mutation(internal.image_chunks.put, { bytes });
  const taken = await makeChunk();
  const abandoned = await makeChunk();
  expect(new Uint8Array(await t.mutation(internal.image_chunks.take, { id: taken }))).toEqual(new Uint8Array(bytes));
  expect(await t.run(ctx => ctx.db.get(taken))).toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run(ctx => ctx.db.get(abandoned))).toBeNull();
});
