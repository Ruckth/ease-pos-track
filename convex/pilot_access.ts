import type { Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { isLoopbackOrigin, legacyMode, readPilotSettings, retentionHeld } from "../shared/pilot-settings";

type DatabaseCtx = Pick<QueryCtx | MutationCtx, "db">;

export function legacyMediaEnabled() {
  return legacyMode(process.env, isLoopbackOrigin(process.env.CONVEX_CLOUD_URL));
}

export function requireLegacyMedia() {
  if (!legacyMediaEnabled()) throw new Error("PILOT_MEDIA_DISABLED");
}

export async function installedPilot(ctx: DatabaseCtx) {
  return await ctx.db.query("pilotRelease").unique();
}

/** A database previously admitted to the pilot cannot be opened in legacy mode. */
export async function hasLegacyAccess(ctx: DatabaseCtx) {
  return legacyMediaEnabled() && !await installedPilot(ctx);
}

export async function requireLegacyAccess(ctx: DatabaseCtx) {
  if (!await hasLegacyAccess(ctx)) throw new Error("LEGACY_ACCESS_DISABLED");
}

export async function mediaCleanupEnabled(ctx: DatabaseCtx) {
  return process.env.MEDIA_CLEANUP_ENABLED === "true" && await hasLegacyAccess(ctx);
}

export type PilotCapability = "browser" | "invitation" | "identitySender";

/** Call inside the same query or mutation that authorizes the protected operation. */
export async function requirePilotAdmission(ctx: DatabaseCtx, capability: PilotCapability = "browser") {
  const settings = readPilotSettings(process.env);
  if (!settings || settings.traffic !== "open") throw new Error("PILOT_UNAVAILABLE");
  const allowed = { browser: true, invitation: settings.invitations, identitySender: settings.identitySender };
  if (allowed[capability] !== true) throw new Error("PILOT_CAPABILITY_DISABLED");
  const installed = await installedPilot(ctx);
  if (!installed || installed.epoch !== settings.epoch || installed.manifestDigest !== settings.manifestDigest
    || installed.previousEpoch !== settings.previousEpoch || installed.deploymentOrigin !== process.env.CONVEX_CLOUD_URL) throw new Error("PILOT_UNAVAILABLE");
  return { epoch: settings.epoch, projectIds: installed.projectIds };
}

/** Treat missing lineage exactly like stale lineage. Reconciliation is a separate operator procedure. */
export function requireCurrentPilotEpoch(issuedEpoch: string | undefined, currentEpoch: string) {
  if (!issuedEpoch || issuedEpoch !== currentEpoch) throw new Error("PILOT_STALE_AUTHORITY");
}

/**
 * Named identity boundary. A legacy or disposable deployment admits named
 * sessions without pilot lineage (undefined). A named pilot requires open
 * traffic, the capability and the installed release, and returns the current
 * epoch that every issued authority is stamped with and later rechecked against.
 */
export async function namedIdentityEpoch(ctx: DatabaseCtx, capability: PilotCapability = "browser") {
  if (await hasLegacyAccess(ctx)) return undefined;
  return (await requirePilotAdmission(ctx, capability)).epoch;
}

/** Recheck an authority's stamped epoch, when a pilot epoch is in force. */
export function requireNamedEpoch(issuedEpoch: string | undefined, currentEpoch: string | undefined) {
  if (currentEpoch !== undefined) requireCurrentPilotEpoch(issuedEpoch, currentEpoch);
}

/** Stamp field for a newly issued authority. */
export function epochStamp(epoch: string | undefined) {
  return epoch === undefined ? {} : { pilotEpoch: epoch };
}

export async function projectInDeployment(ctx: DatabaseCtx, projectId: Id<"projects">) {
  if (await hasLegacyAccess(ctx)) return true;
  if (!(await requirePilotAdmission(ctx)).projectIds.includes(projectId)) return false;
  const project = await ctx.db.get(projectId);
  return !!project && project.archivedAt === undefined;
}

export async function activeDeploymentProject(ctx: DatabaseCtx, projectId: Id<"projects">) {
  if (!await hasLegacyAccess(ctx) && !(await requirePilotAdmission(ctx)).projectIds.includes(projectId)) return null;
  const project = await ctx.db.get(projectId);
  return project && project.archivedAt === undefined ? project : null;
}

/**
 * Periods an expiry job may apply now: the installed release must match the
 * current outside settings (so a restore quarantine or an older release stops
 * it), traffic is open, the release records approved periods and no operator
 * hold is set. Legacy and disposable deployments have no approval.
 */
export async function approvedRetention(ctx: DatabaseCtx) {
  if (retentionHeld(process.env)) return null;
  const settings = readPilotSettings(process.env);
  if (settings?.traffic !== "open") return null;
  const release = await installedPilot(ctx);
  if (!release?.retention || release.epoch !== settings.epoch || release.previousEpoch !== settings.previousEpoch
    || release.manifestDigest !== settings.manifestDigest || release.deploymentOrigin !== process.env.CONVEX_CLOUD_URL) return null;
  return release.retention;
}

export function requireClosedPilot() {
  const settings = readPilotSettings(process.env);
  if (!settings || settings.traffic !== "closed") throw new Error("PILOT_MAINTENANCE_REQUIRED");
  return settings;
}
