import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { redact, sanitize, slug, verifyPublic } from "../scripts/browser-evidence";
import { resultDirectory } from "../scripts/browser-result-paths";

test("sanitize redacts fixture secrets, session tokens, query strings and key/value secrets", () => {
  const token = "a".repeat(48);
  redact("runtime-session-value");
  const text = [
    "login LocalStaff123! with local-only-callback-fixture",
    `session ${token}`,
    "runtime-session-value leaked",
    "GET http://127.0.0.1:4170/api/query?token=abc&x=1",
    'args {"password":"hunter22","secret": "s3cret-value"}',
    "Authorization: Bearer abc.def",
  ].join("\n");
  const clean = sanitize(text);
  for (const secret of ["LocalStaff123!", "local-only-callback-fixture", token, "runtime-session-value", "token=abc", "hunter22", "s3cret-value", "abc.def"]) {
    assert.ok(!clean.includes(secret), `${secret} survived: ${clean}`);
  }
  assert.match(clean, /http:\/\/127\.0\.0\.1:4170\/api\/query\?\[redacted-query\]/);
  assert.equal(sanitize(clean), clean, "sanitizing is idempotent, so verify can detect unsanitized files");
  const commit = "55cc64d37dbbf4a399547d8ef9326e4a6aa216d2";
  assert.equal(sanitize(`"commit": "${commit}"`), `"commit": "${commit}"`, "40-hex commit ids stay readable; 48-hex session tokens do not");
});

test("verifyPublic accepts only allowlisted, sanitized files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evidence-"));
  try {
    mkdirSync(path.join(dir, "logs")); mkdirSync(path.join(dir, "screenshots"));
    writeFileSync(path.join(dir, "manifest.json"), "{}\n");
    writeFileSync(path.join(dir, "logs", "runner.log"), sanitize("ok\n"));
    writeFileSync(path.join(dir, "screenshots", "x.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.deepEqual(verifyPublic(dir).problems, []);
    writeFileSync(path.join(dir, "trace.zip"), "zip");
    writeFileSync(path.join(dir, "logs", "leak.log"), "password=LocalStaff123!\n");
    writeFileSync(path.join(dir, "screenshots", "fake.png"), "not a png");
    symlinkSync(path.join(dir, "logs", "runner.log"), path.join(dir, "logs", "linked.log"));
    assert.deepEqual(verifyPublic(dir).problems.sort(), [
      "not a PNG: screenshots/fake.png", "not a regular file: logs/linked.log",
      "not allowlisted: trace.zip", "unsanitized content: logs/leak.log",
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("browser evidence replaces only directories within test-results", () => {
  assert.throws(() => resultDirectory("."), /subdirectory of test-results/);
  assert.throws(() => resultDirectory("test-results"), /subdirectory of test-results/);
  assert.equal(resultDirectory("test-results/browser"), path.resolve("test-results/browser"));
});

test("slug keeps evidence file names inside the allowlist", () => {
  assert.equal(slug("staff th: ข้อความ / Archive (POS-0001)"), "staff-th-archive-pos-0001");
  assert.match(slug("x".repeat(200)), /^[a-z0-9-]{1,80}$/);
});
