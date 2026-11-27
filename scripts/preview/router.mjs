import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const origin = port => `http://127.0.0.1:${port}`;
export const blankState = { active: null, previous: null, candidate: null, lastCheck: null };
export const stateFile = directory => resolve(directory, "state.json");

export function readState(directory) {
  try { return JSON.parse(readFileSync(stateFile(directory), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return blankState; throw error; }
}

const fallbackFile = resolve(import.meta.dirname, "workflow.html");
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const isPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const validSlot = slot => slot && [slot.app, slot.cloud, slot.site, slot.proxy].every(isPort);

function csp(slot) {
  const connect = slot ? [origin(slot.cloud), origin(slot.site), `ws://127.0.0.1:${slot.cloud}`].join(" ") : "";
  const script = slot ? "'self'" : "'self' 'unsafe-inline'";
  return `default-src 'none'; script-src ${script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${slot ? origin(slot.site) : ""}; media-src 'self' blob: ${slot ? origin(slot.site) : ""}; font-src 'self' data:; connect-src 'self' ${connect}; worker-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-src 'none'; object-src 'none'`;
}

export async function slotHealthy(slot) {
  if (!validSlot(slot)) return false;
  try {
    const timeout = () => AbortSignal.timeout(2000);
    const [app, cloud, site, proxy] = await Promise.all([
      fetch(`${origin(slot.app)}/__slot_health`, { signal: timeout() }),
      fetch(`${origin(slot.cloud)}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "identity:viewer", args: {}, format: "json" }),
        signal: timeout(),
      }),
      fetch(`${origin(slot.site)}/__preview_health`, { signal: timeout() }),
      fetch(`${origin(slot.proxy)}/__preview_proxy`, { signal: timeout() }),
    ]);
    if (!app.ok || !cloud.ok || site.status !== 404 || proxy.status !== 204) return false;
    const viewer = await cloud.json();
    return (await app.text()) === slot.release && viewer.status === "success" && viewer.value === null;
  } catch { return false; }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function statusPage({ mode, active, previous, lastCheck }) {
  const item = (label, value) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Track Ease preview status</title><style>body{color-scheme:light dark;font:16px/1.5 system-ui;margin:5vw;max-width:48rem}
dt{font-weight:650;margin-top:.7rem}dd{margin-left:0;overflow-wrap:anywhere}</style><main><h1>Track Ease preview status</h1>
<p><a href="/">Open preview</a> · <a href="/__preview/prototype">Open offline prototype</a></p><dl>
${item("Serving", mode === "app" ? `App slot ${active.name.toUpperCase()} · synthetic data` : "Offline workflow prototype")}
${active ? item("Active SHA", active.sha) + item("Worktree snapshot digest", active.snapshot) + Object.entries(active.integrations).map(([key, value]) => item(key, value)).join("") : ""}
${previous ? item("Previous app slot", previous.name.toUpperCase()) : ""}
${lastCheck ? item("Last check", `${lastCheck.result} · slot ${lastCheck.slot.toUpperCase()} · ${lastCheck.stage} · ${lastCheck.at}`) : ""}
</dl></main></html>`;
}

const publicSlot = slot => slot && {
  name: slot.name, sha: slot.sha, release: slot.release, snapshot: slot.snapshot, checkedAt: slot.checkedAt,
  integrations: { line: "Synthetic replay", model: "Synthetic preview · model disabled",
    storage: "Synthetic preview · local Convex storage", delivery: "Synthetic preview · external delivery disabled" },
};

export function createPreviewRouter({ directory, prototype = fallbackFile }) {
  const health = new Map();
  function healthy(slot) {
    if (!validSlot(slot)) return false;
    const now = Date.now();
    for (const [release, cached] of health) if (cached.until <= now) health.delete(release);
    if (!health.has(slot.release)) health.set(slot.release, { check: slotHealthy(slot), until: now + 750 });
    return health.get(slot.release).check;
  }

  function fallback(res, method) {
    let html;
    try { html = readFileSync(prototype, "utf8"); }
    catch { html = readFileSync(fallbackFile, "utf8"); }
    res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": csp(null),
      "x-track-ease-preview": "prototype" });
    res.end(method === "HEAD" ? undefined : html);
  }

  async function serve(req, res) {
    const { port } = server.address();
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
      res.writeHead(421).end(); return;
    }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
    if (req.headers.host === `localhost:${port}`) {
      res.writeHead(307, { ...headers, location: origin(port) + req.url }).end(); return;
    }
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(421).end(); return; }
    const pathname = new URL(req.url, origin(port)).pathname;
    if (pathname === "/__preview/prototype") { fallback(res, req.method); return; }
    const state = readState(directory);
    const candidate = state.candidate && req.headers["x-preview-probe"] === state.candidate.probe;
    const slot = candidate ? (await healthy(state.candidate) ? state.candidate : null)
      : await healthy(state.active) ? state.active : await healthy(state.previous) ? state.previous : null;
    if (pathname === "/__preview/status" || pathname === "/__preview") {
      const status = {
        mode: slot ? "app" : "prototype", active: publicSlot(slot), selected: publicSlot(state.active),
        previous: publicSlot(state.previous), lastCheck: state.lastCheck,
      };
      const html = pathname === "/__preview";
      res.writeHead(200, { ...headers, "content-type": html ? "text/html; charset=utf-8" : "application/json",
        "content-security-policy": csp(null) });
      res.end(req.method === "HEAD" ? undefined : html ? statusPage(status) : JSON.stringify(status, null, 2));
      return;
    }
    if (!slot) {
      if (candidate) res.writeHead(503, headers).end();
      else fallback(res, req.method);
      return;
    }
    const app = request({ hostname: "127.0.0.1", port: slot.app, path: req.url, method: req.method,
      headers: { accept: req.headers.accept ?? "*/*" }, timeout: 3000 }, upstream => {
      if (upstream.statusCode >= 500) {
        upstream.resume();
        if (candidate) res.writeHead(503, headers).end();
        else fallback(res, req.method);
        return;
      }
      res.writeHead(upstream.statusCode, { ...headers,
        "content-type": upstream.headers["content-type"] ?? "application/octet-stream",
        "content-security-policy": csp(slot), "x-track-ease-preview": slot.name, "x-track-ease-preview-sha": slot.sha });
      upstream.pipe(res);
    });
    app.on("timeout", () => app.destroy());
    app.on("error", () => {
      if (res.headersSent) { res.destroy(); return; }
      if (candidate) res.writeHead(503, headers).end();
      else fallback(res, req.method);
    });
    app.end();
  }
  const server = createServer((req, res) => void serve(req, res).catch(() => {
    if (res.headersSent) res.destroy();
    else fallback(res, req.method);
  }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, rawPort = "4179", prototype] = process.argv.slice(2);
  const port = Number(rawPort);
  if (!directory || !isPort(port)) throw new Error("Expected state directory and valid preview port");
  createPreviewRouter({ directory, prototype }).listen(port, "127.0.0.1", () => console.log(`Preview at ${origin(port)}`));
}
