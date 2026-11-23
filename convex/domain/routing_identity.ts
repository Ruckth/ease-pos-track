import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { namedIdentityEpoch } from "../pilot_access";

export type RoutingDb = QueryCtx | MutationCtx;
export type NamedStaff = { staffId: string; name: string; role: "owner" | "staff"; active: boolean };

async function currentEpoch(ctx: RoutingDb) {
  try { return { epoch: await namedIdentityEpoch(ctx) }; } catch { return null; }
}

function named(row: Doc<"staff">, lineage: { epoch: string | undefined } | null): NamedStaff {
  // Inside a named pilot, only staff reconciled into the current epoch are eligible.
  const reconciled = lineage !== null && (lineage.epoch === undefined || row.pilotEpoch === lineage.epoch);
  return { staffId: row._id, name: row.name, role: row.role, active: row.status === "active" && reconciled };
}

/**
 * The admitted session's durable staff ID. Protected policies already checked
 * the live session, principal and generation; current account state comes
 * from `staff` on every read, so a role or access change applies immediately.
 */
export async function routingStaffForSession(ctx: RoutingDb, session: Pick<Doc<"sessionAdmissions">, "staffId">) {
  return session.staffId ? await routingStaffById(ctx, session.staffId) : null;
}

/** Stored routing IDs are strings; normalize them against `staff` before use. */
export async function routingStaffById(ctx: RoutingDb, staffId: string): Promise<NamedStaff | null> {
  const id = ctx.db.normalizeId("staff", staffId);
  const row = id && await ctx.db.get(id);
  return row ? named(row, await currentEpoch(ctx)) : null;
}

export async function routingStaffDirectory(ctx: RoutingDb, limit: number): Promise<NamedStaff[]> {
  const lineage = await currentEpoch(ctx);
  const rows = await ctx.db.query("staff").withIndex("by_status_role", q => q.eq("status", "active")).take(limit);
  return rows.map(row => named(row, lineage)).filter(staff => staff.active).sort((a, b) => a.name.localeCompare(b.name));
}

export async function requireRoutingStaff(ctx: RoutingDb, session: Parameters<typeof routingStaffForSession>[1], owner = false) {
  const staff = await routingStaffForSession(ctx, session);
  if (!staff?.active) throw new Error("NAMED_STAFF_REQUIRED");
  if (owner && staff.role !== "owner") throw new Error("OWNER_REQUIRED");
  return staff;
}
