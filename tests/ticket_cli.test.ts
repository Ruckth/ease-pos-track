import * as projectHandlers from "../convex/projects";
import { ConvexHttpClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import * as ticketHandlers from "../convex/tickets";
import * as authHandlers from "../convex/auth";
import * as identityHandlers from "../convex/identity";
import { ConvexTicketRemote } from "../scripts/ticket/remote";
import * as uploadHandlers from "../convex/uploads";
import * as pageHandlers from "../convex/pages";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValidatorJSON } from "convex/values";
import { ConvexError } from "convex/values";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseTicketArgs } from "../scripts/ticket/cli";
import type { ConfigStore, TicketConfig } from "../scripts/ticket/config";
import { EXIT, TicketCliError, remoteError, internalError } from "../scripts/ticket/errors";
import type { CredentialStore, StoredCredential } from "../scripts/ticket/keychain";
import { COMMAND_REGISTRY, commandDiscoveryOutput, humanHelp } from "../scripts/ticket/registry";
import type { TicketRef } from "../scripts/ticket/cli";
import type { SessionTokens, TicketAttachInput, TicketDocument, TicketPagePublishInput, TicketRemote } from "../scripts/ticket/remote";
import { classifyRemoteError, runTicketCli, type TicketCliDeps } from "../scripts/ticket/run";
import { toStoredTicketStatus, type TicketStatus } from "../scripts/ticket/status";

const HELP = humanHelp();

