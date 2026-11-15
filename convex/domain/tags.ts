import { v } from "convex/values";
import { tagColor } from "../schema";
import { normalizeTagIds, normalizeTagName } from "../tag_rules";
import { actorFields } from "../authz";
import { requireCurrentVersion } from "../../shared/ticket-state";
import { mutationOperation, queryOperation } from "./operation";
import { applyTicketChange } from "./tickets";

export const listTicketTags = queryOperation({
  args: { token: v.string() },
  handler: async ctx => (await ctx.db.query("ticketTags").withIndex("by_normalized_name").collect())
    .map(({ _id, name, color }) => ({ _id, name, color })),
});

export const createTicketTag = mutationOperation({
  args: { token: v.string(), name: v.string(), color: tagColor },
  handler: async (ctx, args) => {
    const name = normalizeTagName(args.name);
    const existing = await ctx.db.query("ticketTags")
      .withIndex("by_normalized_name", q => q.eq("normalizedName", name.normalizedName)).unique();
    if (existing) throw new Error("TAG_ALREADY_EXISTS");
    return await ctx.db.insert("ticketTags", { ...name, color: args.color, createdBy: ctx.session._id, createdAt: Date.now() });
  },
});

export const setTicketTags = mutationOperation({
  args: { token: v.string(), id: v.id("tickets"), tagIds: v.array(v.id("ticketTags")), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.lifecycle !== "active") throw new Error("TICKET_UNAVAILABLE");
    const version = requireCurrentVersion(doc, args.expectedVersion);
    const tagIds = normalizeTagIds(args.tagIds);
    for (const id of tagIds) if (!await ctx.db.get(id)) throw new Error("TAG_NOT_FOUND");
    if (JSON.stringify(tagIds) === JSON.stringify(normalizeTagIds(doc.tagIds ?? []))) return { eventId: null, version };
    return await applyTicketChange(ctx, {
      doc, expectedVersion: args.expectedVersion, changes: { tagIds }, action: "tags_changed",
      author: { sessionId: ctx.session._id, ...actorFields(ctx.actor) }, now: Date.now(),
    });
  },
});
