import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { submitTicketDraft } from "../src/lib/ticket-submit";
import { ConvexError } from "convex/values";
import { UploadThingError } from "uploadthing/server";

test("a ticket without media keeps idempotency but skips UploadThing", async () => {
  const intentId = "intent-without-media" as Id<"uploadIntents">;
  let uploadCalled = false;
  let intentFiles: Array<{ name: string; size: number; type: string }> | undefined;
  let createdMediaLength = -1;

  await submitTicketDraft(
    {
      token: "session-token",
      createUploadIntent: async (args) => {
        intentFiles = args.files;
        return { intentId, secret: "s".repeat(48), uploadedFiles: [] };
      },
      uploadMedia: async () => {
        uploadCalled = true;
        return [];
      },
      createTicket: async (args) => {
        createdMediaLength = args.media.length;
        assert.equal(args.uploadIntentId, intentId);
        assert.equal(args.uploadIntentSecret, "s".repeat(48));
        assert.equal(args.requestId, "draft-idempotency-key");
      },
    },
    {
      title: "Receipt is blank",
      description: "",
      items: [],
      annotations: [],
      idempotencyKey: "draft-idempotency-key",
    },
  );

  assert.deepEqual(intentFiles, []);
  assert.equal(uploadCalled, false);
  assert.equal(createdMediaLength, 0);
});