function ticket(overrides: Partial<TicketDocument> = {}) {
  return {
    _id: "ticket-id" as TicketDocument["_id"],
    _creationTime: 1_000,
    title: "Printer jams",
    description: "On long receipts",
    status: "new",
    projectId: "project-id" as TicketDocument["projectId"],
    projectKey: "TKT",
    lifecycle: "active",
    annotations: [],
    ticketNumber: 7,
    media: [],
    version: 0,
    origin: "staff",
    createdVia: "codex",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as TicketDocument;
}

class MemoryConfig implements ConfigStore {
  value: TicketConfig | null = null;
  saves = 0;
  async load() { return this.value; }
  async save(value: TicketConfig) { this.value = structuredClone(value); this.saves += 1; }
}

/** Fails credential access outside `exclusive` and nested calls, which would deadlock the real lock. */
class MemoryCredentials implements CredentialStore {
  values: Partial<Record<"dev" | "prod", StoredCredential>> = {};
  held = false;
  async get(target: "dev" | "prod") { this.locked(); return this.values[target] ?? null; }
  async set(target: "dev" | "prod", value: StoredCredential) { this.locked(); this.values[target] = value; }
  async delete(target: "dev" | "prod") { this.locked(); delete this.values[target]; }
  async exclusive<T>(fn: () => Promise<T>) {
    assert.equal(this.held, false, "exclusive must not nest");
    this.held = true;
    try { return await fn(); } finally { this.held = false; }
  }
  private locked() { assert.ok(this.held, "credential access outside exclusive"); }
}

// Validate transport shapes against the registered handlers, including extra fields.
function validateArgs(registration: object, args: unknown) {
  function check(validator: ValidatorJSON, value: unknown): void {
    if (validator.type === "object") {
      assert.ok(value && typeof value === "object" && !Array.isArray(value));
      const fields = value as Record<string, unknown>;
      for (const key of Object.keys(fields)) assert.ok(key in validator.value, `Unexpected field ${key}`);
      for (const [key, field] of Object.entries(validator.value)) {
        if (fields[key] === undefined && field.optional) continue;
        check(field.fieldType, fields[key]);
      }
    } else if (validator.type === "array") {
      assert.ok(Array.isArray(value));
      value.forEach(item => check(validator.value, item));
    } else if (validator.type === "union") {
      assert.ok(validator.value.some(option => { try { check(option, value); return true; } catch { return false; } }));
    } else if (validator.type === "id" || validator.type === "string") assert.equal(typeof value, "string");
    else if (validator.type === "number" || validator.type === "boolean") assert.equal(typeof value, validator.type);
    else if (validator.type === "null") assert.equal(value, null);
    else if (validator.type === "literal") assert.equal(value, validator.value);
    else assert.fail(`Unhandled validator ${validator.type}`);
  }
  check(JSON.parse((registration as { exportArgs(): string }).exportArgs()), args);
}

class FakeRemote implements TicketRemote {
  calls: Array<{ method: string; args: unknown[] }> = [];
  session: Awaited<ReturnType<TicketRemote["currentSession"]>> = { role: "staff", name: "Fixture Staff", email: "staff@example.com" };
  rows = [ticket()];
  signInResult: SessionTokens | null = { accessToken: "signed-in-access", refreshToken: "secret-refresh", refreshTokenExpiresAt: 20_000 };
  refreshes: Array<{ url: string; refreshToken: string }> = [];
  revoked = false;

  private record(method: string, ...args: unknown[]) { this.calls.push({ method, args }); }
  async startGoogle(): Promise<{ redirect: string; state: string }> { throw new Error("browser sign-in is injected through deps.signIn"); }
  async completeGoogle(): Promise<SessionTokens | null> { throw new Error("browser sign-in is injected through deps.signIn"); }
  async signInLocalFixture(): Promise<SessionTokens | null> { throw new Error("unused"); }
  /** Rotation is recorded separately; the access token keeps the saved name so call logs stay readable. */
  async refresh(url: string, refreshToken: string) {
    this.refreshes.push({ url, refreshToken });
    return this.revoked ? null : { accessToken: refreshToken, refreshToken: `${refreshToken}`, refreshTokenExpiresAt: 20_000 };
  }
  async currentSession(url: string, token: string) { this.record("currentSession", url, token); return this.session; }
  async logout(url: string, token: string) { this.record("logout", url, token); }
  async list(url: string, token: string, projectKey: string | undefined, includeArchived: boolean) {
    this.record("list", url, token, projectKey, includeArchived);
    return this.rows;
  }
  async get(url: string, token: string, ref: TicketRef, includeArchived: boolean) {
    this.record("get", url, token, ref, includeArchived);
    return this.rows.find((row) =>
      row.projectKey === ref.projectKey && row.ticketNumber === ref.ticketNumber && (includeArchived || row.archivedAt === undefined)
    ) ?? null;
  }
  async create(url: string, token: string, input: { title: string; description: string; requestId: string; projectKey?: string }) {
    this.record("create", url, token, input);
    return { ticket: this.rows[0], created: true, requestId: input.requestId };
  }
  async createUploadIntent(url: string, token: string, input: { requestId: string; files: Array<{ name: string; size: number; type: string }> }): ReturnType<TicketRemote["createUploadIntent"]> {
    validateArgs(uploadHandlers.createUploadIntent, { idempotencyKey: input.requestId, files: input.files });
    this.record("createUploadIntent", url, token, input);
    return { intentId: "intent-id" as never, secret: "s".repeat(48), uploadedFiles: [] };
  }
  async recordUploadedFile(url: string, input: { token: string; intentId: string; secret: string; file: TicketDocument["media"][number] }) {
    const { token: _token, ...args } = input;
    validateArgs(uploadHandlers.recordUploadedFile, args);
    this.record("recordUploadedFile", url, input);
  }
  async cancelUploadIntent(url: string, token: string, input: { intentId: string; secret: string }) {
    validateArgs(uploadHandlers.cancelUploadIntent, input);
    this.record("cancelUploadIntent", url, token, input);
  }
  async attachImages(url: string, token: string, input: TicketAttachInput) {
    this.record("attachImages", url, token, input);
    this.rows[0] = ticket({ ...this.rows[0], media: [...this.rows[0].media, ...input.media], version: input.expectedVersion + 1 });
  }
  async update(url: string, token: string, input: { ref: TicketRef; title?: string; description?: string; expectedVersion: number }) {
    this.record("update", url, token, input);
    if (input.expectedVersion !== (this.rows[0].version ?? 0)) throw new Error("VERSION_CONFLICT");
    this.rows[0] = ticket({ ...this.rows[0], ...input, version: input.expectedVersion + 1 });
    return this.rows[0];
  }
  async changeStatus(url: string, token: string, input: { ref: TicketRef; status: TicketStatus; expectedVersion: number }) {
    this.record("changeStatus", url, token, input);
    this.rows[0] = ticket({ ...this.rows[0], status: toStoredTicketStatus(input.status), version: input.expectedVersion + 1 });
    return this.rows[0];
  }
  async archive(url: string, token: string, ref: TicketRef, expectedVersion: number) {
    this.record("archive", url, token, ref, expectedVersion);
    this.rows[0] = ticket({ ...this.rows[0], archivedAt: 5_000, version: expectedVersion + 1 });
    return this.rows[0];
  }
  async restore(url: string, token: string, ref: TicketRef, expectedVersion: number) {
    this.record("restore", url, token, ref, expectedVersion);
    const { archivedAt: _archivedAt, ...active } = this.rows[0];
    this.rows[0] = ticket({ ...active, version: expectedVersion + 1 });
    return this.rows[0];
  }
  pageError: Error | null = null;
  pages = [{ pageId: "page-id", url: "https://site.example/p/key/index.html", entry: "index.html", fileCount: 2, totalBytes: 10, publishedAt: 1 }];
  async publishPage(url: string, token: string, input: TicketPagePublishInput) {
    this.record("publishPage", url, token, input);
    if (this.pageError) throw this.pageError;
    return { ...this.pages[0], entry: input.bundle.entry, fileCount: input.bundle.files.length, totalBytes: input.bundle.totalBytes, created: true, requestId: input.requestId };
  }
  async listPages(url: string, token: string, id: TicketDocument["_id"]) { this.record("listPages", url, token, id); return this.pages; }
  async revokePage(url: string, token: string, pageId: string) { this.record("revokePage", url, token, pageId); return true; }
}

function fixture() {
  const remote = new FakeRemote();
  const config = new MemoryConfig();
  config.value = { version: 1, clientId: "stable-client-id-1234", deployments: { dev: { url: "https://dev.example.com" }, prod: { url: "https://prod.example.com" } } };
  const credentials = new MemoryCredentials();
  credentials.values.dev = { token: "saved-dev-token", expiresAt: 20_000, url: "https://dev.example.com" };
  credentials.values.prod = { token: "saved-prod-token", expiresAt: 20_000, url: "https://prod.example.com" };
  const deps: TicketCliDeps = {
    remote,
    config,
    credentials,
    signIn: async () => remote.signInResult,
    newRequestId: () => "generated-request-id",
    now: () => 10_000,
    env: {},
    images: {
      prepare: async (sources: string[]) => sources.map((source, index) => new File([`image-${index}`], source.split("/").at(-1) ?? `image-${index}.png`, { type: "image/png" })),
      upload: async (files: File[]) => files.map((file, index) => ({
        key: `image-key-${file.name}`,
        name: file.name,
        size: file.size,
        type: file.type,
        url: `https://files.example.com/image-${index}.png`,
      })),
    },
  };
  return { deps, remote, config, credentials };
}

test("the registry is the source for machine discovery, parsing, and pnpm-only human help", () => {
  const discovery = commandDiscoveryOutput();
  assert.deepEqual(discovery.commands.map((command) => command.name), COMMAND_REGISTRY.map((command) => command.name));
  assert.equal(parseTicketArgs(["commands"]).kind, "commands");
  assert.match(HELP, /pnpm ticket commands/);
  assert.doesNotMatch(HELP, /\bnpm\b|\bnpx\b/);
  assert.equal(discovery.commands.every((command) => command.usage.startsWith("pnpm ticket ")), true);
  assert.equal(discovery.commands.find((command) => command.name === "login")?.interactive, "browser-sign-in");
});

test("commands discovery is unauthenticated and prints one compact JSON object", async () => {
  const { deps, remote, config, credentials } = fixture();
  config.value = null;
  credentials.values = {};
  const outcome = await runTicketCli(["commands"], deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stderr, "");
  assert.equal(outcome.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(outcome.stdout).schemaVersion, 1);
  assert.deepEqual(remote.calls, []);
  assert.equal(config.saves, 0);
});

test("the intended pnpm wrapper preserves exact stdout, stderr, and exit-code contracts", () => {
  const success = spawnSync("pnpm", ["ticket", "commands"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(success.status, 0);
  assert.equal(success.stderr, "");
  assert.equal(success.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(success.stdout).ok, true);

  const failure = spawnSync("pnpm", ["ticket", "get", "bad"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(failure.status, EXIT.invalidInput);
  assert.equal(failure.stdout, "");
  assert.equal(failure.stderr.trim().split("\n").length, 1);
  assert.equal(JSON.parse(failure.stderr).code, "INVALID_TICKET");
});

test("parsing covers deployment selection, Ticket references, versions, and operation flags", () => {
  assert.deepEqual(parseTicketArgs(["list"]), { kind: "list", deployment: "dev", includeArchived: false });
  assert.deepEqual(parseTicketArgs(["list", "--project", "pos"]), { kind: "list", deployment: "dev", projectKey: "POS", includeArchived: false });
  assert.deepEqual(parseTicketArgs(["get", "pos-0012"]), { kind: "get", deployment: "dev", ref: { projectKey: "POS", ticketNumber: 12 }, includeArchived: false });
  assert.deepEqual(parseTicketArgs(["get", "TKT-0007", "--include-archived", "--prod"]), { kind: "get", deployment: "prod", ref: { projectKey: "TKT", ticketNumber: 7 }, includeArchived: true });
  assert.deepEqual(parseTicketArgs(["status", "TKT-0007", "--status", "waiting_for_customer", "--expected-version", "2"]), { kind: "status", deployment: "dev", ref: { projectKey: "TKT", ticketNumber: 7 }, status: "waiting_for_customer", expectedVersion: 2 });
  assert.deepEqual(parseTicketArgs(["archive", "TKT-0007", "--expected-version=3"]), { kind: "archive", deployment: "dev", ref: { projectKey: "TKT", ticketNumber: 7 }, expectedVersion: 3 });
  assert.deepEqual(parseTicketArgs(["restore", "TKT-0007", "--expected-version", "4"]), { kind: "restore", deployment: "dev", ref: { projectKey: "TKT", ticketNumber: 7 }, expectedVersion: 4 });
  assert.deepEqual(parseTicketArgs(["update", "TKT-0007", "--title", " New title ", "--expected-version", "1"]), { kind: "update", deployment: "dev", ref: { projectKey: "TKT", ticketNumber: 7 }, title: "New title", expectedVersion: 1 });
});

test("create and attach accept repeatable local or HTTPS image sources", () => {
  assert.deepEqual(
    parseTicketArgs([
      "create",
      "--title",
      "Calendar overlap",
      "--image",
      "/tmp/first.png",
      "--image=https://images.example.com/second.png",
    ]),
    {
      kind: "create",
      deployment: "dev",
      request: { title: "Calendar overlap", description: "" },
      images: ["/tmp/first.png", "https://images.example.com/second.png"],
      dryRun: false,
    },
  );
  assert.deepEqual(
    parseTicketArgs([
      "attach",
      "TKT-0007",
      "--image",
      "/tmp/first.png",
      "--image",
      "https://images.example.com/second.png",
      "--expected-version",
      "2",
      "--request-id",
      "attach-images-0001",
      "--prod",
    ]),
    {
      kind: "attach",
      deployment: "prod",
      ref: { projectKey: "TKT", ticketNumber: 7 },
      expectedVersion: 2,
      images: ["/tmp/first.png", "https://images.example.com/second.png"],
      requestId: "attach-images-0001",
    },
  );
});

test("parsing rejects unstable or unsafe operation inputs with stable codes", () => {
  const cases: Array<[string[], string, number]> = [
    [["wat"], "UNKNOWN_COMMAND", EXIT.usage],
    [["get", "7"], "INVALID_TICKET", EXIT.invalidInput],
    [["archive", "TKT-0007"], "EXPECTED_VERSION_REQUIRED", EXIT.usage],
    [["update", "TKT-0007", "--expected-version", "0"], "UPDATE_REQUIRED", EXIT.usage],
    [["status", "TKT-0007", "--status", "closed", "--expected-version", "0"], "INVALID_STATUS", EXIT.invalidInput],
    [["list", "--nope"], "UNKNOWN_FLAG", EXIT.usage],
    [["list", "--project", "1X"], "INVALID_PROJECT", EXIT.invalidInput],
    [["get", "TKT-07"], "INVALID_TICKET", EXIT.invalidInput],
  ];
  for (const [argv, code, exitCode] of cases) {
    assert.throws(() => parseTicketArgs(argv), (error: unknown) => error instanceof TicketCliError && error.code === code && error.exitCode === exitCode);
  }
});

test("create supports JSON, validates locally, and dry-run touches no config, credential, or deployment", async () => {
  const { deps, remote, config, credentials } = fixture();
  config.value = null;
  credentials.values = {};
  const parsed = parseTicketArgs(["create", "--json", '{"title":" Printer jams ","description":" Long receipts ","requestId":" req-1 ","project":"pos"}']);
  assert.equal(parsed.kind, "create");
  if (parsed.kind === "create") assert.deepEqual(parsed.request, { title: "Printer jams", description: "Long receipts", requestId: "req-1", projectKey: "POS" });

  const result = await runTicketCli(["create", "--title", "Printer jams", "--dry-run"], deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, dryRun: true, created: false, deployment: "dev",
    ticket: { project: null, title: "Printer jams", description: "", status: "new", media: [], origin: "staff", createdVia: "codex", requestId: "generated-request-id" },
  });
  assert.deepEqual(remote.calls, []);
  assert.equal(config.saves, 0);
});

test("login runs the named sign-in, persists URL/client id, and stores only the rotating refresh credential", async () => {
  const { deps, remote, config, credentials } = fixture();
  config.value = null;
  credentials.values = {};
  deps.env.VITE_CONVEX_URL = "https://first.example.com";
  const outcome = await runTicketCli(["login"], deps);
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.deepEqual(remote.calls[0], { method: "currentSession", args: ["https://first.example.com", "signed-in-access"] });
  const savedConfig = await config.load();
  assert.equal(savedConfig?.deployments.dev?.url, "https://first.example.com");
  assert.equal(savedConfig?.clientId.length, 36);
  assert.deepEqual(credentials.values.dev, { token: "secret-refresh", expiresAt: 20_000, url: "https://first.example.com" });
  assert.equal(JSON.parse(outcome.stdout).authenticated, true);
  assert.equal(JSON.stringify(config.value).includes("secret-refresh"), false);
  assert.equal(outcome.stdout.includes("signed-in-access"), false);
});

test("a sign-in that does not complete, or is not staff, stores nothing", async () => {
  const failed = fixture();
  failed.credentials.values = {};
  failed.remote.signInResult = null;
  const result = await runTicketCli(["login"], failed.deps);
  assert.equal(result.exitCode, EXIT.auth);
  assert.equal(JSON.parse(result.stderr).code, "SIGN_IN_FAILED");
  assert.equal(failed.credentials.values.dev, undefined);
  const pending = fixture();
  pending.credentials.values = {};
  pending.remote.session = { role: "pending", name: null, email: "someone@example.com" };
  const denied = await runTicketCli(["login"], pending.deps);
  assert.equal(JSON.parse(denied.stderr).code, "NOT_AUTHORIZED");
  assert.equal(pending.credentials.values.dev, undefined);
  assert.equal(pending.remote.calls.at(-1)?.method, "logout");
});

test("every authenticated run rotates the saved refresh credential before use", async () => {
  const { deps, remote, credentials } = fixture();
  remote.refresh = async (url, refreshToken) => {
    remote.refreshes.push({ url, refreshToken });
    return { accessToken: "run-access", refreshToken: "rotated-refresh", refreshTokenExpiresAt: 30_000 };
  };
  const result = await runTicketCli(["list"], deps);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(remote.refreshes, [{ url: "https://dev.example.com", refreshToken: "saved-dev-token" }]);
  assert.deepEqual(credentials.values.dev, { token: "rotated-refresh", expiresAt: 30_000, url: "https://dev.example.com" });
  assert.deepEqual(remote.calls.map(call => call.args[1]), ["run-access", "run-access"]);
});

test("whoami reuses a persisted session across runs and logout revokes then deletes it", async () => {
  const { deps, remote, credentials } = fixture();
  const whoami = await runTicketCli(["whoami"], deps);
  assert.deepEqual(JSON.parse(whoami.stdout), { ok: true, authenticated: true, role: "staff", name: "Fixture Staff", email: "staff@example.com", deployment: "dev", url: "https://dev.example.com", expiresAt: 20_000 });
  assert.deepEqual(remote.calls[0], { method: "currentSession", args: ["https://dev.example.com", "saved-dev-token"] });

  const logout = await runTicketCli(["logout"], deps);
  assert.equal(JSON.parse(logout.stdout).loggedOut, true);
  assert.equal(credentials.values.dev, undefined);
  assert.equal(remote.calls.at(-1)?.method, "logout");
  const again = await runTicketCli(["logout"], deps);
  assert.equal(JSON.parse(again.stdout).loggedOut, false);
});

test("a read-only auth command does not create configuration before setup is complete", async () => {
  const { deps, config, credentials } = fixture();
  config.value = null;
  credentials.values = {};
  const result = await runTicketCli(["whoami"], deps);
  assert.equal(result.exitCode, EXIT.auth);
  assert.equal(JSON.parse(result.stderr).code, "DEPLOYMENT_NOT_CONFIGURED");
  assert.equal(config.saves, 0);
  assert.equal(config.value, null);
});

test("create dry-run validates image inputs and previews their original metadata without uploading", async () => {
  const { deps, remote } = fixture();
  let uploaded = false;
  deps.images.upload = async () => { uploaded = true; return []; };

  const result = await runTicketCli([
    "create", "--title", "Calendar overlap", "--image", "/tmp/first.png", "--dry-run",
  ], deps);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).ticket.media, [
    { name: "first.png", size: 7, type: "image/png" },
  ]);
  assert.equal(uploaded, false);
  assert.deepEqual(remote.calls, []);

  deps.images.prepare = async () => { throw new TicketCliError("IMAGE_FILE_NOT_FOUND", "missing", EXIT.invalidInput); };
  const invalid = await runTicketCli([
    "create", "--title", "Calendar overlap", "--image", "/tmp/missing.png", "--dry-run",
  ], deps);
  assert.equal(invalid.exitCode, EXIT.invalidInput);
  assert.equal(JSON.parse(invalid.stderr).code, "IMAGE_FILE_NOT_FOUND");
});

test("logout can revoke a Keychain session even when non-secret configuration was removed", async () => {
  const { deps, remote, config, credentials } = fixture();
  config.value = null;
  const result = await runTicketCli(["logout"], deps);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).loggedOut, true);
  assert.deepEqual(remote.calls[0], { method: "logout", args: ["https://dev.example.com", "saved-dev-token"] });
  assert.equal(credentials.values.dev, undefined);
});

