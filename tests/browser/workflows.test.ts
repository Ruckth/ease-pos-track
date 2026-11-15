import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { loadPorts } from "../../scripts/worktree-ports.mjs";
import { translations, translate } from "../../src/lib/i18n";

const baseURL = process.env.BROWSER_BASE_URL!;
const seed = JSON.parse(process.env.BROWSER_FIXTURE!) as { sessions: string[]; projects: { id: Id<"projects">; key: string }[] };
const convex = new ConvexHttpClient(`http://127.0.0.1:${loadPorts().CONVEX_CLOUD_PORT}`);
let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }); });
after(async () => { await browser?.close(); });

type Language = "en" | "th";
type DraftStats = { created: string[]; revoked: string[]; streams: string[]; stops: string[]; aborts: number };
declare global { interface Window { draftStats: DraftStats } }
function copy(language: Language, key: keyof typeof translations.en, values?: Record<string, string | number>) { return translate(language, key, values); }
async function open(role: "staff" | "customer", language: Language = "en", configure?: (context: BrowserContext) => Promise<void>) {
  const context = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 900 } });
  let uploads = 0;
  await context.route(/\/api\/uploadthing|https:\/\/[^/]*(?:uploadthing|ufs\.sh)/, async route => { uploads++; await route.abort(); });
  const credentials = role === "staff"
    ? await convex.action(api.auth.login, { password: "LocalStaff123!", clientId: crypto.randomUUID() })
    : await convex.action(api.customers.login, { email: "alice@local.test", password: "LocalCustomer123!", clientId: crypto.randomUUID() });
  // tsx preserves nested function names with this helper when Playwright
  // serializes an evaluate callback; it exists only in the isolated test page.
  await context.addInitScript("globalThis.__name = (fn) => fn;");
  await context.addInitScript(({ token, language }) => {
    sessionStorage.setItem("ease-pos-tracking-session", token);
    localStorage.setItem("ease-pos-tracking-language", language);
    const stats = { created: [] as string[], revoked: [] as string[], stops: [] as string[], streams: [] as string[], aborts: 0 };
    Object.assign(window, { draftStats: stats });
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); stats.created.push(url); return url; };
    URL.revokeObjectURL = url => { stats.revoked.push(url); revoke(url); };
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getMedia(constraints);
      for (const track of stream.getTracks()) {
        stats.streams.push(track.id);
        const stop = track.stop.bind(track);
        track.stop = () => { stats.stops.push(track.id); stop(); };
      }
      return stream;
    };
    const abort = AbortController.prototype.abort;
    AbortController.prototype.abort = function (reason) { stats.aborts++; abort.call(this, reason); };
  }, { token: credentials.token, language });
  await configure?.(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseURL}/${role}?project=POS`);
  try {
    await page.getByRole("button", { name: copy(language, "newTicket"), exact: true }).first().click();
  } catch (error) {
    console.error("App startup failure", page.url(), (await page.locator("body").innerText()).slice(-3000), errors);
    await context.close(); throw error;
  }
  const title = page.locator(role === "staff" ? "#title" : "#customer-ticket-title");
  await title.waitFor({ state: "visible" });
  try {
    await page.waitForFunction(id => document.activeElement?.id === id, role === "staff" ? "title" : "customer-ticket-title", { timeout: 5000 });
  } catch (error) {
    console.error("Focus failure", (await page.locator("body").innerText()).slice(-3000), await page.evaluate(() => document.activeElement?.outerHTML), errors);
    await context.close(); throw error;
  }
  return { context, page, title, errors, token: credentials.token, uploads: () => uploads };
}
async function stats(page: Page) { return page.evaluate(() => window.draftStats); }
async function files(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#8ab"; ctx.fillRect(0, 0, 320, 240);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") });
}

for (const role of ["staff", "customer"] as const) for (const language of ["en", "th"] as const) {
  test(`${role} ${language}: focus, pointer pin removal, camera teardown and unmount`, async () => {
    const { context, page, title, errors, token, uploads } = await open(role, language);
    try {
      await title.fill("Browser draft");
      if (role === "customer") await page.getByRole("button", { name: copy(language, "next"), exact: true }).click();
      await files(page);
      const preview = page.getByRole("button", { name: copy(language, "openMedia", { name: "draft.png" }), exact: true });
      await preview.click();
      await page.getByRole("button", { name: copy(language, "addPin"), exact: true }).click();
      const image = page.getByRole("dialog").last().locator('img').first();
      await image.click({ position: { x: 30, y: 30 } });
      const note = page.getByPlaceholder(copy(language, "describeIssue"));
      await note.waitFor({ state: "visible" });
      assert.equal(await note.evaluate(element => element === document.activeElement), true);
      await note.fill("Pointer note");
      await page.getByRole("button", { name: copy(language, "savePin"), exact: true }).last().click();
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).last().click();
      await page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label, copy(language, "openMedia", { name: "draft.png" }));
      assert.equal(await preview.evaluate(element => element === document.activeElement), true);
      // Closing/reopening the real composer remounts DOM consumers in StrictMode.
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: copy(language, role === "staff" ? "resumeTicket" : "newTicket"), exact: true }).first().click();
      assert.equal((await stats(page)).revoked.length, 0);
      if (role === "customer") await page.getByRole("button", { name: copy(language, "next"), exact: true }).click();
      await page.getByRole("button", { name: copy(language, "removeFile", { name: "draft.png" }), exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: copy(language, "removeMedia"), exact: true }).click();
      await page.waitForFunction(() => window.draftStats.revoked.length === 1);
      assert.equal(await page.getByText(copy(language, "pinSummary", { count: 1 }), { exact: true }).count(), 0);
      await page.getByRole("button", { name: copy(language, "takePhoto"), exact: true }).click();
      const camera = page.getByRole("dialog", { name: copy(language, "camera"), exact: true });
      await camera.getByRole("button", { name: copy(language, "takePhoto"), exact: true }).waitFor({ state: "visible" });
      await page.waitForFunction(() => window.draftStats.streams.length > 0);
      if (language === "en") {
        await camera.getByRole("button", { name: copy(language, "takePhoto"), exact: true }).click();
      } else {
        await camera.getByRole("button", { name: copy(language, "cancel"), exact: true }).click();
        await files(page);
      }
      await camera.waitFor({ state: "hidden" });
      await page.waitForFunction(() => window.draftStats.stops.length === window.draftStats.streams.length);
      await page.getByRole("button", { name: copy(language, "takePhoto"), exact: true }).click();
      await page.waitForFunction(() => window.draftStats.streams.length === 2);
      // Expiry while a camera is open unmounts the whole role experience.
      // The document stays loaded so instrumentation observes React teardown.
      await convex.mutation(api.auth.logout, { token });
      await page.waitForFunction(() => window.draftStats.revoked.length === 2 && window.draftStats.stops.length === 2);
      await page.locator(role === "staff" ? "#staff-password" : "#customer-password").waitFor({ state: "visible" });
      const observed = await stats(page);
      assert.deepEqual(observed.revoked, observed.created);
      assert.equal(new Set(observed.stops).size, observed.stops.length);
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } catch (error) { console.error("Browser state", await stats(page), (await page.locator("body").innerText()).slice(-3000)); throw error; } finally { await context.close(); }
  });
}

for (const role of ["staff", "customer"] as const) test(`${role}: Project switch keeps saved draft in its captured Project; text success and edit undo`, async () => {
  const { context, page, title, errors, uploads } = await open(role);
  try {
    const name = `P6 ${role} ${crypto.randomUUID()}`;
    // An empty, idle composer follows the newly selected Project.
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("combobox", { name: "Choose Project", exact: true }).selectOption("APP");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    await page.getByRole("dialog").getByText("Customer App (APP)", { exact: true }).waitFor();
    assert.equal(await title.inputValue(), "");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("combobox", { name: "Choose Project", exact: true }).selectOption("POS");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    await title.fill(name);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("combobox", { name: "Choose Project", exact: true }).selectOption("APP");
    await page.getByRole("button", { name: copy("en", role === "staff" ? "resumeTicket" : "newTicket"), exact: true }).first().click();
    assert.equal(await title.inputValue(), name);
    await page.getByRole("dialog").getByText("Point of Sale (POS)", { exact: true }).waitFor();
    if (role === "customer") {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "Skip for now", exact: true }).click();
    }
    await page.getByRole("button", { name: copy("en", role === "staff" ? "submit" : "submitTicket"), exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const matches = await convex.query(api.tickets.searchTickets, { token: seed.sessions[role === "staff" ? 0 : 1], projectId: seed.projects.find(p => p.key === "POS")!.id, search: name, lifecycle: "active" });
    const created = matches.matches.find(item => item.title === name);
    assert.ok(created, "Draft committed to POS after switching to APP");
    assert.equal(created.projectKey, "POS");
    await page.getByRole("combobox", { name: "Choose Project", exact: true }).selectOption("POS");
    if (role === "staff") await page.getByPlaceholder("Search", { exact: true }).fill(name);
    await page.getByRole("button", { name: `Open ticket ${created.projectKey}-${String(created.ticketNumber).padStart(4, "0")}`, exact: true }).click();
    await page.getByRole("button", { name: copy("en", role === "staff" ? "edit" : "editTicket"), exact: true }).click();
    await page.locator(role === "staff" ? "#edit-ticket-title" : "#customer-edit-title").fill(`${name} edited`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).last().click();
    await page.getByRole("dialog").getByRole("heading", { name: `${created.projectKey}-${String(created.ticketNumber).padStart(4, "0")} · ${name}`, exact: true }).waitFor();
    assert.equal((await convex.query(api.tickets.getTicket, { token: seed.sessions[role === "staff" ? 0 : 1], id: created._id }))?.title, name);
    // A subscription received while editing must not silently rebase the intent.
    await page.getByRole("button", { name: copy("en", role === "staff" ? "edit" : "editTicket"), exact: true }).click();
    await page.locator(role === "staff" ? "#edit-ticket-title" : "#customer-edit-title").fill("Unsaved stale edit");
    const current = (await convex.query(api.tickets.getTicket, { token: seed.sessions[0], id: created._id }))!;
    await convex.mutation(api.tickets.editTicket, { token: seed.sessions[0], id: created._id, expectedVersion: current.version, title: `${name} externally`, description: "" });
    await page.getByRole("dialog").getByRole("heading", { name: `${created.projectKey}-${String(created.ticketNumber).padStart(4, "0")} · ${name} externally`, exact: true }).waitFor();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: copy("en", "versionConflict") }).waitFor();
    assert.equal((await convex.query(api.tickets.getTicket, { token: seed.sessions[0], id: created._id }))?.title, `${name} externally`);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: `Open ticket ${created.projectKey}-${String(created.ticketNumber).padStart(4, "0")}`, exact: true }).click();
    await page.getByRole("dialog").getByRole("heading", { name: `${created.projectKey}-${String(created.ticketNumber).padStart(4, "0")} · ${name} externally`, exact: true }).waitFor();
    assert.equal(await page.locator(role === "staff" ? "#edit-ticket-title" : "#customer-edit-title").count(), 0);
    assert.equal(await page.getByRole("alert").filter({ hasText: copy("en", "versionConflict") }).count(), 0);
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const role of ["staff", "customer"] as const) for (const language of ["en", "th"] as const) {
  test(`${role} ${language}: real Cancel preserves content and receipt after create; retry creates once; Discard releases previews`, async () => {
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>(resolve => { arrived = resolve; });
    let loseResponses = true;
    const requests: Array<{ requestId: string; title: string; description: string; annotations: unknown[] }> = [];
    const { context, page, title, token, errors, uploads } = await open(role, language, async context => {
      await context.routeWebSocket(/\/sync$/, socket => {
        const server = socket.connectToServer();
        const mutations = new Map<number, { udfPath: string; args: Array<{ files?: Array<{ name: string; size: number; type: string }> }> }>();
        socket.onMessage(raw => {
          const message = JSON.parse(String(raw));
          if (message.type === "Mutation") {
            mutations.set(message.requestId, message);
            if (message.udfPath === "tickets:createTicket") requests.push(message.args[0]);
          }
          server.send(raw);
        });
        let incoming = Promise.resolve();
        server.onMessage(raw => { incoming = incoming.then(async () => {
          const message = JSON.parse(String(raw));
          const mutation = mutations.get(message.requestId);
          if (message.type === "MutationResponse" && message.success && mutation?.udfPath === "uploads:createUploadIntent" && !message.result.ticketId) {
            // Fake provider receipts stay on the disposable backend; no upload API.
            const uploadedFiles = [];
            for (const file of mutation.args[0].files ?? []) {
              const recorded = { ...file, key: `browser-${crypto.randomUUID()}`, url: "https://fixture.invalid/draft.png" };
              await convex.mutation(api.uploads.recordUploadedFile, { callbackToken: "local-only-callback-fixture", intentId: message.result.intentId, secret: message.result.secret, file: recorded });
              uploadedFiles.push(recorded);
            }
            socket.send(JSON.stringify({ ...message, result: { ...message.result, uploadedFiles } }));
            return;
          }
          if (message.type === "MutationResponse" && mutation?.udfPath === "tickets:createTicket" && loseResponses) {
            const fail = () => socket.send(JSON.stringify({ type: "MutationResponse", requestId: message.requestId, success: false, result: "Fixture response lost", logLines: [] }));
            if (requests.length === 1) { release = fail; arrived(); }
            else fail();
            return;
          }
          socket.send(raw);
        }); });
      });
    });
    try {
      const name = `Cancel ${role} ${language} ${crypto.randomUUID()}`;
      await title.fill(name);
      const description = page.locator(role === "staff" ? "#description" : "#customer-ticket-description");
      await description.fill("Keep this description");
      if (role === "customer") await page.getByRole("button", { name: copy(language, "next"), exact: true }).click();
      await files(page);
      await page.getByRole("button", { name: copy(language, "openMedia", { name: "draft.png" }), exact: true }).click();
      await page.getByRole("button", { name: copy(language, "addPin"), exact: true }).click();
      await page.getByRole("dialog").last().locator("img").first().click({ position: { x: 30, y: 30 } });
      await page.getByPlaceholder(copy(language, "describeIssue")).fill("Keep this pin");
      await page.getByRole("button", { name: copy(language, "savePin"), exact: true }).click();
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).last().click();
      if (role === "customer") await page.getByRole("button", { name: copy(language, "next"), exact: true }).click();
      const submit = page.getByRole("button", { name: copy(language, role === "staff" ? "submit" : "submitTicket"), exact: true });
      await submit.click();
      await Promise.race([held, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Create response was not intercepted")), 8000))]);
      assert.equal(await page.getByRole("button", { name: copy(language, "discardDraft"), exact: true }).isDisabled(), true);
      if (role === "staff") {
        assert.equal(await title.isDisabled(), true);
        assert.equal(await description.isDisabled(), true);
        assert.equal(await page.locator('input[type="file"][multiple]').isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: copy(language, "openMedia", { name: "draft.png" }), exact: true }).isDisabled(), true);
      }
      await page.getByRole("button", { name: copy(language, "cancelUpload"), exact: true }).click();
      assert.equal((await stats(page)).revoked.length, 0);
      release();
      await submit.waitFor({ state: "visible" });
      loseResponses = false;
      if (role === "customer") {
        await page.getByRole("button", { name: copy(language, "back"), exact: true }).click();
      }
      await page.getByText(copy(language, "pinSummary", { count: 1 }), { exact: true }).waitFor();
      if (role === "customer") await page.getByRole("button", { name: copy(language, "back"), exact: true }).click();
      assert.equal(await title.inputValue(), name);
      assert.equal(await description.inputValue(), "Keep this description");
      if (role === "customer") {
        await page.getByRole("button", { name: copy(language, "next"), exact: true }).click();
        await page.getByRole("button", { name: copy(language, "next"), exact: true }).click();
      }
      await submit.click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[0], requests[1]);
      assert.deepEqual(requests[0], requests[2]);
      const matches = await convex.query(api.tickets.searchTickets, { token, projectId: seed.projects.find(p => p.key === "POS")!.id, search: name, lifecycle: "active" });
      assert.equal(matches.matches.filter(item => item.title === name).length, 1);
      assert.deepEqual((await stats(page)).revoked, (await stats(page)).created);
      // A separate Discard action is the only UI action here that drops content.
      await page.getByRole("button", { name: copy(language, "newTicket"), exact: true }).first().click();
      await title.fill("Discard this draft");
      if (role === "customer") await page.getByRole("button", { name: copy(language, "next"), exact: true }).click();
      await files(page);
      await page.getByRole("button", { name: copy(language, "discardDraft"), exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.deepEqual((await stats(page)).revoked, (await stats(page)).created);
      await page.getByRole("button", { name: copy(language, "newTicket"), exact: true }).first().click();
      assert.equal(await title.inputValue(), "");
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("losing captured Project access leaves the customer draft discardable", async () => {
  const { context, page, title } = await open("customer");
  const projectId = seed.projects.find(project => project.key === "POS")!.id;
  const members = await convex.query(api.projects.listProjectMembers, { token: seed.sessions[0], projectId });
  const customerId = members.find(member => member.email === "alice@local.test")!.customerId;
  try {
    await title.fill("Captured POS draft");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await convex.mutation(api.projects.removeProjectMember, { token: seed.sessions[0], projectId, customerId });
    await page.waitForFunction(() => !document.querySelector('select[aria-label="Choose Project"] option[value="POS"]'));
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    assert.equal(await title.inputValue(), "Captured POS draft");
    await page.getByRole("dialog").getByText("Point of Sale (POS)", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    await page.getByRole("dialog").getByText("Customer App (APP)", { exact: true }).waitFor();
    assert.equal(await title.inputValue(), "");
  } finally {
    await convex.mutation(api.projects.addProjectMember, { token: seed.sessions[0], projectId, email: "alice@local.test" });
    await context.close();
  }
});


for (const language of ["en", "th"] as const) {
  test(`staff ${language}: operations health shows safe configuration, counts and diagnostic views`, async () => {
    const f = await open("staff", language);
    try {
      await f.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await f.page.getByRole("button", { name: copy(language, "healthTitle"), exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      await dialog.getByText(copy(language, "healthStorage"), { exact: true }).waitFor();
      assert.equal(await dialog.getByRole("table", { name: copy(language, "healthCounts") }).count(), 1);
      for (const key of ["healthFailed", "healthPending", "healthExpired"] as const) {
        await dialog.getByRole("button", { name: copy(language, key), exact: true }).click();
        await dialog.getByText(copy(language, "healthPageHint"), { exact: true }).waitFor();
        assert.equal(await dialog.getByRole("button", { name: copy(language, key), exact: true }).getAttribute("aria-pressed"), "true");
      }
      assert.doesNotMatch(await dialog.innerText(), /local-only-callback-fixture|https?:|UPLOADTHING_TOKEN|UPLOAD_CALLBACK_SECRET/);
      assert.deepEqual(f.errors, []);
      assert.equal(f.uploads(), 0);
    } finally { await f.context.close(); }
  });
}

test("customer navigation does not expose staff health", async () => {
  const f = await open("customer");
  try {
    await f.page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    assert.equal(await f.page.getByRole("button", { name: copy("en", "healthTitle"), exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

for (const language of ["en", "th"] as const) {
  test(`staff ${language}: purge requeue requires confirmation and cancellation sends no mutation`, async () => {
    // Exercise the real health UI with a failed-job transport fixture; never schedule deletion.
    const f = await open("staff", language, async context => {
      await context.route("**/src/features/operations/adapters/health.ts", route => route.fulfill({
        contentType: "application/javascript",
        body: `window.healthRequeues = [];
          export const useHealth = () => ({ counts: {}, oldestPendingAt: null,
            configuration: { uploadThingToken: false, callbackSecret: true, mediaCleanupEnabled: false } });
          export const useJobDiagnostics = () => ({ status: "Exhausted", loadMore() {},
            results: [{ jobId: "fake-purge", kind: "ticket_purge", state: "failed", attempt: 0, maxAttempts: 8,
              availableAt: 1794614400000, lastOutcome: "ownership_conflict", purgeBlocked: true }],
            requeue: async args => { window.healthRequeues.push(args); return true; } });`,
      }));
    });
    try {
      await f.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await f.page.getByRole("button", { name: copy(language, "healthTitle"), exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      const requeue = dialog.getByRole("button", { name: copy(language, "healthRequeue"), exact: true });
      const prompts: string[] = [];
      f.page.once("dialog", async prompt => { prompts.push(prompt.message()); await prompt.dismiss(); });
      await requeue.click();
      const calls = () => f.page.evaluate(() => (window as unknown as { healthRequeues: unknown[] }).healthRequeues);
      assert.deepEqual(await calls(), []);
      f.page.once("dialog", async prompt => { prompts.push(prompt.message()); await prompt.accept(); });
      await requeue.click();
      await f.page.getByText(copy(language, "healthRequeued"), { exact: true }).waitFor();
      assert.deepEqual(await calls(), [{ token: f.token, jobId: "fake-purge" }]);
      assert.deepEqual(prompts, [copy(language, "healthPurgeConfirm"), copy(language, "healthPurgeConfirm")]);
      assert.deepEqual(f.errors, []);
      assert.equal(f.uploads(), 0);
    } finally { await f.context.close(); }
  });
}

test("staff sign-in uses the committed rate-limit action through the real form", async () => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await context.newPage();
    await page.goto(`${baseURL}/staff`);
    await page.locator("#staff-password").fill("wrong-password");
    await page.getByRole("button", { name: copy("en", "enter"), exact: true }).click();
    await page.getByRole("alert").waitFor();
    await page.locator("#staff-password").fill("LocalStaff123!");
    await page.getByRole("button", { name: copy("en", "enter"), exact: true }).click();
    await page.getByRole("button", { name: "New Ticket", exact: true }).waitFor();
    assert.equal(await page.locator("#staff-password").count(), 0);
  } finally { await context.close(); }
});

test("staff explorer keeps table and filters across indexed search, tag assignment and archive restore", async () => {
  const f = await open("staff");
  const name = `Explorer ${crypto.randomUUID()}`;
  const created = await convex.mutation(api.tickets.createTextTicket, {
    token: f.token, projectKey: "POS", title: name, description: "Integration fixture", requestId: crypto.randomUUID(),
  });
  const id = created.ticket._id;
  const tagName = `Tag ${crypto.randomUUID().slice(0, 8)}`;
  try {
    await f.page.getByRole("button", { name: "Close dialog", exact: true }).click();
    const search = f.page.getByPlaceholder(copy("en", "search"), { exact: true });
    await search.fill(name);
    await f.page.getByRole("button", { name: "Table", exact: true }).click();
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).click();
    const dialog = f.page.getByRole("dialog").last();
    await dialog.getByLabel(copy("en", "tagName"), { exact: true }).fill(tagName);
    await dialog.getByRole("button", { name: copy("en", "createTag"), exact: true }).click();
    const tag = dialog.getByRole("button", { name: `+ ${tagName}`, exact: true });
    await tag.click();
    await dialog.getByRole("button", { name: `✓ ${tagName}`, exact: true }).waitFor();
    const assigned = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.deepEqual(assigned?.tags.map(t => t.name), [tagName]);
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await f.page.getByRole("button", { name: "Add filter", exact: true }).click();
    await f.page.getByRole("option", { name: "Tags", exact: true }).click();
    await f.page.getByRole("option", { name: "is any of", exact: true }).click();
    await f.page.getByRole("option", { name: tagName, exact: true }).click();
    await f.page.keyboard.press("Escape");
    await search.fill("unmatchedfixturetext");
    await f.page.getByText("No Tickets match these filters.", { exact: true }).waitFor();
    assert.equal(await f.page.getByRole("button", { name: "Table", exact: true }).getAttribute("aria-pressed"), "true");
    await search.fill(name);
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).waitFor();
    await convex.mutation(api.tickets.archiveTicket, { token: f.token, id, expectedVersion: assigned!.version });
    await f.page.getByRole("button", { name: copy("en", "archive"), exact: true }).click();
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).click();
    const archived = f.page.getByRole("dialog").last();
    assert.equal(await archived.getByRole("button", { name: copy("en", "edit"), exact: true }).count(), 0);
    await archived.getByRole("button", { name: "Restore", exact: true }).click();
    await archived.waitFor({ state: "hidden" });
    const restored = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.equal(restored?.lifecycle, "active");
    assert.deepEqual(restored?.tagIds, assigned?.tagIds);
    assert.deepEqual(f.errors, []);
    assert.equal(f.uploads(), 0);
  } finally { await f.context.close(); }
});
