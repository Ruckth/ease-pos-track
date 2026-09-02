import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseTicketArgs, EXIT, HELP, TicketCliError } from "../scripts/ticket/cli";
import { COMMAND_REGISTRY, commandDiscoveryOutput } from "../scripts/ticket/registry";
import type { TicketDocument, TicketRemote } from "../scripts/ticket/remote";
import { classifyRemoteError, runTicketCli, type TicketCliDeps } from "../scripts/ticket/run";
import { toStoredTicketStatus, type TicketStatus } from "../scripts/ticket/status";
import type { ConfigStore, CredentialStore, StoredCredential, TicketConfig } from "../scripts/ticket/stores";

function ticket(overrides: Partial<TicketDocument> = {}) {
  return {
    _id: "ticket-id",
    _creationTime: 1_000,
    title: "Printer jams",
    description: "On long receipts",
    status: "new",
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

class MemoryCredentials implements CredentialStore {
  values: Partial<Record<"dev" | "prod", StoredCredential>> = {};
  async get(target: "dev" | "prod") { return this.values[target] ?? null; }
  async set(target: "dev" | "prod", value: StoredCredential) { this.values[target] = value; }
  async delete(target: "dev" | "prod") { delete this.values[target]; }
}

class FakeRemote implements TicketRemote {
  calls: Array<{ method: string; args: unknown[] }> = [];
  session: Awaited<ReturnType<TicketRemote["currentSession"]>> = { role: "staff", expiresAt: 20_000, customerId: null, email: null };
  rows = [ticket()];
  loginResult = { token: "secret-token", expiresAt: 20_000 };
  loginError: Error | null = null;

  private record(method: string, ...args: unknown[]) { this.calls.push({ method, args }); }
  async login(url: string, password: string, clientId: string) {
    this.record("login", url, password, clientId);
    if (this.loginError) throw this.loginError;
    return this.loginResult;
  }
  async currentSession(url: string, token: string) { this.record("currentSession", url, token); return this.session; }
  async logout(url: string, token: string) { this.record("logout", url, token); }
  async list(url: string, token: string, includeArchived: boolean) { this.record("list", url, token, includeArchived); return this.rows; }
  async get(url: string, token: string, ticketNumber: number, includeArchived: boolean) {
    this.record("get", url, token, ticketNumber, includeArchived);
    return this.rows.find((row) => row.ticketNumber === ticketNumber && (includeArchived || row.deletedAt === undefined)) ?? null;
  }
  async create(url: string, token: string, input: { title: string; description: string; requestId: string }) {
    this.record("create", url, token, input);
    return { ticket: this.rows[0], created: true, requestId: input.requestId };
  }
  async update(url: string, token: string, input: { ticketNumber: number; title?: string; description?: string; expectedVersion: number }) {
    this.record("update", url, token, input);
    if (input.expectedVersion !== (this.rows[0].version ?? 0)) throw new Error("VERSION_CONFLICT");
    this.rows[0] = ticket({ ...this.rows[0], ...input, version: input.expectedVersion + 1 });
    return this.rows[0];
  }
  async changeStatus(url: string, token: string, input: { ticketNumber: number; status: TicketStatus; expectedVersion: number }) {
    this.record("changeStatus", url, token, input);
    this.rows[0] = ticket({ ...this.rows[0], status: toStoredTicketStatus(input.status), version: input.expectedVersion + 1 });
    return this.rows[0];
  }
  async archive(url: string, token: string, ticketNumber: number, expectedVersion: number) {
    this.record("archive", url, token, ticketNumber, expectedVersion);
    this.rows[0] = ticket({ ...this.rows[0], deletedAt: 5_000, version: expectedVersion + 1 });
    return this.rows[0];
  }
  async restore(url: string, token: string, ticketNumber: number, expectedVersion: number) {
    this.record("restore", url, token, ticketNumber, expectedVersion);
    const { deletedAt: _deletedAt, ...active } = this.rows[0];
    this.rows[0] = ticket({ ...active, version: expectedVersion + 1 });
    return this.rows[0];
  }
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
    readPassword: async () => "hidden-password",
    newRequestId: () => "generated-request-id",
    now: () => 10_000,
    env: {},
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
  assert.equal(discovery.commands.find((command) => command.name === "login")?.interactive, "hidden-password");
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
  assert.deepEqual(parseTicketArgs(["get", "TKT-0007", "--include-archived", "--prod"]), { kind: "get", deployment: "prod", ticketNumber: 7, includeArchived: true });
  assert.deepEqual(parseTicketArgs(["status", "TKT-0007", "--status", "waiting_for_customer", "--expected-version", "2"]), { kind: "status", deployment: "dev", ticketNumber: 7, status: "waiting_for_customer", expectedVersion: 2 });
  assert.deepEqual(parseTicketArgs(["archive", "TKT-0007", "--expected-version=3"]), { kind: "archive", deployment: "dev", ticketNumber: 7, expectedVersion: 3 });
  assert.deepEqual(parseTicketArgs(["restore", "TKT-0007", "--expected-version", "4"]), { kind: "restore", deployment: "dev", ticketNumber: 7, expectedVersion: 4 });
  assert.deepEqual(parseTicketArgs(["update", "TKT-0007", "--title", " New title ", "--expected-version", "1"]), { kind: "update", deployment: "dev", ticketNumber: 7, title: "New title", expectedVersion: 1 });
});

test("parsing rejects unstable or unsafe operation inputs with stable codes", () => {
  const cases: Array<[string[], string, number]> = [
    [["wat"], "UNKNOWN_COMMAND", EXIT.usage],
    [["get", "7"], "INVALID_TICKET", EXIT.invalidInput],
    [["archive", "TKT-0007"], "EXPECTED_VERSION_REQUIRED", EXIT.usage],
    [["update", "TKT-0007", "--expected-version", "0"], "UPDATE_REQUIRED", EXIT.usage],
    [["status", "TKT-0007", "--status", "closed", "--expected-version", "0"], "INVALID_STATUS", EXIT.invalidInput],
    [["list", "--nope"], "UNKNOWN_FLAG", EXIT.usage],
  ];
  for (const [argv, code, exitCode] of cases) {
    assert.throws(() => parseTicketArgs(argv), (error: unknown) => error instanceof TicketCliError && error.code === code && error.exitCode === exitCode);
  }
});

test("create supports JSON, validates locally, and dry-run touches no config, credential, or deployment", async () => {
  const { deps, remote, config, credentials } = fixture();
  config.value = null;
  credentials.values = {};
  const parsed = parseTicketArgs(["create", "--json", '{"title":" Printer jams ","description":" Long receipts ","requestId":" req-1 "}']);
  assert.equal(parsed.kind, "create");
  if (parsed.kind === "create") assert.deepEqual(parsed.request, { title: "Printer jams", description: "Long receipts", requestId: "req-1" });

  const result = await runTicketCli(["create", "--title", "Printer jams", "--dry-run"], deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, dryRun: true, created: false, deployment: "dev",
    ticket: { title: "Printer jams", description: "", status: "new", media: [], origin: "staff", createdVia: "codex", requestId: "generated-request-id" },
  });
  assert.deepEqual(remote.calls, []);
  assert.equal(config.saves, 0);
});

