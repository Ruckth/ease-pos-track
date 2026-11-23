import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_LIMITS } from "../shared/ticket-pages";
import { publishPageSelection, type ImagePolicy, type PageSelection } from "../src/features/tickets/page-publish";

const html = new File(['<img src="data:image/jpeg;base64,AAAA">'], "report.html", { type: "text/html" });
const large = () => new File([new Uint8Array(PAGE_LIMITS.maxTotalBytes)], "photo.png", { type: "image/png" });

function harness(responses: Array<"ok" | string> = ["ok"]) {
  const sent: Array<{ files: Array<{ path: string; blob: Blob }>; prepared: boolean }> = [];
  const policies: ImagePolicy[] = [];
  const prepared: string[] = [];
  const deps = {
    prepare: async (file: File) => { prepared.push(file.name); return new Blob(["small"]); },
    onPolicy: (policy: ImagePolicy) => { policies.push(policy); },
    send: async (_entry: string, files: Array<{ path: string; blob: Blob }>, isPrepared: boolean) => {
      sent.push({ files, prepared: isPrepared });
      const response = responses.shift() ?? "ok";
      if (response !== "ok") throw new Error(response);
      return { url: "https://site.test/p/key/report.html" };
    },
  };
  return { deps, sent, policies, prepared };
}

test("originals within the request limits go to the server pipeline once, untouched", async () => {
  const h = harness();
  await publishPageSelection({ entry: "report.html", files: [{ path: "report.html", blob: html }] }, h.deps);
  assert.deepEqual(h.prepared, []);
  assert.deepEqual(h.policies, ["server"]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].prepared, false);
  assert.equal(h.sent[0].files[0].blob, html);
});

test("originals over the request limits are prepared in the browser first", async () => {
  const h = harness();
  await publishPageSelection({ entry: "index.html", files: [
    { path: "index.html", blob: new File(["<img src=photo.png>"], "index.html") }, { path: "photo.png", blob: large() },
  ] }, h.deps);
  assert.deepEqual(h.prepared, ["index.html", "photo.png"]);
  assert.deepEqual(h.policies, ["browser"]);
  assert.deepEqual(h.sent.map(request => request.prepared), [true]);
});

test("server output over the limit falls back to browser preparation on the first attempt only", async () => {
  const h = harness(["PAGE_TOO_LARGE", "ok"]);
  const selection: PageSelection = { entry: "report.html", files: [{ path: "report.html", blob: html }] };
  await publishPageSelection(selection, h.deps);
  assert.deepEqual(h.policies, ["server", "browser"]);
  assert.deepEqual(h.sent.map(request => request.prepared), [false, true]);

  // A retry keeps the recorded policy: the same request id never changes bytes.
  const retry = harness(["PAGE_TOO_LARGE"]);
  await assert.rejects(publishPageSelection({ ...selection, policy: "server" }, retry.deps), /PAGE_TOO_LARGE/);
  assert.deepEqual(retry.sent.map(request => request.prepared), [false]);
});

test("an unknown outcome is surfaced for a same-key retry with the same originals", async () => {
  const h = harness(["PAGE_PUBLISH_UNKNOWN"]);
  const selection: PageSelection = { entry: "report.html", files: [{ path: "report.html", blob: html }] };
  await assert.rejects(publishPageSelection(selection, h.deps), /PAGE_PUBLISH_UNKNOWN/);
  const retry = harness();
  await publishPageSelection({ ...selection, policy: h.policies.at(-1) }, retry.deps);
  assert.equal(retry.sent[0].files[0].blob, h.sent[0].files[0].blob);
  assert.equal(retry.sent[0].prepared, false);
});

test("invalid paths fail before any image work or request", async () => {
  const h = harness();
  await assert.rejects(publishPageSelection({ entry: "../x.html", files: [{ path: "../x.html", blob: html }] }, h.deps), /PAGE_PATH_INVALID/);
  assert.deepEqual([h.prepared, h.sent], [[], []]);
});