test("missing, expired, invalid, mismatched, and non-staff sessions have stable auth failures", async () => {
  const missing = fixture();
  missing.credentials.values.dev = undefined;
  assert.equal(JSON.parse((await runTicketCli(["whoami"], missing.deps)).stderr).code, "NOT_LOGGED_IN");

  const expired = fixture();
  expired.credentials.values.dev!.expiresAt = 9_999;
  assert.equal(JSON.parse((await runTicketCli(["list"], expired.deps)).stderr).code, "SESSION_EXPIRED");
  assert.equal(expired.credentials.values.dev, undefined);

  const invalid = fixture();
  invalid.remote.session = null;
  assert.equal(JSON.parse((await runTicketCli(["list"], invalid.deps)).stderr).code, "SESSION_INVALID");

  const revoked = fixture();
  revoked.remote.revoked = true;
  assert.equal(JSON.parse((await runTicketCli(["list"], revoked.deps)).stderr).code, "SESSION_INVALID");
  assert.equal(revoked.credentials.values.dev, undefined);

  const mismatch = fixture();
  mismatch.credentials.values.dev!.url = "https://other.example.com";
  assert.equal(JSON.parse((await runTicketCli(["list"], mismatch.deps)).stderr).code, "SESSION_DEPLOYMENT_MISMATCH");

  const customer = fixture();
  customer.remote.session = { role: "customer", name: "Alice", email: null };
  assert.equal(JSON.parse((await runTicketCli(["list"], customer.deps)).stderr).code, "NOT_AUTHORIZED");
});

