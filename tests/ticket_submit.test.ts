import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { submitTicketDraft } from "../src/lib/ticket-submit";

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
      throw new Error("REQUEST_ID_CONFLICT");
    },
  }, { title: "Changed draft", description: "", items: [], annotations: [], idempotencyKey: "original-request-id" }), /REQUEST_ID_CONFLICT/);
  assert.equal(checked, true);
  assert.equal(uploaded, false);
});
