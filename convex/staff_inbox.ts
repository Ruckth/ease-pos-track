import { activeDeploymentProject } from "./pilot_access";
import { routingStaffForSession, type RoutingDb } from "./domain/routing_identity";
import type { Doc } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { staffQuery, staffMutation } from "./functions";
import { categoryEnabled, setStaffPreference, staffInboxReader, staffPreferences } from "./domain/staff_inbox";
import { requireUsableProject } from "./domain/projects";

// The admitted session's named staff member is the inbox recipient.
async function recipient(ctx: RoutingDb, session: Doc<"sessionAdmissions">) {
  const staff = await routingStaffForSession(ctx, session);
  return staff?.active ? staff.staffId : null;
}

const projectArgs = { projectId: v.id("projects") };

export const page = staffQuery({
  name: "staff_inbox:page", args: { ...projectArgs, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const staffId = await recipient(ctx, ctx.session);
    const project = await activeDeploymentProject(ctx, args.projectId);
    if (!staffId || !project) return { page: [], isDone: true, continueCursor: "" };
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 50) throw new Error("INVALID_INPUT");
    const visible = await staffInboxReader(ctx, args.projectId, staffId);
    const rows = await ctx.db.query("staffInbox").withIndex("by_recipient", q =>
      q.eq("projectId", args.projectId).eq("staffId", staffId)).order("desc")
      .paginate({ ...args.paginationOpts, maximumRowsRead: 50 });
    const results = await Promise.all(rows.page.map(async item => {
      const ticket = await visible(item);
      return ticket && { id: item._id, ticketId: ticket._id, number: ticket.ticketNumber, title: ticket.title,
        category: item.category, read: item.readAt !== undefined, date: item._creationTime };
    }));
    return { ...rows, page: results.filter(item => item !== null) };
  },
});

export const settings = staffQuery({
  name: "staff_inbox:settings", args: projectArgs,
  handler: async (ctx, args) => {
    const staffId = await recipient(ctx, ctx.session);
    if (!staffId) return null;
    await requireUsableProject(ctx, ctx.actor, args.projectId);
    const preference = await staffPreferences(ctx, args.projectId, staffId);
    return { intake: categoryEnabled(preference, "intake"), assignment: categoryEnabled(preference, "assignment") };
  },
});

export const setPreference = staffMutation({
  name: "staff_inbox:setPreference", args: { ...projectArgs, category: v.union(v.literal("intake"), v.literal("assignment")), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const staffId = await recipient(ctx, ctx.session);
    if (!staffId) throw new Error("NAMED_STAFF_REQUIRED");
    await requireUsableProject(ctx, ctx.actor, args.projectId);
    await setStaffPreference(ctx, args.projectId, staffId, args.category, args.enabled);
  },
});

export const markRead = staffMutation({
  name: "staff_inbox:markRead", args: { id: v.id("staffInbox") },
  handler: async (ctx, args) => {
    const staffId = await recipient(ctx, ctx.session);
    const item = await ctx.db.get(args.id);
    if (!item || !staffId || !await (await staffInboxReader(ctx, item.projectId, staffId))(item)) return false;
    if (item.readAt === undefined) await ctx.db.patch(item._id, { readAt: Date.now() });
    return true;
  },
});