test("list and get return stable Ticket JSON shapes", async () => {
  const { deps } = fixture();
  const listed = JSON.parse((await runTicketCli(["list"], deps)).stdout);
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.tickets[0], {
    id: "ticket-id", ticket: "TKT-0007", ticketNumber: 7, project: "TKT", title: "Printer jams", description: "On long receipts",
    status: "new", version: 0, archived: false, createdAt: 1_000, updatedAt: 1_000, origin: "staff", createdVia: "codex", mediaCount: 0, annotationCount: 0,
  });
  const found = JSON.parse((await runTicketCli(["get", "TKT-0007"], deps)).stdout);
  assert.deepEqual(found.ticket.media, []);
  assert.deepEqual(found.ticket.annotations, []);
  const absent = await runTicketCli(["get", "TKT-9999"], deps);
  assert.equal(JSON.parse(absent.stderr).code, "TICKET_NOT_FOUND");
});

test("internal workflow literals never leak into user-facing Ticket JSON", async () => {
  const { deps, remote } = fixture();
  remote.rows = [ticket({ status: "done" })];
  const listed = JSON.parse((await runTicketCli(["list"], deps)).stdout);
  assert.equal(listed.tickets[0].status, "resolved");
  const found = JSON.parse((await runTicketCli(["get", "TKT-0007"], deps)).stdout);
  assert.equal(found.ticket.status, "resolved");
  assert.match(HELP, /waiting_for_customer/);
  assert.match(HELP, /resolved/);
  assert.doesNotMatch(HELP, /\bwaiting\b|\bdone\b/i);
});

test("authenticated create is direct, idempotency-shaped, and keeps production explicit", async () => {
  const { deps, remote } = fixture();
  const created = await runTicketCli(["create", "--title", "Printer jams", "--request-id", "req-1", "--prod"], deps);
  assert.equal(remote.calls[0].args[0], "https://prod.example.com");
  assert.equal(remote.calls.find((call) => call.method === "create")?.args[1], "saved-prod-token");
  assert.deepEqual(JSON.parse(created.stdout), { ok: true, id: "ticket-id", ticket: "TKT-0007", ticketNumber: 7, project: "TKT", status: "new", version: 0, created: true, deployment: "prod", requestId: "req-1" });
  assert.equal(classifyRemoteError(new Error("REQUEST_ID_CONFLICT"), "dev").exitCode, EXIT.conflict);
});

test("attach uploads images through a verified intent and returns the updated Ticket", async () => {
  const { deps, remote } = fixture();
  const result = await runTicketCli([
    "attach",
    "TKT-0007",
    "--image",
    "/tmp/first.png",
    "--image",
    "https://images.example.com/second.png",
    "--expected-version",
    "0",
    "--request-id",
    "attach-images-0001",
  ], deps);

  assert.equal(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.requestId, "attach-images-0001");
  assert.equal(output.ticket.mediaCount, 2);
  assert.equal(output.ticket.version, 1);
  assert.deepEqual(
    remote.calls.map((call) => call.method),
    ["currentSession", "get", "createUploadIntent", "recordUploadedFile", "recordUploadedFile", "attachImages", "get"],
  );
});

