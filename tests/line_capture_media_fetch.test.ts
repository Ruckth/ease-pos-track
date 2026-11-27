import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { localLineFixtureToken } from "../convex/adapters/line";
import {
  fetchCapturedLineContent,
  fixtureContentResponse,
  fixtureJpegBytes,
  fixturePngBytes,
  LINE_CAPTURE_MAX_TOTAL_BYTES,
  parseLineImageSet,
  readBoundedResponse,
  validateCapturedImage,
} from "../convex/line_capture_media_fetch";

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of prev.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("parseLineImageSet handles none, valid, overflow and malformed metadata", () => {
  assert.deepEqual(parseLineImageSet(undefined), { kind: "none" });
  assert.deepEqual(parseLineImageSet({ id: "set-1", index: 1, total: 2 }), {
    kind: "valid", id: "set-1", index: 1, total: 2,
  });
  assert.deepEqual(parseLineImageSet({ id: "set-2", index: 2, total: 3 }), {
    kind: "overflow", id: "set-2", index: 2, total: 3, warning: "IMAGE_SET_OVERFLOW",
  });
  for (const bad of [
    "bad",
    [],
    { id: "", index: 1, total: 2 },
    { id: "s", index: 0, total: 2 },
    { id: "s", index: 3, total: 2 },
    { id: "s", index: 1.5, total: 2 },
    { id: "s", index: 1 },
  ]) {
    const parsed = parseLineImageSet(bad);
    assert.equal(parsed.kind, "invalid");
    assert.equal(parsed.warning, "IMAGE_SET_METADATA_INCOMPLETE");
  }
});

test("validateCapturedImage stages valid JPEG/PNG and routes PDFs, unknown and malformed files to warnings", async () => {
  const png = await validateCapturedImage(fixturePngBytes(), "image/png");
  assert.equal(png.ok, true);
  if (png.ok) {
    assert.equal(png.contentType, "image/png");
    assert.equal(png.width, 16);
    assert.equal(png.height, 16);
    assert.match(png.sha256, /^[0-9a-f]{64}$/);
  }

  const jpeg = await validateCapturedImage(fixtureJpegBytes(), "image/jpeg; charset=binary");
  assert.equal(jpeg.ok, true);
  if (jpeg.ok) {
    assert.equal(jpeg.contentType, "image/jpeg");
    assert.equal(jpeg.width, 16);
    assert.equal(jpeg.height, 16);
  }

  const octetPng = await validateCapturedImage(fixturePngBytes(), "application/octet-stream");
  assert.equal(octetPng.ok, true);

  assert.deepEqual(
    await validateCapturedImage(new TextEncoder().encode("%PDF-1.4\n%test"), "application/pdf"),
    { ok: false, warningCode: "UNSUPPORTED_FILE_PDF" },
  );
  assert.deepEqual(
    await validateCapturedImage(new TextEncoder().encode("<svg></svg>"), "image/svg+xml"),
    { ok: false, warningCode: "UNSUPPORTED_MEDIA_TYPE" },
  );
  assert.deepEqual(
    await validateCapturedImage(fixturePngBytes(), "image/jpeg"),
    { ok: false, warningCode: "MEDIA_CONTENT_TYPE_MISMATCH" },
  );
  assert.deepEqual(
    await validateCapturedImage(fixturePngBytes().slice(0, 20), "image/png"),
    { ok: false, warningCode: "MEDIA_MALFORMED" },
  );
  assert.deepEqual(
    await validateCapturedImage(new Uint8Array(0), "image/png"),
    { ok: false, warningCode: "MEDIA_MALFORMED" },
  );
  assert.deepEqual(
    await validateCapturedImage(new Uint8Array(LINE_CAPTURE_MAX_TOTAL_BYTES + 1), "image/png"),
    { ok: false, warningCode: "MEDIA_SIZE_LIMIT_EXCEEDED" },
  );
});

