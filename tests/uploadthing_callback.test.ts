import assert from "node:assert/strict";
import test from "node:test";
import { resolveUploadThingCallbackUrl, resolveUploadThingConfig } from "../server/uploadthing-callback";

test("local HTTP uploads enable dev callbacks on the listening port without environment overrides", () => {
  for (const port of [8787, 4012]) {
    assert.deepEqual(resolveUploadThingConfig({}, port), {
      isDev: true, callbackUrl: `http://localhost:${port}/api/uploadthing`,
    });
  }
});

test("production and Vercel always use real callbacks even with inherited dev overrides", () => {
  const environments = [
    { env: { NODE_ENV: "production" }, port: 4012 },
    { env: { NODE_ENV: "development", VERCEL: "1" }, port: 4012 },
    { env: { VERCEL_URL: "preview.vercel.app" }, port: 4012 },
    { env: { NODE_ENV: "development" }, port: undefined },
  ];
  for (const { env, port } of environments) {
    const config = resolveUploadThingConfig({ ...env, UPLOADTHING_IS_DEV: "true" }, port);
    assert.equal(config.isDev, false);
    assert.equal(config.callbackUrl, undefined);
  }
});

test("hosted real callbacks preserve explicit URLs and protected preview bypass", () => {
  assert.deepEqual(resolveUploadThingConfig({ UPLOADTHING_CALLBACK_URL: "https://ticket.example.com/api/uploadthing" }), {
    isDev: false, callbackUrl: "https://ticket.example.com/api/uploadthing",
  });
  assert.deepEqual(resolveUploadThingConfig({ VERCEL_URL: "preview.vercel.app", VERCEL_AUTOMATION_BYPASS_SECRET: "preview-secret" }), {
    isDev: false, callbackUrl: "https://preview.vercel.app/api/uploadthing?x-vercel-protection-bypass=preview-secret",
  });
});

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
    resolveUploadThingCallbackUrl({ UPLOADTHING_CALLBACK_URL: "https://ticket.example.com/api/uploadthing" }),
    "https://ticket.example.com/api/uploadthing",
  );
});
