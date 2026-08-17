import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { submitFeedbackDraft } from "../src/lib/feedback-submit";

test("a ticket without media keeps idempotency but skips UploadThing", async () => {
  const intentId = "intent-without-media" as Id<"uploadIntents">;
  let uploadCalled = false;
  let intentFiles: Array<{ name: string; size: number; type: string }> | undefined;
  let createdMediaLength = -1;

  await submitFeedbackDraft(
    {
      token: "session-token",
      createUploadIntent: async (args) => {
        intentFiles = args.files;
        return { intentId, secret: "s".repeat(48) };
      },
      uploadMedia: async () => {
        uploadCalled = true;
        return [];
      },
      createFeedback: async (args) => {
        createdMediaLength = args.media.length;
        assert.equal(args.uploadIntentId, intentId);
        assert.equal(args.uploadIntentSecret, "s".repeat(48));
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
