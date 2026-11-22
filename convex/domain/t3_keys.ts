import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { activeProjects, publicProject } from "./projects";
import { t3Identity, type T3Staff } from "../t3_identity";
import { t3Digest, t3EpochTag, t3Hex, t3Runtime } from "../t3_config";
import { constantTimeEquals } from "../identity_rules";
import {
  T3_DAY_MS, T3_DOCTOR_AUDIENCE, T3_DOCTOR_SCOPE, T3_KEY_LIMIT, T3_MAX_KEY_DAYS, t3HostPattern,
} from "../../shared/t3-doctor";

type Runtime = NonNullable<ReturnType<typeof t3Runtime>>;
type Key = Doc<"t3DoctorKeys">;

async function availableProject(ctx: QueryCtx, staff: T3Staff, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  return project && project.archivedAt === undefined && await t3Identity.project(ctx, staff, projectId) ? project : null;
}

export async function t3Projects(ctx: QueryCtx, staff: T3Staff) {
  const projects = await activeProjects(ctx);
  const allowed = await Promise.all(projects.map(project => t3Identity.project(ctx, staff, project._id)));
  return projects.filter((_, index) => allowed[index]).map(publicProject).sort((a, b) => a.name.localeCompare(b.name));
}

function matchesRelease(row: Key, runtime: Runtime) {
  return row.deployment === runtime.release.deployment && row.releaseId === runtime.release.id
    && runtime.release.combinations.some(combo => combo.id === row.combinationId);
}

async function liveKey(ctx: QueryCtx, row: Key, runtime: Runtime, epochTag: string) {
  if (row.revokedAt !== undefined || row.expiresAt <= Date.now() || row.epochTag !== epochTag
    || row.audience !== T3_DOCTOR_AUDIENCE || !matchesRelease(row, runtime)) return null;
  const staff = await t3Identity.staff(ctx, row.staffId);
  if (!staff || staff.generation !== row.generation) return null;
  const project = await availableProject(ctx, staff, row.projectId);
  return project ? { staff, project } : null;
}

export async function describeKey(ctx: QueryCtx, row: Key, runtime: Runtime | null, epochTag: string) {
  const project = await ctx.db.get(row.projectId);
  const holder = await t3Identity.staff(ctx, row.staffId);
  const state = row.revokedAt !== undefined ? "revoked" : row.expiresAt <= Date.now() ? "expired"
    : runtime && await liveKey(ctx, row, runtime, epochTag) ? "available" : "unavailable";
  return {
    keyId: row._id, staffId: row.staffId, machineLabel: row.machineLabel, project: project?.key ?? null,
    account: holder?.account ?? null, createdAt: row.createdAt, expiresAt: row.expiresAt, state,
  } as const;
}

function expireAfter(days: number, now: number) {
  if (!Number.isInteger(days) || days < 1 || days > T3_MAX_KEY_DAYS) throw new Error("DOCTOR_INVALID_EXPIRY");
  return now + days * T3_DAY_MS;
}

type KeyInput = Pick<Key, "projectId" | "hostId" | "machineLabel" | "releaseId" | "combinationId"> & { days?: number };
type Replacement = Pick<Key, "projectId" | "hostId" | "machineLabel" | "releaseId" | "combinationId" | "expiresAt">;

const invalidLabelCharacter = new RegExp("[\\p{Cc}\\p{Cf}]", "u");

export async function prepareNewKey(
  ctx: MutationCtx, staff: T3Staff, runtime: Runtime, input: KeyInput, previous?: Key,
): Promise<Replacement> {
  const { projectId, hostId, releaseId, combinationId, days } = input;
  const machineLabel = input.machineLabel.trim();
  if (!t3HostPattern.test(hostId) || machineLabel.length < 1 || machineLabel.length > 64
    || invalidLabelCharacter.test(machineLabel)) throw new Error("DOCTOR_INVALID_HOST");
  if (releaseId !== runtime.release.id || !runtime.release.combinations.some(combo => combo.id === combinationId)) {
    throw new Error("DOCTOR_RELEASE_UNAVAILABLE");
  }
  if (!await availableProject(ctx, staff, projectId)) throw new Error("PROJECT_NOT_FOUND");
  const now = Date.now();
  const expiresAt = days === undefined && previous ? previous.expiresAt : expireAfter(days ?? 0, now);
  if (previous && expiresAt > previous.expiresAt) throw new Error("DOCTOR_INVALID_EXPIRY");
  return { projectId, hostId, machineLabel, releaseId, combinationId, expiresAt };
}

