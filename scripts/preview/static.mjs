import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const [directory, port, release] = process.argv.slice(2);
const root = resolve(directory);
const types = new Map(Object.entries({
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".webp": "image/webp",
}));
async function serve(req, res) {
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405).end(); return; }
  const path = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  if (path === "/__slot_health") { res.writeHead(200).end(release); return; }
  if (path.startsWith("/api/")) { res.writeHead(503).end(); return; }
  const file = resolve(root, "." + path);
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  const entry = await stat(file).catch(() => null);
  const index = resolve(root, "index.html");
  const target = entry?.isFile() ? file : extname(path) ? null : index;
  if (!target) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types.get(extname(target)) ?? "application/octet-stream" });
  if (req.method === "HEAD") res.end();
  else createReadStream(target).on("error", () => res.destroy()).pipe(res);
}
createServer((req, res) => void serve(req, res).catch(() => {
  if (res.headersSent) res.destroy(); else res.writeHead(500).end();
})).listen(Number(port), "127.0.0.1");
