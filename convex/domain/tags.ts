/** Reusable staff Ticket tags and versioned tag assignment. */
import { v } from "convex/values";
import { actorFields } from "../authz";
import { tagColor } from "../schema";
import { MAX_TAG_CATALOGUE, normalizeTagIds, normalizeTagName } from "../../shared/tag-rules";
import { requireCurrentVersion } from "../../shared/ticket-state";
import { mutationOperation, queryOperation } from "./operation";
import { applyTicketChange } from "./tickets";

/** The whole catalogue in name order; creation keeps it within one bounded read. */
export const listTicketTags = queryOperation({
  args: { token: v.string() },
  handler: async (ctx) => (await ctx.db.query("ticketTags").withIndex("by_normalized_name").take(MAX_TAG_CATALOGUE))
    .map(({ _id, name, color }) => ({ _id, name, color })),
});

export const createTicketTag = mutationOperation({
  args: { token: v.string(), name: v.string(), color: tagColor },
  handler: async (ctx, args) => {
    const name = normalizeTagName(args.name);
    // The indexed read and insert share a transaction, so racing creators
    // cannot produce two tags with the same normalized name.
    const existing = await ctx.db.query("ticketTags")
      .withIndex("by_normalized_name", (q) => q.eq("normalizedName", name.normalizedName)).unique();
    if (existing) throw new Error("TAG_ALREADY_EXISTS");
    const catalogue = await ctx.db.query("ticketTags").take(MAX_TAG_CATALOGUE);
    if (catalogue.length >= MAX_TAG_CATALOGUE) throw new Error("TAG_LIMIT_REACHED");
    return await ctx.db.insert("ticketTags", { ...name, color: args.color, createdBy: ctx.session._id, createdAt: Date.now() });
  },
});

/** Replaces a Ticket's tag set: one version bump and one `tags_changed` event. */
export const setTicketTags = mutationOperation({
  args: { token: v.string(), id: v.id("tickets"), tagIds: v.array(v.id("ticketTags")), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.lifecycle !== "active") throw new Error("TICKET_UNAVAILABLE");
    const version = requireCurrentVersion(doc, args.expectedVersion);
    const tagIds = normalizeTagIds(args.tagIds);
    for (const id of tagIds) {
      if (!(await ctx.db.get(id))) throw new Error("TAG_NOT_FOUND");
    }
    if (JSON.stringify(tagIds) === JSON.stringify(normalizeTagIds(doc.tagIds ?? []))) return { eventId: null, version };
    return await applyTicketChange(ctx, {
      doc,
      expectedVersion: args.expectedVersion,
      changes: { tagIds },
      action: "tags_changed",
      author: { sessionId: ctx.session._id, ...actorFields(ctx.actor) },
      now: Date.now(),
    });
  },
});
