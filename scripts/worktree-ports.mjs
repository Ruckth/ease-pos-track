// Per-checkout development ports, so parallel worktrees never share a server.
// `pnpm agent:setup` writes .env.worktree; without it the main checkout's
// historical ports apply. Node builtins only: setup runs before installation.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PORTS_FILE = ".env.worktree";

export const DEFAULT_PORTS = {
  CONVEX_CLOUD_PORT: 3212,
  CONVEX_SITE_PORT: 3213,
  UPLOAD_API_PORT: 8787,
  VITE_PORT: 5173,
};

// WHATWG fetch refuses these ports ("bad port"), so Node clients such as the
// Convex CLI can never reach a backend listening on them.
export const FETCH_BLOCKED_PORTS = new Set([4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** True when every port of the slot is reachable through fetch. */
export function slotUsable(slot) {
  return Object.values(portsForSlot(slot)).every((port) => !FETCH_BLOCKED_PORTS.has(port));
}

/** Slot n >= 1 owns four consecutive ports starting at 4000 + 10n. */
export function portsForSlot(slot) {
  const base = 4000 + slot * 10;
  return { CONVEX_CLOUD_PORT: base, CONVEX_SITE_PORT: base + 1, UPLOAD_API_PORT: base + 2, VITE_PORT: base + 3 };
}

/** Reads a checkout's ports file, or null when it has none. */
export function readPortsFile(dir = process.cwd()) {
  const file = path.join(dir, PORTS_FILE);
  if (!existsSync(file)) return null;
  const ports = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(\d+)\s*$/.exec(line.trim());
    if (match && match[1] in DEFAULT_PORTS) ports[match[1]] = Number(match[2]);
  }
  return ports;
}

export function loadPorts(dir = process.cwd()) {
  return { ...DEFAULT_PORTS, ...readPortsFile(dir) };
}
