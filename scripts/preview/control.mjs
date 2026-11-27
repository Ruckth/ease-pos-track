import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCAL_IDENTITY_PLACEHOLDERS } from "../local-identity-env.mjs";
import { localAppOrigins, readPortsFile } from "../worktree-ports.mjs";
import { blankState, origin, readState, slotHealthy, stateFile } from "./router.mjs";
import { smoke } from "./smoke.mjs";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(root, process.env.TICKET_PREVIEW_STATE ?? ".preview");
const port = Number(process.env.TICKET_PREVIEW_PORT ?? 4179);
const [action, ...args] = process.argv.slice(2);
const cli = process.env.PATH;
const fixtureEnv = {
  ...LOCAL_IDENTITY_PLACEHOLDERS,
  LOCAL_FIXTURES_ENABLED: "true", TICKET_LOCAL_PREVIEW: "true", TICKET_DEPLOYMENT_MODE: "legacy",
  IDENTITY_SENDER: "local", IDENTITY_CODE_KEY: "local-only-identity-code-key-0123456789abcdef",
  UPLOAD_CALLBACK_SECRET: "local-only-callback-fixture", MEDIA_CLEANUP_ENABLED: "false", LINE_AI_ENABLED: "false",
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}
function snapshot(cwd) {
  const hash = createHash("sha256");
  hash.update(git(cwd, ["diff", "--binary", "HEAD", "--"]));
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean);
  for (const file of untracked) hash.update(file + "\0").update(readFileSync(resolve(cwd, file))).update("\0");
  return hash.digest("hex");
}

function save(state) {
  const file = stateFile(directory);
  const temp = file + ".next";
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, file);
}

function logPnpm(cwd, args, env, { capture = true, timeout = 180_000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn("pnpm", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { if (capture) output += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => stop(child.pid), timeout);
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) done(output);
      else reject(new Error(`pnpm ${args.slice(0, 2).join(" ")} failed (${code ?? "interrupted"})`));
    });
  });
}

function daemon(cwd, command, args, env, log) {
  const fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    child.on("error", () => {});
    child.unref();
    return child.pid;
  } finally { closeSync(fd); }
}

