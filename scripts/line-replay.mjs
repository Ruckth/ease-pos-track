import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadPorts } from "./worktree-ports.mjs";

const [path, flag, botSelector, ...extra] = process.argv.slice(2);
if (!path || flag !== "--bot" || !botSelector || extra.length) {
  console.error("Usage: pnpm line:replay <fixture.json> --bot <name or slug>");
  process.exit(2);
}
const fixture = readFileSync(path, "utf8");
const sitePort = loadPorts().CONVEX_SITE_PORT;
const result = spawnSync("pnpm", ["convex:local", "run", "line_local:replay",
  JSON.stringify({ sitePort, botSelector, fixture })], { stdio: "inherit" });
process.exit(result.status ?? 1);