test("deterministic built-in fixtures serve JPEG/PNG and warning scenarios without credentials", async () => {
  await withEnv({
    LOCAL_FIXTURES_ENABLED: "true",
    CONVEX_CLOUD_URL: "http://127.0.0.1:3212",
    LINE_CAPTURE_FIXTURE_MEDIA_BASE_URL: undefined,
  }, async () => {
    const png = await fetchCapturedLineContent({ messageId: "fixture-png-1", token: localLineFixtureToken });
    assert.equal(png.mimeType, "image/png");
    assert.equal((await validateCapturedImage(png.bytes, png.mimeType)).ok, true);

    const jpeg = await fetchCapturedLineContent({ messageId: "fixture-jpeg-2", token: localLineFixtureToken });
    assert.equal(jpeg.mimeType, "image/jpeg");
    assert.equal((await validateCapturedImage(jpeg.bytes, jpeg.mimeType)).ok, true);

    const pdf = await fetchCapturedLineContent({ messageId: "fixture-pdf-1", token: localLineFixtureToken });
    assert.deepEqual(await validateCapturedImage(pdf.bytes, pdf.mimeType), {
      ok: false, warningCode: "UNSUPPORTED_FILE_PDF",
    });

    await assert.rejects(
      () => fetchCapturedLineContent({ messageId: "fixture-oversized-1", token: localLineFixtureToken }),
      /MEDIA_SIZE_LIMIT_EXCEEDED/,
    );
    await assert.rejects(
      () => fetchCapturedLineContent({ messageId: "fixture-expired-1", token: localLineFixtureToken }),
      /MEDIA_UPSTREAM_EXPIRED/,
    );
    await assert.rejects(
      () => fetchCapturedLineContent({ messageId: "fixture-error-1", token: localLineFixtureToken }),
      /MEDIA_DOWNLOAD_UNAVAILABLE/,
    );
    assert.equal(fixtureContentResponse("unknown-id").status, 404);
  });
});

test("loopback fixture fetch streams bounded bytes and rejects non-loopback or real credentials", async () => {
  const server = createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? "").slice(1));
    if (id === "loop-png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(fixturePngBytes());
    } else if (id === "loop-stream-big") {
      // Chunked transfer with no Content-Length exceeding 8 MiB ceiling.
      res.writeHead(200, { "Content-Type": "image/png" });
      const chunk = new Uint8Array(1024 * 1024);
      for (let i = 0; i < 9; i++) res.write(chunk);
      res.end();
    } else if (id === "loop-410") {
      res.writeHead(410);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await withEnv({
      LOCAL_FIXTURES_ENABLED: "true",
      CONVEX_CLOUD_URL: "http://127.0.0.1:3212",
      LINE_CAPTURE_FIXTURE_MEDIA_BASE_URL: `http://127.0.0.1:${port}`,
    }, async () => {
      const ok = await fetchCapturedLineContent({ messageId: "loop-png", token: localLineFixtureToken });
      assert.deepEqual(ok.bytes, fixturePngBytes());

      await assert.rejects(
        () => fetchCapturedLineContent({ messageId: "loop-stream-big", token: localLineFixtureToken }),
        /MEDIA_SIZE_LIMIT_EXCEEDED/,
      );
      await assert.rejects(
        () => fetchCapturedLineContent({ messageId: "loop-410", token: localLineFixtureToken }),
        /MEDIA_UPSTREAM_EXPIRED/,
      );
      await assert.rejects(
        () => fetchCapturedLineContent({ messageId: "loop-png", token: "real-line-token" }),
        /LINE_FIXTURE_REQUIRED/,
      );
    });

    await withEnv({
      LOCAL_FIXTURES_ENABLED: "true",
      CONVEX_CLOUD_URL: "http://127.0.0.1:3212",
      LINE_CAPTURE_FIXTURE_MEDIA_BASE_URL: "https://evil.example/content",
    }, async () => {
      await assert.rejects(
        () => fetchCapturedLineContent({ messageId: "loop-png", token: localLineFixtureToken }),
        /LINE_FIXTURE_LOOPBACK_REQUIRED/,
      );
    });

    await withEnv({
      LOCAL_FIXTURES_ENABLED: "false",
      TICKET_LOCAL_PREVIEW: undefined,
      LINE_CAPTURE_LIVE_FETCH_ENABLED: undefined,
    }, async () => {
      await assert.rejects(
        () => fetchCapturedLineContent({ messageId: "msg-1", token: "real-line-token" }),
        /LINE_LIVE_FETCH_DISABLED/,
      );
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("readBoundedResponse enforces custom maxBytes ceiling during streaming", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64));
      controller.enqueue(new Uint8Array(64));
      controller.close();
    },
  });
  await assert.rejects(
    () => readBoundedResponse(new Response(stream, { status: 200 }), 100),
    /MEDIA_SIZE_LIMIT_EXCEEDED/,
  );
});
