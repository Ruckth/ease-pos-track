import { v } from "convex/values";
import { pilotManifestDigest, pilotReleaseManifest } from "../shared/pilot-manifest";
import { actorQuery, internalJobMutation, internalJobQuery } from "./functions";
import { hasLegacyAccess, installedPilot, requireClosedPilot, requirePilotAdmission } from "./pilot_access";

/** Runs through deployment administration with traffic and egress closed. */
export const install = internalJobMutation({
  name: "pilot_release:install",
  args: { manifest: v.string() },
  handler: async (ctx, { manifest: raw }) => {
    const settings = requireClosedPilot();
    const digest = await pilotManifestDigest(raw);
    if (digest !== settings.manifestDigest) throw new Error("PILOT_MANIFEST_MISMATCH");
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch { throw new Error("PILOT_MANIFEST_INVALID"); }
    const parsed = pilotReleaseManifest.safeParse(json);
    if (!parsed.success) throw new Error("PILOT_MANIFEST_INVALID");
    const manifest = parsed.data;
    if (manifest.ticketDisposal.deadline <= Date.now()) throw new Error("PILOT_MANIFEST_INVALID");
    if (manifest.epoch !== settings.epoch || manifest.deploymentOrigin !== process.env.CONVEX_CLOUD_URL
      || manifest.recovery?.plan.previousEpoch !== settings.previousEpoch) {
      throw new Error("PILOT_MANIFEST_MISMATCH");
    }
    const installed = await installedPilot(ctx);
    if (installed?.epoch === manifest.epoch) {
      if (installed.manifestDigest !== digest) throw new Error("PILOT_EPOCH_REUSED");
      return { epoch: installed.epoch, manifestDigest: digest };
    }
    if (installed && !manifest.recovery) throw new Error("PILOT_RESTORE_EVIDENCE_REQUIRED");
    if (manifest.recovery && manifest.recovery.plan.snapshotEpoch !== (installed?.epoch ?? null)) {
      throw new Error("PILOT_SNAPSHOT_EPOCH_MISMATCH");
    }
    const projectIds = [];
    for (const project of manifest.projects) {
      const id = ctx.db.normalizeId("projects", project.id);
      const row = id && await ctx.db.get(id);
      if (!row || row.archivedAt !== undefined) {
        throw new Error("PILOT_PROJECT_UNAVAILABLE");
      }
      if (manifest.recovery) {
        // A snapshot can contain a suggestion dismissed after backup. Invalidate every restored review.
        const policy = await ctx.db.query("ticketRoutingPolicies").withIndex("by_project", q => q.eq("projectId", row._id)).unique();
        if (policy) await ctx.db.patch(policy._id, { policyGeneration: policy.policyGeneration + 1 });
      }
      projectIds.push(row._id);
    }
    const retention = { ...manifest.identityRetention, inboxDays: manifest.inboxRetention.itemDays };
    const release = { retention, ticketDisposalDeadline: manifest.ticketDisposal.deadline, epoch: manifest.epoch, previousEpoch: settings.previousEpoch, manifestDigest: digest, deploymentOrigin: manifest.deploymentOrigin, projectIds };
    if (installed) await ctx.db.replace(installed._id, release);
    else await ctx.db.insert("pilotRelease", release);
    return { epoch: release.epoch, manifestDigest: digest };
  },
});

/** Integration point for a component or HTTP entry without database access. */
export const checkAdmission = internalJobQuery({
  name: "pilot_release:checkAdmission",
  args: {
    capability: v.union(v.literal("browser"), v.literal("invitation"), v.literal("identitySender")),
  },
  handler: async (ctx, args) => {
    const admission = await requirePilotAdmission(ctx, args.capability);
    return { epoch: admission.epoch };
  },
});

export const ticketCapabilities = actorQuery({
  name: "pilot_release:ticketCapabilities",
  args: {},
  handler: async ctx => ({ mediaEnabled: await hasLegacyAccess(ctx) }),
});
