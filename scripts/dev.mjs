#!/usr/bin/env node
// `pnpm dev`: Vite, the upload API and the local Convex backend on this
// checkout's ports (see scripts/worktree-ports.mjs).
import { spawn } from "node:child_process";
import { loadPorts } from "./worktree-ports.mjs";

const ports = loadPorts();
const cloud = `http://127.0.0.1:${ports.CONVEX_CLOUD_PORT}`;
const site = `http://127.0.0.1:${ports.CONVEX_SITE_PORT}`;
console.log(`Ports: web ${ports.VITE_PORT}, api ${ports.UPLOAD_API_PORT}, convex ${ports.CONVEX_CLOUD_PORT}/${ports.CONVEX_SITE_PORT}`);

const env = {
  ...process.env,
  ...Object.fromEntries(Object.entries(ports).map(([key, value]) => [key, String(value)])),
  VITE_CONVEX_URL: cloud,
  VITE_CONVEX_SITE_URL: site,
  CONVEX_URL: cloud,
};
const child = spawn(
  "concurrently",
  ["-k", "-n", "vite,api,convex", `vite --port ${ports.VITE_PORT} --strictPort`, "tsx server/index.ts", "pnpm run dev:convex"],
  { stdio: "inherit", env },
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
