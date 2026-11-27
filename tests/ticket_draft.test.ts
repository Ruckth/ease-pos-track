import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import type { Id } from "../convex/_generated/dataModel";
import { DisposableTicketDraft } from "../src/features/tickets/draft";

function fixture() {
  const revoked: string[] = [];
  let sequence = 0;
  const draft = new DisposableTicketDraft("original-project" as Id<"projects">, {
    createURL: file => `blob:${file.name}`, revokeURL: url => revoked.push(url), requestKey: () => `key-${sequence++}`, now: () => 42,
  });
  const file = new File(["fake image"], "fixture.png", { type: "image/png" });
  draft.setTitle("Ticket");
  draft.addFiles([file]);
  const media = { key: "fake-key", url: "https://fixture.invalid/image", name: file.name, size: file.size, type: file.type };
  const deps = { token: "token", createUploadIntent: async () => ({ intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [media] }), createTicket: async () => {} };
  return { draft, revoked, file, deps };
}

test("removing media drops its pending annotations and revokes only its own preview once", async () => {
  const { draft, revoked } = fixture();
  const item = draft.getSnapshot().items[0];
  await draft.addAnnotation({ mediaIndex: 0, kind: "point", x: 0.25, y: 0.75, text: " Note " });
  assert.equal(draft.getSnapshot().annotations[0].createdAt, 42);
  draft.remove(item);
  draft.remove(item);
  assert.deepEqual(draft.getSnapshot().annotations, []);
  draft.dispose();
  draft.dispose();
  assert.deepEqual(revoked, [item.previewUrl]);
});

for (const ending of ["dispose", "success"] as const) test(`${ending} releases preview and abort exactly once, including later unmount`, async () => {
  const { draft, revoked, deps } = fixture();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const originalAbort = AbortController.prototype.abort;
  let aborts = 0;
  AbortController.prototype.abort = function () { aborts++; originalAbort.call(this); };
  try {
    const submission = draft.submit({ ...deps, createTicket: async () => { started(); await held; } });
    await ready;
    if (ending !== "success") draft[ending]();
    release();
    assert.equal(await submission, ending === "success");
    draft.dispose();
    assert.equal(aborts, 1);
    assert.deepEqual(revoked, ["blob:fixture.png"]);
  } finally { AbortController.prototype.abort = originalAbort; }
});

test("Cancel after create starts keeps all draft content and the request key for an unknown outcome", async () => {
  const { draft, revoked, deps } = fixture();
  draft.setDescription("Keep this description");
  await draft.addAnnotation({ mediaIndex: 0, kind: "point", x: 0.25, y: 0.75, text: "Keep this pin" });
  const before = draft.getSnapshot();
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const submission = draft.submit({ ...deps, createTicket: async () => { started(); await held; throw new Error("Response lost"); } });
  await ready;
  draft.cancel();
  assert.equal(draft.getSnapshot().title, before.title);
  assert.equal(draft.getSnapshot().description, before.description);
  assert.deepEqual(draft.getSnapshot().items, before.items);
  assert.deepEqual(draft.getSnapshot().annotations, before.annotations);
  assert.equal(draft.getSnapshot().idempotencyKey, before.idempotencyKey);
  assert.deepEqual(revoked, []);
  release();
  assert.equal(await submission, false);
  assert.equal(draft.getSnapshot().progress, null);
  assert.equal(draft.getSnapshot().idempotencyKey, before.idempotencyKey);
  draft.dispose();
  assert.deepEqual(revoked, ["blob:fixture.png"]);
});

test("busy drafts reject input and a Cancel remains retryable even when the held create later succeeds", async () => {
  const { draft, deps, revoked, file } = fixture();
  const before = draft.getSnapshot();
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = draft.submit({ ...deps, createTicket: async () => { started(); await held; } });
  await ready;
  draft.setTitle("Dropped title");
  draft.setDescription("Dropped description");
  draft.addFiles([file]);
  draft.remove(before.items[0]);
  assert.equal(await draft.addAnnotation({ mediaIndex: 0, kind: "point", x: 0.2, y: 0.4, text: "Dropped pin" }), false);
  draft.cancel();
  release();
  assert.equal(await pending, false);
  const after = draft.getSnapshot();
  for (const key of ["title", "description", "items", "annotations", "idempotencyKey"] as const) assert.deepEqual(after[key], before[key]);
  assert.equal(after.progress, null);
  assert.deepEqual(revoked, []);
  assert.equal(await draft.submit(deps), true);
  assert.deepEqual(revoked, ["blob:fixture.png"]);
  draft.dispose();
});

test("Project identity and request key survive unknown outcome; retry returns the original creation", async () => {
  const { draft, deps } = fixture();
  const key = draft.getSnapshot().idempotencyKey;
  const calls: unknown[] = [];
  let unknown = true;
  const createTicket = async (input: Parameters<Parameters<typeof draft.submit>[0]["createTicket"]>[0]) => {
    calls.push(input);
    assert.equal(input.projectId, "original-project");
    if (unknown) throw new Error("response lost after commit");
  };
  assert.equal(await draft.submit({ ...deps, createTicket }), false);
  assert.equal(draft.getSnapshot().idempotencyKey, key);
  assert.equal(draft.getSnapshot().items.length, 1);
  unknown = false;
  assert.equal(await draft.submit({ ...deps, createTicket }), true);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], calls[2]);
});

test("a definitive request conflict renews the draft key for the next explicit submit", async () => {
  const { draft, deps } = fixture();
  const key = draft.getSnapshot().idempotencyKey;
  assert.equal(await draft.submit({ ...deps, createUploadIntent: async () => { throw new ConvexError({ code: "UPLOAD_REQUEST_CONFLICT" }); } }), false);
  assert.notEqual(draft.getSnapshot().idempotencyKey, key);
  draft.dispose();
});

