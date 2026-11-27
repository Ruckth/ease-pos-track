import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blankState, createPreviewRouter, origin, stateFile } from "./router.mjs";

async function listen(server) {
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  return server.address().port;
}

test("router keeps the ready app through a failed candidate and falls back when both apps stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ticket-preview-router-"));
  const servers = [];
  const start = async handler => {
    const server = createServer(handler);
    servers.push(server);
    return listen(server);
  };
  const state = state => writeFile(stateFile(directory), JSON.stringify(state));
  async function slot(name) {
    const release = `release-${name}`;
    const health = { ok: true };
    return {
      health,
      name, release, sha: name.repeat(40), snapshot: name.repeat(64), probe: `private-${name}`,
      app: await start((req, res) => res.writeHead(health.ok ? 200 : 503, { "content-type": "text/html" })
        .end(req.url === "/__slot_health" ? release : `<h1>Slot ${name}</h1>`)),
      cloud: await start((req, res) => res.writeHead(200).end('{"status":"success","value":null}')),
      site: await start((req, res) => res.writeHead(404).end()),
      proxy: await start((req, res) => res.writeHead(204).end()),
    };
  }
  try {
    const a = await slot("a"), b = await slot("b");
    const preview = createPreviewRouter({ directory });
    servers.push(preview);
    const port = await listen(preview);
    const url = origin(port);
    const fetchRoot = headers => fetch(url, { headers });
    const served = async name => assert.equal((await fetchRoot()).headers.get("x-track-ease-preview"), name);
    const pauseHealthCache = () => new Promise(done => setTimeout(done, 760));

    await served("prototype");
    assert.match(await (await fetchRoot()).text(), /Track Ease workflow preview/);

    await state({ ...blankState, active: a, candidate: b });
    await served("a");
    const candidate = await fetchRoot({ "x-preview-probe": b.probe });
    assert.equal(candidate.headers.get("x-track-ease-preview"), "b");
    const policy = candidate.headers.get("content-security-policy");
    assert.ok(policy.includes(`ws://127.0.0.1:${b.cloud}`));
    assert.ok(!policy.includes(`ws://127.0.0.1:${a.cloud}`));

    b.health.ok = false;
    await pauseHealthCache();
    assert.equal((await fetchRoot({ "x-preview-probe": b.probe })).status, 503);
    await state({ ...blankState, active: a, lastCheck: { result: "failed", slot: "b", stage: "schema", at: "now" } });
    await served("a");
    const failed = await (await fetch(`${url}/__preview/status`)).json();
    assert.equal(failed.lastCheck.result, "failed");
    assert.equal(failed.active.sha, a.sha);
    assert.ok(!JSON.stringify(failed).includes(a.probe));
    assert.match(await (await fetch(`${url}/__preview`)).text(), /Active SHA/);

    b.health.ok = true;
    await pauseHealthCache();
    await state({ ...blankState, active: b, previous: a });
    await served("b");
    b.health.ok = false;
    await pauseHealthCache();
    await served("a");

    await state({ ...blankState, active: a, previous: b });
    await served("a");
    a.health.ok = false;
    await pauseHealthCache();
    await served("prototype");

    assert.equal((await fetch(url, { method: "POST" })).status, 405);
  } finally {
    await Promise.all(servers.map(server => new Promise(done => {
      server.closeAllConnections();
      server.close(done);
    })));
    await rm(directory, { recursive: true, force: true });
  }
});
