#!/usr/bin/env node
// `pnpm dev`: Vite, the upload API and the local Convex backend. Each reads this
// checkout's ports itself (scripts/worktree-ports.mjs); only the browser and API
// Convex URLs are set here, so production builds never see local addresses.
import { spawn } from "node:child_process";
import { loadPorts } from "./worktree-ports.mjs";

const ports = loadPorts();
const cloud = `http://127.0.0.1:${ports.CONVEX_CLOUD_PORT}`;
console.log(`Ports: web ${ports.VITE_PORT}, api ${ports.UPLOAD_API_PORT}, convex ${ports.CONVEX_CLOUD_PORT}/${ports.CONVEX_SITE_PORT}`);

const env = { ...process.env, VITE_CONVEX_URL: cloud, VITE_CONVEX_SITE_URL: `http://127.0.0.1:${ports.CONVEX_SITE_PORT}`, CONVEX_URL: cloud };
const child = spawn("concurrently", ["-k", "-n", "vite,api,convex", "vite", "tsx server/index.ts", "pnpm run dev:convex"], { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`${error.message} (run through pnpm: pnpm dev)`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
