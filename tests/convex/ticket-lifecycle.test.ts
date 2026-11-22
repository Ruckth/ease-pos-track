import { fixtures, identityTest } from "./identity-harness";
import { accessTokenSessionId } from "../../convex/identity_rules";
import fc from "fast-check";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { recordUploadHandler } from "../../server/handlers/record-upload";
import { modules } from "./modules";

const FIXTURE_DATE = new Date("2026-11-14T00:00:00Z");
const USERNAME = "alice";
const PASSWORD = "Synthetic passphrase 123";
const DESCRIPTION = "Original description";
const requestId = (slot: number) => `generated-create-${slot}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_DATE);
  vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function fixture() {
  const t = identityTest(modules);
  const { session: staff } = await t.mutation(fixtures.staff, { email: "owner@fixture.test", role: "owner" });
  const { customerId } = await t.mutation(fixtures.customer, { username: USERNAME, password: PASSWORD });
  const projectId = await t.run(({ db }) => db.insert("projects", { key: "POS", name: "Point of Sale", createdAt: Date.now(), updatedAt: Date.now() }));

  let refreshToken = "";
  const login = async () => {
    // The pinned password component allows five verifications per minute per account.
    vi.setSystemTime(Date.now() + 60_000);
    const result = await t.action(api.auth.signInWithPassword, { username: USERNAME, password: PASSWORD });
    if (result.status !== "complete") throw new Error("SIGN_IN_FAILED");
    refreshToken = result.tokens.refreshToken;
    return { token: accessTokenSessionId(result.tokens.accessToken) };
  };
  const tokens = { alice: (await login()).token, staff };
  const logout = () => t.mutation(api.auth.signOut, { refreshToken });
  // Membership is granted through the Owner's Project invitation and the
  // customer's own join, and removed by the Owner.
  const setAccess = async (allowed: boolean) => {
    if (!allowed) return await t.mutation(api.projects.removeProjectMember, { token: staff, projectId, customerId });
    const invitation = await t.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: staff, projectId });
    await t.mutation(api.identity.joinWithInvitation, { token: tokens.alice, invitation: invitation.secret });
  };
  await setAccess(true);

  const snapshot = () => t.run(async ({ db }) => ({
    tickets: await db.query("tickets").collect(),
    events: await db.query("ticketEvents").collect(),
    totals: await db.query("ticketTotals").collect(),
    counters: await db.query("ticketCounters").collect(),
    receipts: await db.query("ticketRequests").collect(),
    jobs: await db.query("mediaJobs").collect(),
  }));
  return { t, customerId, projectId, login, logout, setAccess, tokens, snapshot };
}

type Real = Awaited<ReturnType<typeof fixture>>;
type Actor = keyof Real["tokens"];
type Ticket = {
  id: Id<"tickets">;
  number: number;
  owner: Actor;
  originalTitle: string;
  titles: string[];
  initialReceipt: Doc<"ticketRequests">;
};
type Model = { access: boolean; tickets: Map<number, Ticket> };
type Step = fc.AsyncCommand<Model, Real>;

function step(name: string, run: Step["run"], check: Step["check"] = () => true): Step {
  return {
    check,
    toString: () => name,
    async run(model, real) {
      await run(model, real);
      await verify(model, real);
    },
  };
}

async function verify(model: Model, real: Real) {
  const snapshot = await real.snapshot();
  expect(snapshot.tickets).toHaveLength(model.tickets.size);
  expect(snapshot.receipts).toHaveLength(model.tickets.size);
  expect(snapshot.events).toHaveLength([...model.tickets.values()].reduce((count, ticket) => count + ticket.titles.length, 0));
  expect(snapshot.totals.map(({ projectId, status, count }) => ({ projectId, status, count }))).toEqual(
    model.tickets.size ? [{ projectId: real.projectId, status: "new", count: model.tickets.size }] : [],
  );
  expect(snapshot.counters.map(({ nextNumber }) => nextNumber)).toEqual(model.tickets.size ? [model.tickets.size + 1] : []);
  expect(snapshot.jobs).toEqual([]);

  for (const [slot, ticket] of model.tickets) {
    const version = ticket.titles.length - 1;
    const expected = {
      _id: ticket.id, ticketNumber: ticket.number, projectId: real.projectId, version,
      title: ticket.titles[version], description: DESCRIPTION, status: "new", lifecycle: "active",
    };
    expect(snapshot.tickets.find(row => row._id === ticket.id)).toMatchObject(expected);
    expect(await real.t.query(api.tickets.getTicket, { token: real.tokens.staff, id: ticket.id })).toMatchObject(expected);
    const visible = await real.t.query(api.tickets.getTicket, { token: real.tokens.alice, id: ticket.id });
    if (model.access && ticket.owner === "alice") expect(visible).toMatchObject(expected);
    else expect(visible).toBeNull();
    expect(snapshot.receipts.find(row => row.requestId === requestId(slot))).toEqual(ticket.initialReceipt);
    const events = snapshot.events.filter(row => row.ticketId === ticket.id);
    expect(events).toHaveLength(ticket.titles.length);
    for (const [index, event] of events.entries()) {
      expect(event).toMatchObject({
        action: index === 0 ? "created" : "edited",
        after: { title: ticket.titles[index], version: index },
        actorRole: ticket.owner === "alice" ? "customer" : "staff",
      });
      if (index > 0) expect(event.before).toMatchObject({ title: ticket.titles[index - 1], version: index - 1 });
    }
  }
}

function create(slot: number, actor: Actor, title: string, responseLost: boolean) {
  return step(`${responseLost ? "commitWithLostResponse" : "create"}(${slot}, ${actor}, ${title.trim()})`, async (model, real) => {
    const existing = model.tickets.get(slot);
    const before = await real.snapshot();
    const result = real.t.mutation(api.tickets.createTextTicket, {
      token: real.tokens[actor], projectKey: "POS", requestId: requestId(slot), title, description: DESCRIPTION,
    });
    if (actor === "alice" && !model.access) {
      await expect(result).rejects.toMatchObject({ data: { code: "PROJECT_NOT_FOUND" } });
    } else if (existing && existing.owner !== actor) {
      await expect(result).rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
    } else if (existing && existing.originalTitle !== title.trim()) {
      await expect(result).rejects.toMatchObject({ data: { code: "REQUEST_ID_CONFLICT" } });
    } else if (existing) {
      expect(await result).toMatchObject({
        created: false, requestId: requestId(slot),
        ticket: { _id: existing.id, ticketNumber: existing.number, title: existing.titles.at(-1) },
      });
    } else {
      const number = model.tickets.size + 1;
      const response = responseLost ? undefined : await result;
      if (response) {
        expect(response).toMatchObject({ created: true, requestId: requestId(slot), ticket: { ticketNumber: number } });
      } else {
        // Drop the reply only after the registered mutation has committed.
        await expect(result.then(() => { throw new Error("Synthetic lost create response"); }))
          .rejects.toThrow("Synthetic lost create response");
      }
      const { receipts } = await real.snapshot();
      const receipt = receipts.find(row => row.requestId === requestId(slot));
      expect(receipt).toMatchObject({
        operation: "ticket.create", projectId: real.projectId, outcome: "committed", version: 0,
        digestVersion: 1, actorRole: actor === "alice" ? "customer" : "staff",
      });
      expect(receipt?.inputDigest).toMatch(/^[\da-f]{64}$/);
      if (!receipt?.ticketId) throw new Error("Generated create has no durable Ticket identity");
      if (response) expect(response.ticket._id).toBe(receipt.ticketId);
      model.tickets.set(slot, { id: receipt.ticketId, number, owner: actor, originalTitle: title.trim(), titles: [title.trim()], initialReceipt: receipt });
      return;
    }
    expect(await real.snapshot()).toEqual(before);
  });
}

function edit(slot: number) {
  return step(`edit(${slot})`, async (model, real) => {
    const ticket = model.tickets.get(slot)!;
    const expectedVersion = ticket.titles.length - 1;
    const title = `Edited title ${expectedVersion + 1}`;
    const before = await real.snapshot();
    const edit = real.t.mutation(api.tickets.editTicket, {
      token: real.tokens[ticket.owner], id: ticket.id, title, description: DESCRIPTION, expectedVersion,
    });
    if (ticket.owner === "alice" && !model.access) {
      await expect(edit).rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" } });
      expect(await real.snapshot()).toEqual(before);
    } else {
      expect(await edit).toMatchObject({ version: expectedVersion + 1 });
      ticket.titles.push(title);
    }
  }, model => model.tickets.has(slot));
}

const slots = fc.integer({ min: 0, max: 1 });
const histories = fc.commands([
  fc.tuple(slots, fc.constantFrom<Actor>("alice", "staff"), fc.constantFrom("Original A", " Original A ", "Original B"), fc.boolean())
    .map(args => create(...args)),
  slots.map(edit),
  fc.boolean().map(allowed => step(allowed ? "grantProjectAccess" : "revokeProjectAccess", async (model, real) => {
    const before = await real.snapshot();
    await real.setAccess(allowed);
    model.access = allowed;
    expect(await real.snapshot()).toEqual(before);
  })),
  fc.constant(step("relogin", async (_model, real) => {
    const before = await real.snapshot();
    const oldToken = real.tokens.alice;
    await real.logout();
    real.tokens.alice = (await real.login()).token;
    expect(await real.t.query(api.identity.viewer, { token: oldToken })).toBeNull();
    expect(await real.t.query(api.identity.viewer, { token: real.tokens.alice })).toMatchObject({ customerId: real.customerId });
    expect(await real.snapshot()).toEqual(before);
  })),
], { maxCommands: 20, size: "large", replayPath: process.env.TICKET_LIFECYCLE_COMMAND_PATH });

test("generated create histories preserve Ticket identity and immutable replay across edits, sign-ins and Project access", async () => {
  await fc.assert(fc.asyncProperty(histories, async commands => {
    vi.setSystemTime(FIXTURE_DATE);
    const real = await fixture();
    await fc.asyncModelRun(() => ({ model: { access: true, tickets: new Map() }, real }), commands);
  }), {
    numRuns: 50,
    seed: Number(process.env.TICKET_LIFECYCLE_SEED ?? 1480752),
    path: process.env.TICKET_LIFECYCLE_PATH,
    endOnFailure: Boolean(process.env.TICKET_LIFECYCLE_PATH),
    verbose: fc.VerbosityLevel.Verbose,
  });
}, 60_000);

const storage = vi.hoisted(() => ({ deleteFiles: vi.fn(async (_keys: string[]) => ({ outcome: "deleted" })) }));
vi.mock("../../convex/adapters/storage", () => ({ createStorage: () => storage }));

const mediaCommands = fc.array(fc.constantFrom(
  "record", "unknownRecord", "attach", "cancel", "expire", "enable", "disable", "run", "replaceLease",
), { minLength: 1, maxLength: 20 });

test("generated upload histories preserve ownership through attachment, reservation and fenced cleanup", async () => {
  vi.stubEnv("UPLOAD_CALLBACK_SECRET", "synthetic-callback");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await fc.assert(fc.asyncProperty(mediaCommands, async commands => {
      storage.deleteFiles.mockClear();
      vi.setSystemTime(FIXTURE_DATE);
      vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
      const { t, tokens, projectId } = await fixture();
      const requestId = "generated-media-request";
      const file = { key: "fake-generated-media", url: "https://fixture.invalid/asset", name: "fixture.png", type: "image/png", size: 1 };
      const intent = await t.mutation(api.uploads.createUploadIntent, {
        token: tokens.alice, idempotencyKey: requestId, files: [{ name: file.name, type: file.type, size: file.size }],
      });
      const initialIntent = await t.run(ctx => ctx.db.get(intent.intentId));
      if (!initialIntent) throw new Error("Generated upload intent is missing");
      expect(initialIntent.expiresAt - initialIntent.createdAt).toBe(30 * 60_000);
      const input = { intentId: intent.intentId, secret: intent.secret, file };
      const record = () => t.mutation(api.uploads.recordUploadedFile, { ...input, callbackToken: "synthetic-callback" });
      const attach = () => t.mutation(api.tickets.createTicket, {
        token: tokens.alice, projectId, title: "Generated media Ticket", description: "", requestId,
        uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret, media: [file],
      });
      let intentState: "pending" | "cancelled" | "expiring" | "cleaned" | "attached" = "pending";
      let asset: "missing" | "pending" | "attached" | "deleting" | "deleted" = "missing";
      let jobKind: "cancellation" | "intent_expiry" | "rejected_upload" | undefined;
      let reservation: Id<"mediaJobs"> | undefined;
      let ticket: Id<"tickets"> | undefined;
      let enabled = false;
      let deferred = false;
      let providerCalls = 0;
      let attempts = 0;

      try {
        for (const command of commands) {
          switch (command) {
            case "record":
            case "unknownRecord": {
              if (command === "unknownRecord") {
                // Lose both adapter replies after the registered mutation commits.
                // Accepted files keep this distinct from definitive rejections.
                if (intentState !== "pending" && intentState !== "attached") break;
                const handler = recordUploadHandler(async args => {
                  await t.mutation(api.uploads.recordUploadedFile, args);
                  throw new Error("Synthetic lost response");
                }, "synthetic-callback");
                await expect(handler(input)).rejects.toThrow("UPLOAD_RECORDING_UNKNOWN");
              }
              if (asset === "missing") {
                asset = intentState === "pending" ? "pending" : "deleting";
                if (asset === "deleting") jobKind = "rejected_upload";
              }
              if (command === "record") {
                const result = await record();
                expect(result.state).toBe(asset === "deleting" || asset === "deleted" ? "queued" : "recorded");
              }
              break;
            }
            case "attach":
              if (intentState === "attached") expect(await attach()).toBe(ticket);
              else if (intentState !== "pending") await expect(attach()).rejects.toThrow("UPLOAD_INTENT_INVALID");
              else if (asset === "missing") await expect(attach()).rejects.toThrow("UPLOAD_INCOMPLETE");
              else {
                ticket = await attach();
                asset = "attached";
                intentState = "attached";
              }
              break;
            case "cancel":
              await t.mutation(api.uploads.cancelUploadIntent, { token: tokens.alice, intentId: intent.intentId, secret: intent.secret });
              if (intentState === "pending" || intentState === "expiring") intentState = "cancelled";
              if (asset === "pending") {
                asset = "deleting";
                jobKind = "cancellation";
              }
              break;
            case "expire":
              if (intentState === "pending") {
                vi.setSystemTime(initialIntent.expiresAt);
                expect(await t.mutation(internal.retention.expireIntents, {})).toBe(1);
                if (asset === "pending") {
                  intentState = "expiring";
                  asset = "deleting";
                  jobKind = "intent_expiry";
                } else intentState = "cleaned";
              }
              break;
            case "enable":
            case "disable":
              enabled = command === "enable";
              vi.stubEnv("MEDIA_CLEANUP_ENABLED", String(enabled));
              break;
            case "run":
              if (!reservation) break;
              if (deferred) {
                vi.setSystemTime(Date.now() + 30_000);
                deferred = false;
              }
              if (asset === "deleting") {
                if (enabled) {
                  expect(await t.mutation(internal.retention.recover, {})).toBe(1);
                  providerCalls++;
                  attempts++;
                  asset = "deleted";
                  if (intentState === "expiring") intentState = "cleaned";
                } else {
                  expect(await t.mutation(internal.retention.recover, {})).toBe(0);
                  deferred = true;
                }
              }
              await t.action(internal.media_job_actions.run, { jobId: reservation });
              break;
            case "replaceLease": {
              if (!reservation || !enabled || asset !== "deleting") break;
              if (deferred) {
                vi.setSystemTime(Date.now() + 30_000);
                deferred = false;
              }
              const old = await t.mutation(internal.retention.claim, { jobId: reservation });
              if (!old?.leaseId || !old.leaseExpiresAt) throw new Error("Expected an initial cleanup lease");
              vi.setSystemTime(old.leaseExpiresAt);
              const current = await t.mutation(internal.retention.claim, { jobId: reservation });
              if (!current?.leaseId) throw new Error("Expected a replacement cleanup lease");
              const outcome = { jobId: reservation, key: file.key, outcome: "deleted" as const };
              const before = await t.run(ctx => ctx.db.get(reservation!));
              expect(await t.mutation(internal.retention.checkpoint, { ...outcome, attempt: old.attempt, leaseId: old.leaseId })).toBe(false);
              // Exercise the lease ID independently of the attempt counter.
              expect(await t.mutation(internal.retention.checkpoint, { ...outcome, attempt: current.attempt, leaseId: old.leaseId })).toBe(false);
              expect(await t.run(ctx => ctx.db.get(reservation!))).toEqual(before);
              const response = await storage.deleteFiles([file.key]);
              expect(response.outcome).toBe("deleted");
              providerCalls++;
              const fence = { jobId: reservation, attempt: current.attempt, leaseId: current.leaseId };
              expect(await t.mutation(internal.retention.checkpoint, { ...outcome, ...fence })).toBe(true);
              expect(await t.mutation(internal.retention.advance, fence)).toBe(true);
              attempts += 2;
              asset = "deleted";
              if (intentState === "expiring") intentState = "cleaned";
              break;
            }
          }

          const snapshot = await t.run(async ({ db }) => ({
            intent: await db.get(intent.intentId), assets: await db.query("mediaAssets").collect(),
            jobs: await db.query("mediaJobs").collect(), tickets: await db.query("tickets").collect(),
            receipts: await db.query("ticketRequests").collect(),
          }));
          expect(snapshot.intent?.status).toBe(intentState);
          expect(snapshot.assets).toHaveLength(asset === "missing" ? 0 : 1);
          expect(snapshot.jobs).toHaveLength(jobKind ? 1 : 0);
          expect(snapshot.tickets).toHaveLength(ticket ? 1 : 0);
          expect(snapshot.receipts).toHaveLength(ticket ? 1 : 0);
          if (jobKind) {
            const [job] = snapshot.jobs;
            reservation ??= job._id;
            expect(job).toMatchObject({
              _id: reservation, intentId: intent.intentId, kind: jobKind, keys: [file.key],
              state: asset === "deleted" ? "completed" : "pending",
              completedKeys: asset === "deleted" ? [file.key] : [], attempt: attempts,
            });
          }
          if (asset !== "missing") {
            const [row] = snapshot.assets;
            expect(row).toMatchObject({ key: file.key, intentId: intent.intentId, lifecycle: asset, metadata: file });
            expect(row.jobId).toBe(reservation);
            expect(row.ticketId).toBe(ticket);
          }
          if (ticket) {
            expect(await t.query(api.tickets.getTicket, { token: tokens.alice, id: ticket })).toMatchObject({ media: [file] });
          }
          expect(storage.deleteFiles.mock.calls).toEqual(Array.from({ length: providerCalls }, () => [[file.key]]));
        }
      } finally {
        vi.clearAllTimers();
      }
    }), {
      numRuns: 50,
      seed: Number(process.env.TICKET_MEDIA_SEED ?? 1384987),
      path: process.env.TICKET_MEDIA_PATH,
      endOnFailure: Boolean(process.env.TICKET_MEDIA_PATH),
      verbose: fc.VerbosityLevel.Verbose,
    });
  } finally {
    vi.restoreAllMocks();
  }
}, 60_000);