export async function issueKey(ctx: MutationCtx, staff: T3Staff, runtime: Runtime, input: Replacement, previous?: Key) {
  const now = Date.now();
  const epochTag = await t3EpochTag(runtime.epoch);
  const rows = await ctx.db.query("t3DoctorKeys").withIndex("by_staff_active", q => q.eq("staffId", staff.id)
    .eq("generation", staff.generation).eq("epochTag", epochTag).eq("revokedAt", undefined).gt("expiresAt", now))
    .take(T3_KEY_LIMIT + 1);
  const others = rows.filter(row => row._id !== previous?._id);
  if (others.length >= T3_KEY_LIMIT) throw new Error("DOCTOR_KEY_LIMIT");
  if (others.some(row => row.hostId === input.hostId)) throw new Error("DOCTOR_HOST_ALREADY_ENROLLED");

  const selector = t3Hex(crypto.getRandomValues(new Uint8Array(16)));
  const bearer = `ted1_${selector}.${t3Hex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const digest = await t3Digest(runtime.epoch, T3_DOCTOR_AUDIENCE, runtime.release.deployment, bearer);
  const keyId = await ctx.db.insert("t3DoctorKeys", {
    ...input, selector, digest, epochTag, audience: T3_DOCTOR_AUDIENCE, deployment: runtime.release.deployment,
    staffId: staff.id, generation: staff.generation, createdAt: now,
  });
  if (previous) await revokeKey(ctx, previous, staff, keyId);
  return { ok: true as const, keyId, bearer, expiresAt: input.expiresAt };
}

export async function ownedKey(ctx: QueryCtx, keyId: Id<"t3DoctorKeys">, staff: T3Staff, allowOwnerOverride: boolean) {
  const row = await ctx.db.get(keyId);
  if (!row || (row.staffId !== staff.id && !(allowOwnerOverride && staff.role === "owner"))) {
    throw new Error("DOCTOR_KEY_UNAVAILABLE");
  }
  return row;
}

export async function rotatableKey(ctx: QueryCtx, keyId: Id<"t3DoctorKeys">, staff: T3Staff, runtime: Runtime) {
  const row = await ownedKey(ctx, keyId, staff, false);
  if (!await liveKey(ctx, row, runtime, await t3EpochTag(runtime.epoch))) throw new Error("DOCTOR_KEY_UNAVAILABLE");
  return row;
}

export async function revokeKey(ctx: MutationCtx, row: Key, staff: T3Staff, replacedKeyId?: Id<"t3DoctorKeys">) {
  if (row.revokedAt === undefined) {
    await ctx.db.patch(row._id, { revokedAt: Date.now(), revokedBy: staff.id, replacedKeyId });
  }
}

export async function verifyDoctor(ctx: QueryCtx, selector: string, digest: string) {
  const runtime = t3Runtime();
  if (!runtime) return null;
  const row = await ctx.db.query("t3DoctorKeys").withIndex("by_selector", q => q.eq("selector", selector)).unique();
  if (!row || !constantTimeEquals(row.digest, digest)) return null;
  const access = await liveKey(ctx, row, runtime, await t3EpochTag(runtime.epoch));
  if (!access) return null;
  const { staff, project } = access;
  const { id, provider, macOS, architecture, t3, cli, skill } = runtime.release.combinations.find(combo => combo.id === row.combinationId)!;
  return {
    deployment: runtime.release.deployment, releaseId: row.releaseId,
    account: { id: staff.id, name: staff.account },
    projects: [{ key: project.key, name: project.name }],
    scope: T3_DOCTOR_SCOPE, expiresAt: row.expiresAt,
    host: { id: row.hostId, label: row.machineLabel },
    compatibility: { id, provider, macOS, architecture, t3, cli, skill },
  };
}