test("create with images creates the Ticket first then attaches media with the same retry id", async () => {
  const { deps, remote } = fixture();
  const result = await runTicketCli([
    "create",
    "--title",
    "Calendar overlap",
    "--image",
    "/tmp/first.png",
    "--request-id",
    "create-images-0001",
  ], deps);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).version, 1);
  assert.equal(JSON.parse(result.stdout).requestId, "create-images-0001");
  assert.deepEqual(
    remote.calls.map((call) => call.method),
    ["currentSession", "create", "get", "createUploadIntent", "recordUploadedFile", "attachImages", "get"],
  );
});

test("an interrupted attachment retry reuses files already recorded by its upload intent", async () => {
  const { deps, remote } = fixture();
  const uploaded = {
    key: "existing-key",
    name: "first.png",
    size: 7,
    type: "image/png",
    url: "https://files.example.com/existing.png",
  };
  remote.createUploadIntent = async () => ({
    intentId: "intent-id" as never,
    secret: "s".repeat(48),
    uploadedFiles: [uploaded],
  });
  deps.images.upload = async () => {
    throw new Error("already recorded images must not be uploaded again");
  };

  const result = await runTicketCli([
    "attach", "TKT-0007", "--image", "/tmp/first.png",
    "--expected-version", "0", "--request-id", "attach-images-retry-0001",
  ], deps);

  assert.equal(result.exitCode, 0);
  assert.equal(remote.calls.some((call) => call.method === "recordUploadedFile"), false);
  assert.equal(remote.calls.at(-1)?.method, "get");
});

test("an idempotent create retry reports the original Ticket without claiming a new write", async () => {
  const { deps, remote } = fixture();
  remote.create = async (_url, _token, input) => ({ ticket: remote.rows[0], created: false, requestId: input.requestId });
  const result = await runTicketCli(["create", "--title", "Printer jams", "--description", "On long receipts", "--request-id", "same-request"], deps);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).created, false);
  assert.equal(JSON.parse(result.stdout).requestId, "same-request");
});

test("an attached intent still sends the request id for authoritative attachment conflict checks", async () => {
  const { deps, remote } = fixture();
  remote.createUploadIntent = async () => ({
    intentId: "intent-id" as never, secret: "secret", ticketId: remote.rows[0]._id,
    uploadedFiles: [{ key: "existing-key", name: "first.png", size: 7, type: "image/png", url: "https://fixture.invalid/first.png" }],
  });
  deps.images.upload = async () => { throw new Error("Must reuse the uploaded file"); };
  remote.attachImages = async (_url, _token, input) => {
    assert.equal(input.requestId, "same-attachment-id");
    throw new ConvexError({ code: "REQUEST_ID_CONFLICT" });
  };
  const result = await runTicketCli(["attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0", "--request-id", "same-attachment-id"], deps);
  assert.equal(result.exitCode, 5);
  assert.equal(JSON.parse(result.stderr).code, "REQUEST_ID_CONFLICT");
});

test("update, status, archive, and restore pass expectedVersion and return the new version", async () => {
  const { deps, remote } = fixture();
  const updated = JSON.parse((await runTicketCli(["update", "TKT-0007", "--description", "Fixed text", "--expected-version", "0"], deps)).stdout);
  assert.equal(updated.ticket.version, 1);
  assert.equal(remote.calls.find((call) => call.method === "update")?.args[2] && (remote.calls.find((call) => call.method === "update")?.args[2] as { expectedVersion: number }).expectedVersion, 0);
  const status = JSON.parse((await runTicketCli(["status", "TKT-0007", "--status", "resolved", "--expected-version", "1"], deps)).stdout);
  assert.equal(status.ticket.status, "resolved");
  const archived = JSON.parse((await runTicketCli(["archive", "TKT-0007", "--expected-version", "2"], deps)).stdout);
  assert.equal(archived.ticket.archived, true);
  const restored = JSON.parse((await runTicketCli(["restore", "TKT-0007", "--expected-version", "3"], deps)).stdout);
  assert.equal(restored.ticket.archived, false);
  assert.equal(restored.ticket.version, 4);
});

test("version and authorization failures retain stable JSON and exit codes", async () => {
  const { deps } = fixture();
  const conflict = await runTicketCli(["update", "TKT-0007", "--title", "Changed", "--expected-version", "9"], deps);
  assert.equal(conflict.exitCode, EXIT.conflict);
  assert.equal(JSON.parse(conflict.stderr).code, "VERSION_CONFLICT");
  assert.match(JSON.parse(conflict.stderr).hint, /pnpm ticket get/);
  assert.equal(classifyRemoteError(new Error("STAFF_ONLY"), "dev").code, "NOT_AUTHORIZED");
  assert.equal(classifyRemoteError(new Error("TICKET_UNAVAILABLE"), "dev").code, "TICKET_NOT_FOUND");
  assert.equal(classifyRemoteError(new Error("UPLOAD_REQUEST_CONFLICT"), "dev").code, "UPLOAD_REQUEST_CONFLICT");
  assert.equal(classifyRemoteError(new Error("UPLOAD_REQUEST_CONFLICT"), "dev").exitCode, EXIT.conflict);
});

test("an attachment failure reports its generated retry id", async () => {
  const { deps } = fixture();
  deps.images.upload = async () => { throw new Error("network unavailable"); };

  const result = await runTicketCli([
    "attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0",
  ], deps);

  assert.equal(result.exitCode, EXIT.remote);
  assert.equal(JSON.parse(result.stderr).requestId, "generated-request-id");
});


test("unmapped safe server codes remain visible with remote exit 6 and no raw error details", () => {
  const error = classifyRemoteError({ data: { code: "UPLOAD_CALLBACK_NOT_CONFIGURED", secret: "private" } }, "dev");
  assert.equal(error.exitCode, 6);
  assert.equal(error.code, "REMOTE_CALL_FAILED");
  assert.equal(error.message, "The Convex deployment call failed (UPLOAD_CALLBACK_NOT_CONFIGURED).");
  assert.equal(classifyRemoteError({ data: { code: "secret token and Ticket content" } }, "dev").message, "The Convex deployment call failed.");
});

