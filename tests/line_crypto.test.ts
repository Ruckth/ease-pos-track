import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { openLineSecret, sealLineSecret, verifyLineSignature } from "../convex/line_crypto";

test("LINE signature covers the exact request bytes", async () => {
  const body = '{"events":[]}';
  const signature = createHmac("sha256", "fixture-secret").update(body).digest("base64");
  const bytes = new TextEncoder();
  assert.equal(await verifyLineSignature(bytes.encode(body).buffer, "fixture-secret", signature), true);
  assert.equal(await verifyLineSignature(bytes.encode(body + " ").buffer, "fixture-secret", signature), false);
  assert.equal(await verifyLineSignature(bytes.encode(body).buffer, "wrong-secret", signature), false);
  assert.equal(await verifyLineSignature(bytes.encode(body).buffer, "fixture-secret", null), false);
});

test("LINE credentials round trip with a fresh AES-GCM nonce", async (t) => {
  const original = process.env.LINE_SECRETS_KEY;
  t.after(() => {
    if (original === undefined) delete process.env.LINE_SECRETS_KEY;
    else process.env.LINE_SECRETS_KEY = original;
  });
  delete process.env.LINE_SECRETS_KEY;
  await assert.rejects(sealLineSecret("fixture"), /LINE_SECRETS_KEY_INVALID/);
  process.env.LINE_SECRETS_KEY = Buffer.alloc(32, 1).toString("base64");
  const ciphertext = await sealLineSecret("credential");
  assert.equal(await openLineSecret(ciphertext), "credential");
  assert.notEqual(await sealLineSecret("credential"), ciphertext);
  process.env.LINE_SECRETS_KEY = Buffer.alloc(32, 2).toString("base64");
  await assert.rejects(openLineSecret(ciphertext));
});
