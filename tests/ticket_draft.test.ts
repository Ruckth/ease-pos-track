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

test("an applied crop updates only its image and reprojects that image's pin after reorder", async () => {
  const { draft, revoked } = fixture();
  const original = draft.getSnapshot().items[0];
  draft.addFiles([new File(["other"], "other.png", { type: "image/png" })]);
  const other = draft.getSnapshot().items[1];
  await draft.addAnnotation({ mediaIndex: 0, kind: "point", x: 0.25, y: 0.75, text: "Expected change" });
  await draft.addAnnotation({ mediaIndex: 1, kind: "point", x: 0.25, y: 0.75, text: "Other image" });
  draft.setDescription("See [2]");
  draft.reorder([other, original]);

  const before = draft.getSnapshot();
  const edited = new File(["reviewed bytes"], "customer-name.png", { type: "image/png" });
  assert.equal(draft.applyImageEdit(original, edited, { x: 0.3, y: 0, width: 0.5, height: 1 }), false);
  assert.equal(draft.applyImageEdit(original, edited, { x: NaN, y: 0, width: 0.5, height: 1 }), false);
  assert.equal(draft.getSnapshot(), before);
  assert.deepEqual(revoked, []);

  const crop = { x: 0, y: 0.5, width: 0.5, height: 0.5 };
  assert.equal(draft.applyImageEdit(original, edited, crop), true);
  const applied = draft.getSnapshot();
  const replacement = applied.items[1];
  assert.equal(applied.items[0], other);
  assert.equal(replacement.id, original.id);
  assert.match(replacement.file.name, /^image-key-\d+\.png$/);
  assert.equal(await replacement.file.text(), "reviewed bytes");
  assert.deepEqual(applied.annotations, [{ ...before.annotations[0], x: 0.5, y: 0.5 }, before.annotations[1]]);
  assert.equal(applied.description, "See [2]");
  assert.deepEqual(revoked, [original.previewUrl]);
  assert.equal(draft.applyImageEdit(original, edited, crop), false);
  draft.remove(replacement);
  assert.equal(draft.applyImageEdit(replacement, edited, crop), false);
  assert.deepEqual(revoked, [original.previewUrl, replacement.previewUrl]);
  draft.dispose();
});

test("an uncertain partial upload retries frozen files, annotations and cover order", async () => {
  let preparations = 0;
  const draft = new DisposableTicketDraft("original-project" as Id<"projects">, {
    prepareImage: async file => { preparations++; return file; },
    createURL: file => `blob:${file.name}`, revokeURL: () => {},
    requestKey: (() => { let next = 0; return () => `key-${next++}`; })(),
    now: () => 42,
  });
  const image = (text: string) => new File([text], "same.png", { type: "image/png" });
  draft.addFiles([image("old"), image("A"), image("B")]);
  const original = draft.getSnapshot().items[0];
  const crop = { x: 0, y: 0, width: 1, height: 1 };
  assert.equal(draft.applyImageEdit(original, image("reviewed"), crop), true);
  await draft.addAnnotation({ mediaIndex: 0, kind: "point", x: 0.25, y: 0.75, text: "Original pin" });
  draft.setTitle("Original title");
  draft.setDescription("Original description [1]");
  const before = draft.getSnapshot();
  const stored = new Map<string, string>();
  const receipts: Awaited<ReturnType<NonNullable<Parameters<typeof draft.submit>[0]["uploadMedia"]>>> = [];
  const declarations: unknown[] = [];
  const deps: Parameters<typeof draft.submit>[0] = {
    token: "token",
    createUploadIntent: async args => {
      declarations.push(args);
      return {
        intentId: "intent" as Id<"uploadIntents">, secret: "secret",
        uploadedFiles: receipts.map(file => ({ ...file, url: file.ufsUrl })),
      };
    },
    uploadMedia: async (_route, { files }) => {
      const firstUpload = receipts.length === 0;
      if (firstUpload) {
        assert.deepEqual(await Promise.all(files.map(file => file.text())), ["reviewed", "A", "B"]);
        assert.equal(files[0], before.items[0].file);
        assert.notEqual(files[1].name, files[2].name);
      } else {
        assert.deepEqual(await Promise.all(files.map(file => file.text())), ["reviewed", "A"]);
      }
      const uploaded = await Promise.all((firstUpload ? [files[2]] : files).map(async file => {
        const key = file.name;
        stored.set(key, await file.text());
        return { key, name: file.name, size: file.size, type: file.type, ufsUrl: `https://fixture.invalid/${key}`, url: `https://fixture.invalid/${key}`, appUrl: `https://fixture.invalid/${key}`, customId: null, fileHash: key, serverData: null };
      }));
      receipts.push(...uploaded);
      if (firstUpload) throw new Error("Upload response lost");
      return uploaded;
    },
    createTicket: async args => {
      assert.equal(args.requestId, before.idempotencyKey);
      assert.equal(args.title, before.title);
      assert.equal(args.description, before.description);
      assert.deepEqual(args.media.map(file => stored.get(file.key)), ["reviewed", "A", "B"]);
      assert.deepEqual(args.annotations.map(({ mediaIndex, text }) => [mediaIndex, text]), [[0, "Original pin"]]);
      return "recorded-ticket";
    },
  };

  assert.equal(await draft.submit(deps), false);
  assert.equal(draft.getSnapshot().retryLocked, true);
  draft.setTitle("Changed title");
  draft.setDescription("Changed description");
  draft.remove(before.items[1]);
  draft.reorder([...before.items].reverse());
  draft.addFiles([image("C")]);
  await draft.updateAnnotation({ annotationId: before.annotations[0].id, text: "Changed pin" });
  await draft.deleteAnnotation(before.annotations[0].id);
  assert.equal(draft.applyImageEdit(before.items[0], image("stale edit"), crop), false);
  assert.equal(await draft.submit(deps), true);
  assert.equal(draft.getSnapshot().retryLocked, false);
  assert.equal(preparations, 2);
  assert.equal(declarations.length, 2);
  assert.deepEqual(declarations[0], declarations[1]);
  assert.equal(draft.lastSubmittedId, "recorded-ticket");
});