test("cancelAndSettle waits for guarded cleanup before releasing the session", async () => {
  const { draft, deps } = fixture();
  let release!: () => void;
  let cancelStarted!: () => void;
  const cleanupStarted = new Promise<void>(resolve => { cancelStarted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    cancelStarted();
    await held;
    return Response.json({ ok: true, state: "queued", jobIds: [] });
  };
  try {
    const submit = draft.submit(deps);
    let settled = false;
    const cancellation = draft.cancelAndSettle().then(() => { settled = true; });
    await cleanupStarted;
    assert.equal(settled, false);
    release();
    await cancellation;
    assert.equal(await submit, false);
    assert.equal(draft.getSnapshot().progress, null);
  } finally {
    release();
    globalThis.fetch = originalFetch;
    draft.dispose();
  }
});

test("a reconciled successful create exposes its Ticket for selection after the composer closes", async () => {
  const { draft, deps } = fixture();
  const id = "created-ticket" as Id<"tickets">;
  let calls = 0;
  assert.equal(await draft.submit({ ...deps, createTicket: async () => {
    if (++calls === 1) throw new Error("response lost after create");
    return id;
  } }), true);
  assert.equal(calls, 2);
  assert.equal(draft.lastSubmittedId, id);
  assert.equal(draft.getSnapshot().title, "");
  draft.dispose();
});

test("text-only composer refuses a retained file and submits plain text without upload transport", async () => {
  const { draft, deps } = fixture();
  const classification = { product: "printer", symptom: "blank", restricted: true };
  draft.setRoutingClassification(classification);
  let intentCalls = 0;
  let submitCalls = 0;
  const textOnly = {
    ...deps,
    mediaEnabled: false,
    createUploadIntent: async () => { intentCalls++; throw new Error("unexpected upload intent"); },
    createTicket: async (args: Parameters<Parameters<typeof draft.submit>[0]["createTicket"]>[0]) => {
      submitCalls++;
      assert.deepEqual(args, {
        requestId: "key-0", title: "Ticket", description: "",
        media: [], annotations: [], routingClassification: classification, projectId: "original-project",
      });
      return "new-text-id";
    },
  };
  assert.equal(await draft.submit(textOnly), false);
  assert.match(String(draft.getSnapshot().error), /PILOT_MEDIA_DISABLED/);
  assert.equal(submitCalls, 0);
  draft.remove(draft.getSnapshot().items[0]);
  assert.equal(await draft.submit(textOnly), true);
  assert.equal(draft.lastSubmittedId, "new-text-id");
  assert.equal(submitCalls, 1);
  assert.equal(intentCalls, 0);
});

/** A draft holding one image and one video, with an injected image preparation. */
function preparedFixture(prepareImage: (file: File) => Promise<File>) {
  let sequence = 0;
  const draft = new DisposableTicketDraft("original-project" as Id<"projects">, {
    prepareImage, createURL: file => `blob:${file.name}`, revokeURL: () => {}, requestKey: () => `key-${sequence++}`, now: () => 42,
  });
  const image = new File(["original image bytes"], "photo.jpg", { type: "image/jpeg" });
  const video = new File(["fake video"], "clip.mp4", { type: "video/mp4" });
  draft.setTitle("Ticket");
  draft.addFiles([image, video]);
  const declared: Array<Array<{ name: string; size: number; type: string }>> = [];
  const deps = {
    token: "token",
    createUploadIntent: async (args: { files: Array<{ name: string; size: number; type: string }> }) => {
      declared.push(args.files);
      return { intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: args.files.map((file, index) => ({ ...file, key: `key-${index}`, url: `https://fixture.invalid/${index}` })) };
    },
    createTicket: async () => {},
  };
  return { draft, image, video, declared, deps };
}

test("submission uploads prepared images, never videos, and keeps the originals for previews and retries", async () => {
  const prepared = new File(["webp"], "photo.webp", { type: "image/webp" });
  const calls: File[] = [];
  const { draft, image, video, declared, deps } = preparedFixture(async file => { calls.push(file); return prepared; });
  assert.equal(await draft.submit(deps), true);
  assert.deepEqual(calls, [image]);
  assert.deepEqual(declared, [[{ name: "photo.webp", size: 4, type: "image/webp" }, { name: video.name, size: video.size, type: video.type }]]);
});

test("a failed or oversized preparation leaves the draft intact with its error, and a retry prepares again", async () => {
  let outcome: "invalid" | "large" | "ok" = "invalid";
  const { draft, image, declared, deps } = preparedFixture(async () => {
    if (outcome === "invalid") throw new Error("IMAGE_ANIMATION_UNSUPPORTED");
    if (outcome === "large") return new File([new Uint8Array(8 * 1024 * 1024 + 1)], "photo.png", { type: "image/png" });
    return new File(["ok"], "photo.webp", { type: "image/webp" });
  });
  const before = draft.getSnapshot();
  assert.equal(await draft.submit(deps), false);
  assert.equal((draft.getSnapshot().error as Error).message, "IMAGE_ANIMATION_UNSUPPORTED");
  outcome = "large";
  assert.equal(await draft.submit(deps), false);
  assert.equal((draft.getSnapshot().error as Error).message, "IMAGE_TOO_LARGE");
  const after = draft.getSnapshot();
  assert.deepEqual([after.items, after.idempotencyKey, after.progress], [before.items, before.idempotencyKey, null]);
  assert.equal(after.items[0].file, image, "the original stays selected");
  assert.equal(declared.length, 0, "nothing is declared or uploaded before every image is prepared");
  outcome = "ok";
  assert.equal(await draft.submit(deps), true);
  assert.equal(declared[0][0].name, "photo.webp");
});
