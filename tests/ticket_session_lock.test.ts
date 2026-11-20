// Concurrent Ticket CLI processes sharing one saved session, through the real
// orchestration, HTTP client, Keychain adapter and macOS session lock.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TicketCliError } from "../scripts/ticket/errors";
import { withFileLock } from "../scripts/ticket/lock";

const skip = platform() !== "darwin" && "the session lock uses macOS O_EXLOCK";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One staff session with a single current refresh token. Stricter than Convex
 * Auth, which tolerates sibling refreshes for a few seconds: presenting any
 * other token this session issued revokes it, so any unserialized rotation shows.
 */
class FakeDeployment {
  live: string | null = null;
  issued = new Set<string>();
  access = new Set<string>();
  revoked = false;
  reuses = 0;
  rotations = 0;
  holdNextRefresh = false;
  held: ServerResponse[] = [];
  private minted = 0;
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  url = "";

  async start() {
    await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }

  private tokens() {
    const n = ++this.minted;
    const refreshToken = `refresh-${n}`;
    const accessToken = `access-${n}`;
    this.live = refreshToken;
    this.issued.add(refreshToken);
    this.access.add(accessToken);
    return { accessToken, refreshToken, refreshTokenExpiresAt: Date.now() + 3_600_000, userId: "user" };
  }

  private revoke() {
    this.revoked = true;
    this.live = null;
    this.access.clear();
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { path, args: [args] } = JSON.parse(body) as { path: string; args: [Record<string, string>] };
    let value: unknown = null;
    switch (path) {
      case "auth:signInLocalFixture":
        this.revoked = false;
        value = { status: "complete", tokens: this.tokens() };
        break;
      case "auth:refreshSession":
        if (this.holdNextRefresh) {
          this.holdNextRefresh = false;
          this.held.push(response);
          return;
        }
        // Network latency on both sides of an atomic server transaction.
        await sleep(100);
        if (this.revoked || !this.issued.has(args.refreshToken)) value = { kind: "noSession" };
        else if (args.refreshToken !== this.live) {
          this.reuses += 1;
          this.revoke();
          value = { kind: "noSession" };
        } else {
          this.rotations += 1;
          value = { kind: "rotated", tokens: this.tokens() };
        }
        await sleep(100);
        break;
      case "identity:viewer": {
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        value = token && this.access.has(token)
          ? { kind: "staff", staffId: "staff", role: "owner", name: "Fixture Owner", email: "owner@fixture.test" }
          : null;
        break;
      }
      case "auth:signOut":
        if (this.issued.has(args.refreshToken)) this.revoke();
        break;
      case "projects:listProjects":
        value = [];
        break;
      default:
        response.writeHead(400).end(`unexpected ${path}`);
        return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "success", value, logLines: [] }));
  }
}

type Run = { code: number | null; stdout: string; stderr: string };

function cli(dir: string, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/ticket-session-process.ts", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FIXTURE_DIR: dir },
  });
  const done = new Promise<Run>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

const run = (dir: string, args: string[]) => cli(dir, args).done;

function savedToken(dir: string) {
  const item = join(dir, "keychain-dev");
  if (!existsSync(item)) return null;
  return (JSON.parse(Buffer.from(readFileSync(item, "utf8"), "base64").toString("utf8")) as { token: string }).token;
}

async function signedIn(fn: (deployment: FakeDeployment, dir: string) => Promise<void>) {
  const deployment = new FakeDeployment();
  await deployment.start();
  const dir = await mkdtemp(join(tmpdir(), "ticket-session-lock-"));
  try {
    const login = await run(dir, ["login", "--url", deployment.url]);
    assert.equal(login.code, 0, login.stderr);
    await fn(deployment, dir);
  } finally {
    await deployment.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test("concurrent CLI runs rotate the saved session one at a time", { skip }, async () => {
  await signedIn(async (deployment, dir) => {
    const runs = await Promise.all(Array.from({ length: 8 }, (_, index) => run(dir, [index % 2 ? "list" : "whoami"])));
    for (const result of runs) assert.equal(result.code, 0, result.stderr);
    assert.equal(deployment.reuses, 0);
    assert.equal(deployment.revoked, false);
    assert.equal(deployment.rotations, 8);
    assert.equal(savedToken(dir), deployment.live);

    const after = await run(dir, ["whoami"]);
    assert.equal(after.code, 0, after.stderr);
  });
});

test("logout racing live runs leaves no saved or server session behind", { skip }, async () => {
  await signedIn(async (deployment, dir) => {
    const [logout, ...runs] = await Promise.all([run(dir, ["logout"]), ...Array.from({ length: 5 }, () => run(dir, ["whoami"]))]);
    assert.equal(logout.code, 0, logout.stderr);
    assert.equal(JSON.parse(logout.stdout).loggedOut, true);
    for (const result of runs) {
      if (result.code !== 0) assert.equal(JSON.parse(result.stderr).code, "NOT_LOGGED_IN", result.stderr);
    }
    assert.equal(deployment.reuses, 0);
    assert.equal(deployment.revoked, true);
    assert.equal(savedToken(dir), null);
  });
});

test("a run killed while holding the session lock does not block the next run", { skip }, async () => {
  await signedIn(async (deployment, dir) => {
    deployment.holdNextRefresh = true;
    const stuck = cli(dir, ["whoami"]);
    while (deployment.held.length === 0) await sleep(20);
    stuck.child.kill("SIGKILL");
    assert.equal((await stuck.done).code, null);

    const started = Date.now();
    const next = await run(dir, ["whoami"]);
    assert.equal(next.code, 0, next.stderr);
    assert.ok(Date.now() - started < 15_000, "the kernel released the killed run's lock");
    assert.equal(deployment.reuses, 0);
    assert.equal(savedToken(dir), deployment.live);
  });
});

test("the session lock excludes a second holder and times out with a stable code", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticket-lock-"));
  try {
    const path = join(dir, "nested", "ticket.lock");
    await withFileLock(path, async () => {
      await assert.rejects(
        () => withFileLock(path, async () => assert.fail("acquired a held lock"), 100),
        (error: unknown) => error instanceof TicketCliError && error.code === "CREDENTIAL_LOCK_TIMEOUT" && error.exitCode === 4,
      );
    });
    assert.equal(await withFileLock(path, async () => "released", 100), "released");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
