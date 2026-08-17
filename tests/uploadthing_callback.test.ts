import assert from "node:assert/strict";
import test from "node:test";
import { resolveUploadThingCallbackUrl } from "../server/uploadthing-callback";

test("protected Vercel previews add the automation bypass only to the callback", () => {
  assert.equal(
    resolveUploadThingCallbackUrl({
      VERCEL_URL: "track-ease-preview.vercel.app",
      VERCEL_AUTOMATION_BYPASS_SECRET: "preview-secret",
    }),
    "https://track-ease-preview.vercel.app/api/uploadthing?x-vercel-protection-bypass=preview-secret",
  );
});

test("public deployments keep UploadThing automatic callback URL detection", () => {
  assert.equal(resolveUploadThingCallbackUrl({ VERCEL_URL: "track-ease.vercel.app" }), undefined);
});

test("an explicit callback URL remains available for non-Vercel hosts", () => {
  assert.equal(
    resolveUploadThingCallbackUrl({ UPLOADTHING_CALLBACK_URL: "https://feedback.example.com/api/uploadthing" }),
    "https://feedback.example.com/api/uploadthing",
  );
});