test("an attached intent still validates the original create request through its receipt", async () => {
  let checked = false;
  let uploaded = false;
  await assert.rejects(submitTicketDraft({
    token: "session-token",
    createUploadIntent: async () => ({ intentId: "attached-intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [], ticketId: "existing-ticket" as Id<"tickets"> }),
    uploadMedia: async () => { uploaded = true; return []; },
    createTicket: async args => {
      checked = true;
      assert.equal(args.requestId, "original-request-id");
      assert.equal(args.title, "Changed draft");
      throw new ConvexError({ code: "REQUEST_ID_CONFLICT" });
    },
  }, { title: "Changed draft", description: "", items: [], annotations: [], idempotencyKey: "original-request-id" }), /REQUEST_ID_CONFLICT/);
  assert.equal(checked, true);
  assert.equal(uploaded, false);
});

test("browser resumes recorded media after re-login without uploading it again", async () => {
  const file = new File(["image"], "fixture.png", { type: "image/png" });
  const media = { key: "trusted-key", name: file.name, size: file.size, type: file.type, url: "https://fixture.invalid/image.png" };
  let creates = 0;
  await submitTicketDraft({
    token: "fresh-session",
    createUploadIntent: async () => ({ intentId: "durable-intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [media] }),
    uploadMedia: async () => { throw new Error("Must not upload recorded media again"); },
    createTicket: async args => { creates++; assert.deepEqual(args.media, [media]); },
  }, { title: "Ticket", description: "", items: [{ id: "pending", file, previewUrl: "blob:fake", isVideo: false }], annotations: [], idempotencyKey: "original-request-id" });
  assert.equal(creates, 1);
});

test("browser reconciles a lost create response with identical input and never cancels an unknown outcome", async () => {
  const originalFetch = globalThis.fetch;
  let cancellations = 0;
  globalThis.fetch = async () => { cancellations++; throw new Error("Must not cancel"); };
  try {
    for (const unresolved of [false, true]) {
      const calls: unknown[] = [];
      const submit = submitTicketDraft({
        token: "session",
        createUploadIntent: async () => ({ intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [] }),
        createTicket: async args => {
          calls.push(args);
          if (unresolved || calls.length === 1) throw new Error("Response lost");
        },
      }, { title: "Ticket", description: "", items: [], annotations: [], idempotencyKey: "original-request-id" });
      if (unresolved) await assert.rejects(submit, /UPLOAD_WRITE_UNKNOWN/);
      else await submit;
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
    }
    assert.equal(cancellations, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("definitive browser rejection queues guarded cleanup and a request conflict resets the draft key", async () => {
  const originalFetch = globalThis.fetch;
  let cancellations = 0;
  let conflicts = 0;
  globalThis.fetch = async (_input, init) => {
    cancellations++;
    assert.deepEqual(JSON.parse(String(init?.body)), { intentId: "intent", secret: "secret" });
    return Response.json({ ok: true, state: "queued", jobIds: ["job"] });
  };
  try {
    await assert.rejects(submitTicketDraft({
      token: "session",
      createUploadIntent: async () => ({ intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [] }),
      createTicket: async () => { throw new ConvexError({ code: "REQUEST_ID_CONFLICT" }); },
      onRequestConflict: () => { conflicts++; },
    }, { title: "Ticket", description: "", items: [], annotations: [], idempotencyKey: "original-request-id" }), /REQUEST_ID_CONFLICT/);
    assert.equal(conflicts, 1);
    assert.equal(cancellations, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("UploadThing errors with code-like messages never authorize browser cancellation", async () => {
  const originalFetch = globalThis.fetch;
  let cancellations = 0;
  globalThis.fetch = async () => { cancellations++; throw new Error("Must not cancel"); };
  const error = new UploadThingError({ code: "UPLOAD_FAILED", message: "UPLOAD_RECORDING_UNKNOWN" });
  const file = new File(["image"], "fixture.png", { type: "image/png" });
  try {
    await assert.rejects(submitTicketDraft({
      token: "session",
      createUploadIntent: async () => ({ intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [] }),
      uploadMedia: async () => { throw error; },
      createTicket: async () => { assert.fail("Upload failed"); },
    }, { title: "Ticket", description: "", items: [{ id: "pending", file, previewUrl: "blob:fake", isVideo: false }], annotations: [], idempotencyKey: "original-request-id" }), value => value === error);
    assert.equal(cancellations, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("a rejected reconciliation after response loss still never authorizes browser cleanup", async () => {
  const originalFetch = globalThis.fetch;
  let cancellations = 0;
  let attempts = 0;
  globalThis.fetch = async () => { cancellations++; throw new Error("Must not cancel"); };
  try {
    await assert.rejects(submitTicketDraft({
      token: "session",
      createUploadIntent: async () => ({ intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [] }),
      createTicket: async () => { throw new Error(++attempts === 1 ? "Response lost" : "SESSION_EXPIRED"); },
    }, { title: "Ticket", description: "", items: [], annotations: [], idempotencyKey: "original-request-id" }), /UPLOAD_WRITE_UNKNOWN/);
    assert.equal(attempts, 2);
    assert.equal(cancellations, 0);
  } finally { globalThis.fetch = originalFetch; }
});


test("aborting an upload cancels its guarded intent and renews the draft key", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let cancellations = 0;
  let renewals = 0;
  globalThis.fetch = async (_url, init) => {
    cancellations++;
    assert.deepEqual(JSON.parse(String(init?.body)), { intentId: "intent", secret: "secret" });
    return Response.json({ ok: true, state: "completed", jobIds: [] });
  };
  try {
    const file = new File(["image"], "fixture.png", { type: "image/png" });
    await assert.rejects(submitTicketDraft({
      token: "session", signal: controller.signal,
      createUploadIntent: async () => ({ intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [] }),
      uploadMedia: async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); },
      createTicket: async () => { assert.fail("Cancelled upload must not create a Ticket"); },
      onRequestConflict: () => { renewals++; },
    }, { title: "Ticket", description: "", items: [{ id: "pending", file, previewUrl: "blob:fake", isVideo: false }], annotations: [], idempotencyKey: "original-request-id" }), { name: "AbortError" });
    assert.equal(cancellations, 1);
    assert.equal(renewals, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("abort during an unknown create never cancels the intent or renews the receipt key", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  let renewed = 0;
  globalThis.fetch = async () => { cancelled++; throw new Error("Must not cancel"); };
  const controller = new AbortController();
  try {
    await assert.rejects(submitTicketDraft({
      token: "token", signal: controller.signal, onRequestConflict: () => { renewed++; },
      createUploadIntent: async () => ({ intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [] }),
      createTicket: async () => { controller.abort(); throw new Error("response lost"); },
    }, { title: "Ticket", description: "", items: [], annotations: [], idempotencyKey: "keep-key" }), /UPLOAD_WRITE_UNKNOWN/);
    assert.equal(cancelled, 0);
    assert.equal(renewed, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("abort with an unknown guarded cancellation retains the draft key", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let renewed = 0;
  globalThis.fetch = async () => { throw new Error("Cancel response lost"); };
  try {
    await assert.rejects(submitTicketDraft({
      token: "token", signal: controller.signal, onRequestConflict: () => { renewed++; },
      createUploadIntent: async () => { controller.abort(); return { intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [] }; },
      createTicket: async () => { assert.fail("Cancelled before create"); },
    }, { title: "Ticket", description: "", items: [], annotations: [], idempotencyKey: "keep-key" }), { name: "AbortError" });
    assert.equal(renewed, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("aborting a reconciliation before create preserves the earlier uncertain receipt", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let cancellations = 0;
  let renewals = 0;
  globalThis.fetch = async () => { cancellations++; throw new Error("Must keep the original intent"); };
  try {
    await assert.rejects(submitTicketDraft({
      token: "session",
      reconciling: true,
      signal: controller.signal,
      onRequestConflict: () => { renewals++; },
      createUploadIntent: async () => {
        controller.abort();
        return { intentId: "intent" as Id<"uploadIntents">, secret: "secret", uploadedFiles: [] };
      },
      createTicket: async () => { assert.fail("Cancelled before create"); },
    }, { title: "Ticket", description: "", items: [], annotations: [], idempotencyKey: "original-request-id" }), { name: "AbortError" });
    assert.equal(cancellations, 0);
    assert.equal(renewals, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("an authorization failure during receipt reconciliation preserves the request key", async () => {
  let renewals = 0;
  await assert.rejects(submitTicketDraft({
    token: "expired-session",
    reconciling: true,
    onRequestConflict: () => { renewals++; },
    createUploadIntent: async () => { throw new ConvexError({ code: "SESSION_EXPIRED" }); },
    createTicket: async () => { assert.fail("Authorization failed before create"); },
  }, { title: "Ticket", description: "", items: [], annotations: [], idempotencyKey: "original-request-id" }), /SESSION_EXPIRED/);
  assert.equal(renewals, 0);
});

test("a definitive reply rejection after response loss unlocks the same draft", async () => {
  const draft = { title: "", description: "Test reply", items: [], annotations: [], idempotencyKey: "test-reply-key" };
  let renewals = 0;
  let calls = 0;
  const deps = {
    token: "session",
    mediaEnabled: false,
    noReceiptErrors: new Set(["PAGE_UNAVAILABLE"]),
    onRequestConflict: () => { renewals++; },
    createUploadIntent: async () => assert.fail("Text reply cannot create an upload"),
    createTicket: async () => {
      if (++calls <= 2) throw new Error("Response lost");
      throw new ConvexError({ code: "PAGE_UNAVAILABLE" });
    },
  };
  await assert.rejects(submitTicketDraft(deps, draft), /UPLOAD_WRITE_UNKNOWN/);
  assert.equal(renewals, 0);
  await assert.rejects(submitTicketDraft({ ...deps, reconciling: true }, draft), /PAGE_UNAVAILABLE/);
  assert.equal(renewals, 1);
});