function stop(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function waitFor(slot) {
  const deadline = Date.now() + 35_000;
  do {
    if (await slotHealthy(slot)) return;
    await new Promise(done => setTimeout(done, 250));
  } while (Date.now() < deadline);
  throw new Error("Slot app, Convex query, and site did not become healthy");
}

async function launch(state) {
  const [name, input, seedFunction, checkFile] = args;
  if (!["a", "b"].includes(name) || !input || (seedFunction && seedFunction !== "-" && !/^[\w/]+:\w+$/.test(seedFunction))) {
    throw new Error("Usage: pnpm preview:local launch a|b <worktree> [seed:function|-] [smoke-module]");
  }
  const checkout = realpathSync(input);
  const common = git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
  if (git(checkout, ["rev-parse", "--show-toplevel"]).toString().trim() !== checkout || resolve(common, "..") === checkout) {
    throw new Error("Preview requires a dedicated linked worktree root");
  }
  const ports = readPortsFile(checkout);
  if (!ports?.VITE_PORT || !ports?.CONVEX_CLOUD_PORT || !ports?.CONVEX_SITE_PORT || !ports?.UPLOAD_API_PORT) throw new Error("Run pnpm agent:setup in the slot first");
  const slot = {
    name, checkout, app: ports.VITE_PORT, cloud: ports.CONVEX_CLOUD_PORT, site: ports.CONVEX_SITE_PORT, proxy: ports.UPLOAD_API_PORT,
    release: randomUUID(), probe: randomUUID(), sha: git(checkout, ["rev-parse", "HEAD"]).toString().trim(),
    snapshot: snapshot(checkout),
  };
  const currentlyServing = (await slotHealthy(state.active)) ? state.active : (await slotHealthy(state.previous)) ? state.previous : null;
  if (currentlyServing && (currentlyServing.name === name || currentlyServing.checkout === checkout ||
      [slot.app, slot.cloud, slot.site, slot.proxy].some(value => [currentlyServing.app, currentlyServing.cloud, currentlyServing.site, currentlyServing.proxy].includes(value)))) {
    throw new Error("Launch requires the inactive slot and a different backend");
  }
  if (state.candidate) throw new Error("Clear an interrupted candidate with pnpm preview:local clear-candidate");
  const replaced = [state.active, state.previous].find(prior => prior?.name === name);
  if (replaced && replaced.checkout !== checkout) throw new Error("Reuse the dedicated worktree already assigned to this slot");
  if (checkFile && resolve(checkFile) !== resolve(root, "scripts/preview/capture-smoke.mjs")) {
    throw new Error("Expected scripts/preview/capture-smoke.mjs");
  }
  const check = checkFile ? (await import("./capture-smoke.mjs")).default : undefined;
  const publicCheck = (stage, result) => ({ slot: name, sha: slot.sha, stage, result, at: new Date().toISOString() });
  let stage = "prepare";
  const release = resolve(directory, slot.release);
  mkdirSync(release, { mode: 0o700 });
  const env = {
    PATH: cli, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "1",
    TICKET_LOCAL_PREVIEW: "true", CONVEX_AGENT_MODE: "anonymous", TICKET_DEPLOYMENT_MODE: "legacy",
    NODE_OPTIONS: `--require=${JSON.stringify(resolve(root, "scripts/preview/backend-options.cjs"))}`,
    TICKET_PREVIEW_ACTION_PROXY: origin(slot.proxy),
    VITE_CONVEX_URL: origin(slot.cloud), VITE_CONVEX_SITE_URL: origin(slot.site), VITE_LOCAL_FIXTURE_SIGN_IN: "true",
  };
  const convex = (args, options) => logPnpm(checkout, ["--silent", "convex:local", ...args], env, options);
  function pending() { save({ ...state, candidate: slot, lastCheck: publicCheck(stage, "running") }); }
  try {
    if (replaced) {
      stop(replaced.appPid); stop(replaced.backendPid); stop(replaced.proxyPid);
      state = { ...state, active: currentlyServing, previous: null };
    }
    slot.proxyPid = daemon(checkout, process.execPath, [
      resolve(root, "scripts/preview/egress.mjs"), String(slot.proxy), String(slot.cloud), String(slot.site),
    ], env, resolve(release, "egress.log"));
    pending();
    // Wait for a retired wrapper to restore its .env backup before reusing the slot.
    for (let i = 0; i < 60 && existsSync(resolve(checkout, ".env.local.shared-backup")); i++) {
      await new Promise(done => setTimeout(done, 250));
    }
    if (existsSync(resolve(checkout, ".env.local.shared-backup"))) throw new Error("Candidate already owns an active Convex wrapper");
    stage = "fixture environment"; pending();
    const settings = {
      ...fixtureEnv, TICKET_APP_ORIGINS: `${localAppOrigins(ports)},${origin(port)}`,
      ...(seedFunction && seedFunction !== "-" ? { LINE_CAPTURE_ENABLED: "true", LINE_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") } : {}),
    };
    const listed = await convex(["env", "list"]);
    for (const line of listed.split("\n").map(line => line.trim()).filter(Boolean)) {
      const match = /^([A-Z][A-Z0-9_]*)$/.exec(line);
      if (!match) throw new Error("Could not verify the local Convex environment");
      if (!(match[1] in settings)) await convex(["env", "remove", match[1]], { capture: false });
    }
    const fixtureFile = resolve(release, "fixture.env");
    writeFileSync(fixtureFile, Object.entries(settings).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
    try { await convex(["env", "set", "--force", "--from-file", fixtureFile], { capture: false }); }
    finally { rmSync(fixtureFile, { force: true }); }
    const expected = new Set(Object.keys(settings));
    const configured = (await convex(["env", "list"])).trim().split("\n");
    if (configured.length !== expected.size || configured.some(key => !expected.has(key))) throw new Error("Unexpected local Convex environment");
    if ((await convex(["env", "get", "MEDIA_CLEANUP_ENABLED"])).trim() !== "false") throw new Error("Media cleanup must remain disabled");
    stage = "schema push"; pending();
    await convex([], { capture: false });
    stage = "synthetic seed"; pending();
    const seed = JSON.parse(await convex(["run", "seed:run"]));
    if (seed.projects?.length !== 2 || seed.tickets?.length !== 3 || seed.accessTokens?.length !== 3) throw new Error("Expected two seeded Projects and three fixture Tickets");
    slot.seedTickets = seed.tickets;
    if (seedFunction && seedFunction !== "-") await convex(["run", seedFunction], { capture: false });
    stage = "Vite build"; pending();
    slot.snapshot = snapshot(checkout);
    await logPnpm(checkout, ["exec", "node", resolve(root, "scripts/preview/build.mjs"), resolve(release, "web")], env, { capture: false });
    if (snapshot(checkout) !== slot.snapshot) throw new Error("Candidate checkout changed while building");
    stage = "runtime"; pending();
    slot.backendPid = daemon(checkout, "pnpm", ["--silent", "convex:local", "run", "_system/cli/tables", '{"paginationOpts":{"numItems":1,"cursor":null}}', "--watch"], env, resolve(release, "backend.log"));
    slot.appPid = daemon(checkout, process.execPath, [resolve(root, "scripts/preview/static.mjs"), resolve(release, "web"), String(slot.app), slot.release], env, resolve(release, "app.log"));
    pending();
    await waitFor(slot);
    stage = "stable-origin desktop/mobile smoke"; pending();
    await smoke({ port, slot, check, create: true });
    if (snapshot(checkout) !== slot.snapshot) throw new Error("Candidate checkout changed during smoke");
    slot.checkedAt = new Date().toISOString();
    delete slot.probe;
    writeFileSync(resolve(release, "launch.json"), JSON.stringify(slot, null, 2), { mode: 0o600 });
    save({ active: slot, previous: currentlyServing, candidate: null, lastCheck: publicCheck(stage, "passed") });
    console.log(`Preview slot ${name} active at ${origin(port)} (${slot.sha.slice(0, 12)})`);
  } catch (error) {
    stop(slot.appPid);
    stop(slot.backendPid);
    stop(slot.proxyPid);
    save({ ...state, candidate: null, lastCheck: publicCheck(stage, "failed") });
    throw new Error(`${stage}: ${error.message}`);
  }
}

async function control(state) {
  if (action === "launch") return launch(state);
  if (action === "rollback") {
    if (!await slotHealthy(state.previous)) throw new Error("Previous slot is unavailable");
    const { active, previous } = state;
    const candidate = { ...previous, probe: randomUUID() };
    save({ ...state, candidate });
    try { await smoke({ port, slot: candidate }); }
    catch (error) { save(state); throw error; }
    save({ ...state, active: previous, previous: active });
    console.log(`Rolled back to slot ${previous.name} at ${origin(port)}`);
    return;
  }
  if (action === "verify") {
    const status = await (await fetch(`${origin(port)}/__preview/status`)).json();
    const slot = [state.active, state.previous].find(item => item?.release === status.active?.release);
    if (!slot) throw new Error("No live app is serving at the stable address");
    await smoke({ port, slot });
    console.log(`Stable preview verified on desktop and mobile at ${origin(port)}`);
    return;
  }
  if (action === "clear-candidate") {
    if (state.candidate && ![state.active, state.previous].some(slot => slot?.release === state.candidate.release)) {
      stop(state.candidate.appPid);
      stop(state.candidate.backendPid);
      stop(state.candidate.proxyPid);
    }
    save({ ...state, candidate: null });
    return;
  }
  throw new Error("Expected serve, status, launch, verify, rollback, or clear-candidate");
}

function acquireLock(file) {
  let handle;
  try { handle = openSync(file, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Another preview operation is taking the lock");
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      rmSync(file);
      return acquireLock(file);
    }
    throw new Error("Another preview operation is running");
  }
  writeFileSync(handle, String(process.pid));
  return handle;
}

try {
  if (action === "serve") {
    const { createPreviewRouter } = await import("./router.mjs");
    createPreviewRouter({ directory, prototype: args[0] }).listen(port, "127.0.0.1", () => console.log(`Preview at ${origin(port)}`));
  } else if (action === "status") {
    const response = await fetch(`${origin(port)}/__preview/status`);
    console.log(await response.text());
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = resolve(directory, "control.lock");
    const handle = acquireLock(lock);
    try { await control(readState(directory) ?? blankState); }
    finally { closeSync(handle); rmSync(lock); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