test("unmapped server failures preserve the CLI JSON error shape and exit 6", async () => {
  const { deps, remote } = fixture();
  remote.list = async () => { throw { data: { code: "STORAGE_NOT_CONFIGURED", details: "private" } }; };
  const result = await runTicketCli(["list"], deps);
  assert.equal(result.exitCode, 6);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false, code: "REMOTE_CALL_FAILED", message: "The Convex deployment call failed (STORAGE_NOT_CONFIGURED).", deployment: "dev",
  });
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("CLI reconciles lost recording and attachment responses with the same staff credential and request identity", async () => {
  const { deps, remote } = fixture();
  let recordings = 0;
  let attachments = 0;
  const recorded: unknown[] = [];
  const attached: unknown[] = [];
  remote.recordUploadedFile = async (_url, input) => {
    recorded.push(input);
    assert.equal((input as { token?: string }).token, "saved-dev-token");
    if (++recordings === 1) throw new Error("Recording response lost");
  };
  const attach = remote.attachImages.bind(remote);
  remote.attachImages = async (url, token, input) => {
    attached.push(input);
    if (++attachments === 1) { await attach(url, token, input); throw new Error("Attachment response lost"); }
  };
  const result = await runTicketCli(["attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0", "--request-id", "lost-response-request"], deps);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(recorded[0], recorded[1]);
  assert.deepEqual(attached[0], attached[1]);
  assert.equal(remote.calls.some(call => call.method === "cancelUploadIntent"), false);
  assert.equal(remote.rows[0].media.length, 1);
});

test("unknown CLI recording and attachment outcomes retain ownership without cleanup", async () => {
  for (const boundary of ["recordUploadedFile", "attachImages"] as const) {
    const { deps, remote } = fixture();
    let attempts = 0;
    remote[boundary] = async () => { attempts++; throw new Error("Response lost"); };
    const result = await runTicketCli(["attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0", "--request-id", "unknown-response-request"], deps);
    assert.equal(result.exitCode, 6);
    assert.equal(attempts, 2);
    assert.equal(JSON.parse(result.stderr).requestId, "unknown-response-request");
    assert.equal(remote.calls.some(call => call.method === "cancelUploadIntent"), false);
  }
});

test("a definitive CLI attachment rejection queues cleanup through the ownership mutation", async () => {
  const { deps, remote } = fixture();
  remote.attachImages = async () => { throw new ConvexError({ code: "VERSION_CONFLICT" }); };
  const result = await runTicketCli(["attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0", "--request-id", "rejected-response-request"], deps);
  assert.equal(result.exitCode, 5);
  assert.equal(remote.calls.at(-1)?.method, "cancelUploadIntent");
});

test("a rejected reconciliation after response loss still never authorizes CLI cleanup", async () => {
  const { deps, remote } = fixture();
  let attempts = 0;
  remote.recordUploadedFile = async () => { if (++attempts === 1) throw new Error("Response lost"); throw new ConvexError({ code: "UPLOAD_INTENT_NOT_FOUND" }); };
  const result = await runTicketCli(["attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0", "--request-id", "unresolved-recording-request"], deps);
  assert.equal(result.exitCode, 6);
  assert.match(result.stderr, /UPLOAD_WRITE_UNKNOWN/);
  assert.equal(attempts, 2);
  assert.equal(remote.calls.some(call => call.method === "cancelUploadIntent"), false);
});


test("CLI cleanup failures preserve the main rejection and expose an unknown cleanup outcome", async () => {
  const { deps, remote } = fixture();
  remote.attachImages = async () => { throw new ConvexError({ code: "VERSION_CONFLICT" }); };
  remote.cancelUploadIntent = async () => { throw new Error("private transport details"); };
  const result = await runTicketCli(["attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0"], deps);
  assert.equal(result.exitCode, 5);
  const output = JSON.parse(result.stderr);
  assert.equal(output.code, "VERSION_CONFLICT");
  assert.deepEqual(output.details, { cleanup: { outcome: "unknown" } });
  assert.doesNotMatch(result.stderr, /private transport details/);
});

test("CLI-local unknown outcomes, capitalized messages and unknown server codes never cancel uploads", async () => {
  for (const error of [remoteError("Image upload outcome is unknown"), internalError("Unexpected upload result"),
    new Error("VERSION_CONFLICT"), new ConvexError({ code: "UPLOAD_RECORDING_UNKNOWN" })]) {
    const { deps, remote } = fixture();
    deps.images.upload = async () => { throw error; };
    const result = await runTicketCli(["attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0"], deps);
    assert.notEqual(result.exitCode, 0);
    assert.equal(remote.calls.some(call => call.method === "cancelUploadIntent"), false);
  }
});

test("a Ticket re-read failure after committed CLI attachment never retries the mutation or cancels", async () => {
  const originalQuery = ConvexHttpClient.prototype.query;
  const originalMutation = ConvexHttpClient.prototype.mutation;
  let attachments = 0;
  let cancellations = 0;
  ConvexHttpClient.prototype.query = async (reference, ..._args) => {
    if (getFunctionName(reference) === "identity:viewer") return { kind: "staff", staffId: "staff", role: "staff", name: "Staff", email: "staff@example.com" } as never;
    if (attachments) throw new ConvexError({ code: "TICKET_UNAVAILABLE" });
    return ticket() as never;
  };
  ConvexHttpClient.prototype.mutation = async (reference, ..._args) => {
    const name = getFunctionName(reference);
    if (name === "auth:refreshSession") return { kind: "rotated", tokens: { accessToken: "access", refreshToken: "refresh", refreshTokenExpiresAt: 20_000, userId: "user" } } as never;
    if (name === "uploads:createUploadIntent") return { intentId: "intent-id", secret: "secret", uploadedFiles: [] } as never;
    if (name === "uploads:recordUploadedFile") return { state: "recorded" } as never;
    if (name === "tickets:attachTicketMedia") attachments++;
    if (name === "uploads:cancelUploadIntent") cancellations++;
    return { state: "committed", version: 1 } as never;
  };
  try {
    const { deps } = fixture();
    deps.remote = new ConvexTicketRemote();
    const result = await runTicketCli(["attach", "TKT-0007", "--image", "/tmp/first.png", "--expected-version", "0"], deps);
    assert.notEqual(result.exitCode, 0);
    assert.equal(attachments, 1);
    assert.equal(cancellations, 0);
  } finally {
    ConvexHttpClient.prototype.query = originalQuery;
    ConvexHttpClient.prototype.mutation = originalMutation;
  }
});

test("queued CLI recording is a structured definitive rejection", async () => {
  const originalMutation = ConvexHttpClient.prototype.mutation;
  ConvexHttpClient.prototype.mutation = async () => ({ state: "queued", jobIds: ["job"] }) as never;
  try {
    await assert.rejects(new ConvexTicketRemote().recordUploadedFile("https://fixture.convex.cloud", {
      token: "staff", intentId: "intent-id" as never, secret: "secret",
      file: { key: "key", url: "https://fixture.invalid/file", name: "image.png", type: "image/png", size: 1 },
    }), (error: unknown) => error instanceof ConvexError && (error.data as { code: string }).code === "UPLOAD_INTENT_INVALID");
  } finally { ConvexHttpClient.prototype.mutation = originalMutation; }
});