test("login uses the hidden password dependency, persists URL/client id, and stores only the session credential", async () => {
  const { deps, remote, config, credentials } = fixture();
  config.value = null;
  credentials.values = {};
  deps.env.VITE_CONVEX_URL = "https://first.example.com";
  const outcome = await runTicketCli(["login"], deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(remote.calls[0].method, "login");
  assert.equal(remote.calls[0].args[0], "https://first.example.com");
  assert.equal(remote.calls[0].args[1], "hidden-password");
  assert.equal(typeof remote.calls[0].args[2], "string");
  assert.equal(config.value?.deployments.dev?.url, "https://first.example.com");
  assert.equal(config.value?.clientId.length, 36);
  assert.deepEqual(credentials.values.dev, { token: "secret-token", expiresAt: 20_000, url: "https://first.example.com" });
  assert.equal(JSON.parse(outcome.stdout).authenticated, true);
  assert.equal(JSON.stringify(config.value).includes("secret-token"), false);
});

test("login preserves server rate limiting and invalid-credential codes", async () => {
  for (const [message, code] of [["INCORRECT_PASSWORD", "INVALID_CREDENTIALS"], ["AUTH_RATE_LIMITED", "AUTH_RATE_LIMITED"]]) {
    const { deps, remote } = fixture();
    remote.loginError = new Error(message);
    const result = await runTicketCli(["login"], deps);
    assert.equal(result.exitCode, EXIT.auth);
    assert.equal(JSON.parse(result.stderr).code, code);
  }
});

test("whoami reuses a persisted session across runs and logout revokes then deletes it", async () => {
  const { deps, remote, credentials } = fixture();
  const whoami = await runTicketCli(["whoami"], deps);
  assert.deepEqual(JSON.parse(whoami.stdout), { ok: true, authenticated: true, role: "staff", deployment: "dev", url: "https://dev.example.com", expiresAt: 20_000 });
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

  const mismatch = fixture();
  mismatch.credentials.values.dev!.url = "https://other.example.com";
  assert.equal(JSON.parse((await runTicketCli(["list"], mismatch.deps)).stderr).code, "SESSION_DEPLOYMENT_MISMATCH");

  const customer = fixture();
  customer.remote.session = { role: "customer", expiresAt: 20_000, customerId: "customer", email: "a@example.com" };
  assert.equal(JSON.parse((await runTicketCli(["list"], customer.deps)).stderr).code, "NOT_AUTHORIZED");
});

test("list and get return stable Ticket JSON shapes", async () => {
  const { deps } = fixture();
  const listed = JSON.parse((await runTicketCli(["list"], deps)).stdout);
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.tickets[0], {
    id: "ticket-id", ticket: "TKT-0007", ticketNumber: 7, title: "Printer jams", description: "On long receipts",
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
  assert.deepEqual(JSON.parse(created.stdout), { ok: true, id: "ticket-id", ticket: "TKT-0007", ticketNumber: 7, status: "new", version: 0, created: true, deployment: "prod", requestId: "req-1" });
  assert.equal(classifyRemoteError(new Error("REQUEST_ID_CONFLICT"), "dev").exitCode, EXIT.conflict);
});

test("an idempotent create retry reports the original Ticket without claiming a new write", async () => {
  const { deps, remote } = fixture();
  remote.create = async (_url, _token, input) => ({ ticket: remote.rows[0], created: false, requestId: input.requestId });
  const result = await runTicketCli(["create", "--title", "Printer jams", "--description", "On long receipts", "--request-id", "same-request"], deps);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).created, false);
  assert.equal(JSON.parse(result.stdout).requestId, "same-request");
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
  assert.equal(classifyRemoteError(new Error("FEEDBACK_NOT_FOUND"), "dev").code, "TICKET_NOT_FOUND");
});