for (const mediaEnabled of [true, false]) {
  test(`retired classification unlocks an uncertain ${mediaEnabled ? "media" : "text-only"} draft after receipt lookup`, async () => {
    const { draft, deps } = fixture();
    if (!mediaEnabled) draft.remove(draft.getSnapshot().items[0]);
    draft.setRoutingClassification({ product: "retired", restricted: false });
    const requestKey = draft.getSnapshot().idempotencyKey;
    let cancellations = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      cancellations++;
      return Response.json({ ok: true, state: "queued", jobIds: [] });
    };
    let failure: unknown = new Error("Response lost");
    const submit = {
      ...deps,
      mediaEnabled,
      createTicket: async () => { if (failure) throw failure; return "created-ticket"; },
    };
    try {
      assert.equal(await draft.submit(submit), false);
      assert.equal(draft.getSnapshot().retryLocked, true);
      failure = new ConvexError({ code: "PROJECT_NOT_FOUND" });
      assert.equal(await draft.submit(submit), false);
      assert.equal(draft.getSnapshot().retryLocked, true);
      assert.equal(draft.getSnapshot().idempotencyKey, requestKey);
      assert.equal(cancellations, 0);

      failure = new ConvexError({ code: "UNKNOWN_ROUTING_CODE" });
      assert.equal(await draft.submit(submit), false);
      assert.equal(draft.getSnapshot().retryLocked, false);
      assert.notEqual(draft.getSnapshot().idempotencyKey, requestKey);
      assert.equal(cancellations, mediaEnabled ? 1 : 0);

      draft.setRoutingClassification(undefined);
      assert.equal(draft.getSnapshot().routingClassification, undefined);
      failure = undefined;
      assert.equal(await draft.submit(submit), true);
      assert.equal(draft.lastSubmittedId, "created-ticket");
    } finally {
      globalThis.fetch = originalFetch;
      draft.dispose();
    }
  });
}

test("invalid prepared upload metadata leaves the draft editable before any intent write", async () => {
  const { draft, deps } = fixture();
  const invalid = new File(["fake image"], `${"a".repeat(256)}.png`, { type: "image/png" });
  draft.addFiles([invalid]);
  const before = draft.getSnapshot();
  let intentCalls = 0;
  const submit = {
    ...deps,
    createUploadIntent: async () => {
      intentCalls++;
      throw new Error("Intent response lost");
    },
  };

  assert.equal(await draft.submit(submit), false);
  assert.match(String(draft.getSnapshot().error), /INVALID_FILE_METADATA/);
  assert.equal(intentCalls, 0);
  assert.equal(draft.getSnapshot().idempotencyKey, before.idempotencyKey);
  assert.equal(draft.getSnapshot().retryLocked, false);
  draft.remove(before.items[1]);
  assert.equal(await draft.submit(deps), true);
});