test("every CLI transport call satisfies the real registered argument validators", async () => {
  const originalQuery = ConvexHttpClient.prototype.query;
  const originalMutation = ConvexHttpClient.prototype.mutation;
  const originalAction = ConvexHttpClient.prototype.action;
  const handlers: Record<string, Record<string, object>> = { auth: authHandlers, identity: identityHandlers, projects: projectHandlers, tickets: ticketHandlers, uploads: uploadHandlers, pages: pageHandlers };
  const called = new Set<string>();
  const invoke = (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    const [module, method] = name.split(":");
    validateArgs(handlers[module][method], args);
    called.add(name);
    if (method === "createTextTicket") return { ticket: ticket(), created: true, requestId: "request" };
    if (method === "refreshSession") return { kind: "noSession" };
    if (method === "viewer") return null;
    if (method === "startSignInWithGoogle") return { redirect: "https://accounts.google.com/", state: "state" };
    if (method === "completeSignInWithGoogle" || method === "signInLocalFixture") return { status: "error", userError: { error: "INVALID_CODE" } };
    if (method === "createUploadIntent") return { intentId: "intent-id", secret: "secret", uploadedFiles: [] };
    if (method === "recordUploadedFile") return { state: "recorded" };
    if (method === "listProjects") return [{ _id: ticket().projectId, key: "TKT" }];
    if (method === "pageTicketDetails") return { page: [ticket()], isDone: true, continueCursor: "" };
    if (method === "listTicketPages") return [];
    if (method === "revokeTicketPage") return { revoked: true };
    return ticket();
  };
  ConvexHttpClient.prototype.query = async (reference, ...args) => invoke(reference, args[0]) as never;
  ConvexHttpClient.prototype.mutation = async (reference, ...args) => invoke(reference, args[0]) as never;
  ConvexHttpClient.prototype.action = async (reference, ...args) => invoke(reference, args[0]) as never;
  try {
    const remote = new ConvexTicketRemote();
    const url = "https://fixture.convex.cloud";
    const token = "staff";
    const ref = { projectKey: "TKT", ticketNumber: 7 };
    const intent = { intentId: "intent-id" as never, secret: "secret", ticketId: undefined, uploadedFiles: [] };
    await remote.startGoogle(url, "http://127.0.0.1:4271/");
    await remote.completeGoogle(url, "code", "state");
    await remote.signInLocalFixture(url, "owner@local.test");
    await remote.refresh(url, "refresh");
    await remote.currentSession(url, token);
    await remote.logout(url, "refresh");
    await remote.list(url, token, "TKT", false);
    await remote.get(url, token, ref, false);
    await remote.create(url, token, { title: "Ticket", description: "", requestId: "request" });
    await remote.createUploadIntent(url, token, { requestId: "request", files: [] });
    await remote.recordUploadedFile(url, { ...intent, token, file: { key: "key", url: "https://fixture.invalid/file", name: "image.png", type: "image/png", size: 1 } });
    await remote.cancelUploadIntent(url, token, intent);
    await remote.attachImages(url, token, { ...intent, id: ticket()._id, requestId: "request", expectedVersion: 0, media: [] });
    await remote.update(url, token, { ref, title: "Changed", expectedVersion: 0 });
    await remote.changeStatus(url, token, { ref, status: "acknowledged", expectedVersion: 0 });
    await remote.archive(url, token, ref, 0);
    await remote.restore(url, token, ref, 0);
    await remote.listPages(url, token, ticket()._id);
    await remote.revokePage(url, token, "page-id");
    assert.equal(called.size, 20);
  } finally {
    ConvexHttpClient.prototype.query = originalQuery;
    ConvexHttpClient.prototype.mutation = originalMutation;
    ConvexHttpClient.prototype.action = originalAction;
  }
});


test("CLI read adapter consumes every Project/lifecycle page and preserves full documented output", async () => {
  const original = ConvexHttpClient.prototype.query;
  const calls: Array<{ projectId: string; lifecycle: string; cursor: string | null }> = [];
  const first = ticket();
  const second = ticket({ _id: "older-id" as never, ticketNumber: 6, _creationTime: 900, description: "Full description outside the summary excerpt" });
  const archived = ticket({ _id: "archived-id" as never, ticketNumber: 5, _creationTime: 800, lifecycle: "archived", archivedAt: 1200 });
  ConvexHttpClient.prototype.query = async (reference, ...inputs) => {
    const name = getFunctionName(reference);
    const args = inputs[0] as Record<string, unknown>;
    if (name === "projects:listProjects") return [{ _id: first.projectId, key: "TKT" }, { _id: "empty-project", key: "APP" }] as never;
    if (name === "tickets:pageTicketDetails") {
      const opts = args.paginationOpts as { cursor: string | null; numItems: number };
      assert.equal(opts.numItems, 50);
      calls.push({ projectId: String(args.projectId), lifecycle: String(args.lifecycle), cursor: opts.cursor });
      const rows = args.projectId === "empty-project" ? [] : args.lifecycle === "archived" ? [archived] : opts.cursor === null ? [first] : [second];
      return { page: rows, isDone: args.projectId === "empty-project" || args.lifecycle === "archived" || opts.cursor !== null, continueCursor: "next" } as never;
    }
    throw new Error(`Unexpected query ${name}`);
  };
  try {
    const result = await new ConvexTicketRemote().list("https://fixture.convex.cloud", "staff", undefined, true);
    assert.deepEqual(result, [first, second, archived]);
    assert.deepEqual(calls.map(call => [call.projectId, call.lifecycle, call.cursor]), [
      [first.projectId, "active", null], [first.projectId, "active", "next"], [first.projectId, "archived", null],
      ["empty-project", "active", null], ["empty-project", "archived", null],
    ]);
  } finally { ConvexHttpClient.prototype.query = original; }
});

