import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { namedStaffMutation, namedStaffQuery } from "./functions";
import { t3EpochTag, t3Runtime } from "./t3_config";
import { t3Identity } from "./t3_identity";
import { describeKey, issueKey, ownedKey, prepareNewKey, revokeKey, rotatableKey, t3Projects } from "./domain/t3_keys";
import { t3ProofIntent } from "../shared/t3-doctor";

export const settings = namedStaffQuery({
  name: "t3_keys:settings",
  args: {},
  handler: async (ctx) => {
    const runtime = t3Runtime();
    return {
      account: ctx.namedStaff.account, owner: ctx.namedStaff.role === "owner",
      release: runtime?.release ?? null, issuing: runtime?.issuing ?? false,
      projects: runtime?.issuing ? await t3Projects(ctx, ctx.namedStaff) : [],
    };
  },
});

export const keys = namedStaffQuery({
  name: "t3_keys:keys",
  args: { team: v.boolean(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { team, paginationOpts }) => {
    const staff = ctx.namedStaff;
    if (team && staff.role !== "owner") throw new Error("OWNER_REQUIRED");
    const all = ctx.db.query("t3DoctorKeys");
    const query = team ? all : all.withIndex("by_staff_created", q => q.eq("staffId", staff.id));
    const page = await query.order("desc").paginate({ ...paginationOpts, numItems: Math.min(paginationOpts.numItems, 20) });
    const runtime = t3Runtime();
    const epochTag = runtime ? await t3EpochTag(runtime.epoch) : "";
    return { ...page, page: await Promise.all(page.page.map(async row => ({
      ...await describeKey(ctx, row, runtime, epochTag), own: row.staffId === staff.id,
    }))) };
  },
});

export const change = namedStaffMutation({
  name: "t3_keys:change",
  args: {
    change: v.union(
      v.object({ kind: v.literal("issue"), projectId: v.id("projects"), hostId: v.string(), machineLabel: v.string(),
        days: v.number(), releaseId: v.string(), combinationId: v.string() }),
      v.object({ kind: v.literal("rotate"), keyId: v.id("t3DoctorKeys"), days: v.optional(v.number()) }),
      v.object({ kind: v.literal("revoke"), keyId: v.id("t3DoctorKeys") }),
    ),
    proof: v.object({ challengeId: v.string(), code: v.string() }),
  },
  handler: async (ctx, { change, proof }) => {
    const staff = ctx.namedStaff;
    const consume = () => t3Identity.consume(ctx, staff, { ...proof, ...t3ProofIntent(change) });
    if (change.kind === "revoke") {
      const row = await ownedKey(ctx, change.keyId, staff, true);
      if (!await consume()) return { ok: false as const };
      await revokeKey(ctx, row, staff);
      return { ok: true as const };
    }
    const runtime = t3Runtime();
    if (!runtime?.issuing) throw new Error("DOCTOR_ISSUANCE_UNAVAILABLE");
    const previous = change.kind === "rotate" ? await rotatableKey(ctx, change.keyId, staff, runtime) : undefined;
    const replacement = await prepareNewKey(ctx, staff, runtime, change.kind === "issue" ? change : {
      ...previous!, days: change.days,
    }, previous);
    if (!await consume()) return { ok: false as const };
    return await issueKey(ctx, staff, runtime, replacement, previous);
  },
});
