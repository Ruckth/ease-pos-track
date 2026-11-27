import { createServer, request } from "node:http";
import { origin } from "./router.mjs";

const [proxyPort, cloudPort, sitePort] = process.argv.slice(2).map(Number);
const permitted = new Set([origin(cloudPort), origin(sitePort)]);
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__preview_proxy") { res.writeHead(204).end(); return; }
  let url;
  try { url = new URL(req.url); }
  catch { res.writeHead(403).end(); return; }
  if (!permitted.has(url.origin) || url.username || url.password) { res.writeHead(403).end(); return; }
  const upstream = request(url, { method: req.method, headers: { ...req.headers, host: url.host },
    signal: AbortSignal.timeout(10000) }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) res.destroy(); else res.writeHead(502).end();
  });
  req.pipe(upstream);
});
server.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
server.listen(proxyPort, "127.0.0.1");