function pageFolder(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ticket-page-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test("page commands parse as registry subcommands with help and discovery", () => {
  assert.deepEqual(parseTicketArgs(["page", "publish", "pos-0007", "./site", "--entry", "docs/a.html", "--request-id", " retry-1 "]), {
    kind: "pagePublish", deployment: "dev", ref: { projectKey: "POS", ticketNumber: 7 }, source: "./site", entry: "docs/a.html", requestId: "retry-1",
  });
  assert.deepEqual(parseTicketArgs(["page", "list", "POS-0007", "--prod"]), { kind: "pageList", deployment: "prod", ref: { projectKey: "POS", ticketNumber: 7 } });
  assert.deepEqual(parseTicketArgs(["page", "revoke", "POS-0007", "--page", "abc"]), { kind: "pageRevoke", deployment: "dev", ref: { projectKey: "POS", ticketNumber: 7 }, pageId: "abc" });
  assert.deepEqual(parseTicketArgs(["page", "publish", "--help"]), { kind: "help", command: "page publish" });
  assert.deepEqual(parseTicketArgs(["help", "page", "publish"]), { kind: "help", command: "page publish" });
  assert.match(humanHelp("page publish"), /pnpm ticket page publish <KEY-####> <path> \[options\]/);
  for (const argv of [["page"], ["page", "publish", "POS-0007"], ["page", "revoke", "POS-0007"], ["page", "bogus"]]) {
    assert.throws(() => parseTicketArgs(argv), (error: TicketCliError) => error.exitCode === EXIT.usage, argv.join(" "));
  }
});

test("page publish reads a nested folder, validates locally and reports the link and retry id", async () => {
  const dir = pageFolder({ "docs/report.html": "<link href='../assets/a.css'>", "assets/a.css": "body{}", "assets/f.woff2": "font", ".DS_Store": "x" });
  try {
    const { deps, remote } = fixture();
    const ambiguous = pageFolder({ "a.html": "a", "b.html": "b" });
    const first = await runTicketCli(["page", "publish", "TKT-0007", ambiguous], deps);
    rmSync(ambiguous, { recursive: true, force: true });
    assert.equal(first.exitCode, EXIT.invalidInput);
    assert.equal(JSON.parse(first.stderr).code, "PAGE_ENTRY_REQUIRED");
    assert.equal(remote.calls.length, 0);

    const outcome = await runTicketCli(["page", "publish", "TKT-0007", dir, "--entry", "docs/report.html"], deps);
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.deepEqual(JSON.parse(outcome.stdout), { ok: true, deployment: "dev", ticket: "TKT-0007", url: "https://site.example/p/key/index.html",
      pageId: "page-id", entry: "docs/report.html", fileCount: 3, totalBytes: 39, created: true, requestId: "generated-request-id" });
    const input = remote.calls.find(call => call.method === "publishPage")!.args[2] as TicketPagePublishInput;
    assert.deepEqual(input.bundle.files.map(file => file.path).sort(), ["assets/a.css", "assets/f.woff2", "docs/report.html"]);
    assert.equal(input.ticket, "TKT-0007");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("page publish rejects unsafe bundles before authentication and maps page conflicts", async () => {
  const { deps, remote, credentials } = fixture();
  credentials.values = {};
  for (const [files, code] of [[{ "index.html": "x", "notes.md": "x" }, "PAGE_FILE_TYPE_UNSUPPORTED"], [{ "only.css": "x" }, "PAGE_ENTRY_REQUIRED"]] as const) {
    const dir = pageFolder(files);
    try {
      const outcome = await runTicketCli(["page", "publish", "TKT-0007", dir], deps);
      assert.equal(outcome.exitCode, EXIT.invalidInput);
      assert.equal(JSON.parse(outcome.stderr).code, code);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  assert.equal(JSON.parse((await runTicketCli(["page", "publish", "TKT-0007", "/definitely/missing.html"], deps)).stderr).code, "PAGE_SOURCE_NOT_FOUND");
  assert.deepEqual(remote.calls, []);

  const authed = fixture();
  const dir = pageFolder({ "page.html": "<p>ok</p>" });
  try {
    authed.remote.pageError = new ConvexError({ code: "PAGE_REQUEST_CONFLICT" });
    const conflict = await runTicketCli(["page", "publish", "TKT-0007", join(dir, "page.html"), "--request-id", "same"], authed.deps);
    assert.equal(conflict.exitCode, EXIT.conflict);
    assert.deepEqual(JSON.parse(conflict.stderr), { ok: false, code: "PAGE_REQUEST_CONFLICT", message: "This request id was already used for a different page.",
      deployment: "dev", requestId: "same", hint: "Use the same --request-id only when retrying the same files." });
    authed.remote.pageError = new TypeError("fetch failed");
    const lost = await runTicketCli(["page", "publish", "TKT-0007", join(dir, "page.html")], authed.deps);
    assert.equal(lost.exitCode, EXIT.remote);
    assert.equal(JSON.parse(lost.stderr).requestId, "generated-request-id");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("page list and revoke resolve the Ticket reference and refuse pages from other Tickets", async () => {
  const { deps, remote } = fixture();
  const listed = JSON.parse((await runTicketCli(["page", "list", "TKT-0007"], deps)).stdout);
  assert.deepEqual(listed, { ok: true, deployment: "dev", ticket: "TKT-0007", count: 1, pages: remote.pages });
  assert.deepEqual(JSON.parse((await runTicketCli(["page", "revoke", "TKT-0007", "--page", "page-id"], deps)).stdout),
    { ok: true, deployment: "dev", ticket: "TKT-0007", pageId: "page-id", revoked: true });
  const other = await runTicketCli(["page", "revoke", "TKT-0007", "--page", "foreign"], deps);
  assert.equal(other.exitCode, EXIT.invalidInput);
  assert.equal(JSON.parse(other.stderr).code, "PAGE_NOT_FOUND");
  assert.equal(remote.calls.filter(call => call.method === "revokePage").length, 1);
});

test("the page transport sends one bounded multipart request with bearer and idempotency headers", async () => {
  const originalQuery = ConvexHttpClient.prototype.query;
  const originalFetch = globalThis.fetch;
  let sent: { url: string; init: RequestInit } | undefined;
  ConvexHttpClient.prototype.query = async (reference, ...args) => {
    assert.equal(getFunctionName(reference), "pages:publishTarget");
    validateArgs(pageHandlers.publishTarget, args[0]);
    return { siteUrl: "https://fixture.convex.site" } as never;
  };
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), init: init! };
    return new Response(JSON.stringify({ ok: true, ticket: "TKT-0007", url: "u", pageId: "p", entry: "a b.html", fileCount: 2, totalBytes: 3, publishedAt: 1, created: true, requestId: "r" }), { status: 201 });
  };
  try {
    const bundle = { entry: "a b.html", totalBytes: 3, files: [{ path: "a b.html", size: 2, bytes: new Uint8Array([1, 2]) }, { path: "img/x.png", size: 1, bytes: new Uint8Array([3]) }] };
    const result = await new ConvexTicketRemote().publishPage("https://fixture.convex.cloud", "staff", { ticket: "TKT-0007", requestId: "r", bundle });
    assert.equal(result.pageId, "p");
    assert.equal(sent?.url, "https://fixture.convex.site/v1/tickets/TKT-0007/pages");
    assert.deepEqual(sent?.init.headers, { Authorization: "Bearer staff", "X-Ticket-Image-Policy": "v1", "Idempotency-Key": "r" });
    const form = sent?.init.body as FormData;
    assert.equal(form.get("entry"), "a b.html");
    assert.deepEqual(JSON.parse(String(form.get("manifest"))), [{ part: "f0", path: "a b.html" }, { part: "f1", path: "img/x.png" }]);
    assert.equal((form.get("f1") as File).size, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, code: "PAGE_TOO_LARGE" }), { status: 413 });
    await assert.rejects(new ConvexTicketRemote().publishPage("https://fixture.convex.cloud", "staff", { ticket: "TKT-0007", requestId: "r", bundle }),
      (error: ConvexError<{ code: string }>) => error.data.code === "PAGE_TOO_LARGE");
  } finally {
    ConvexHttpClient.prototype.query = originalQuery;
    globalThis.fetch = originalFetch;
  }
});
