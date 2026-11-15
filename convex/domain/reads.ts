import { isTicketSearchWithinLimits } from "../../shared/ticket-contracts";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { ticketStatus } from "../schema";
import { parseTicketReference } from "../../shared/ticket-numbers";
import { queryOperation } from "./operation";
import { requireUsableProject } from "./projects";

type PublicTag = Pick<Doc<"ticketTags">, "_id" | "name" | "color">;
export async function resolveTicketTags(ctx: QueryCtx | MutationCtx, row: Doc<"tickets">): Promise<PublicTag[]> {
  const tags = await Promise.all((row.tagIds ?? []).map(id => ctx.db.get(id)));
  return tags.flatMap(tag => tag ? [{ _id: tag._id, name: tag.name, color: tag.color }] : []);
}

export function ticketSummary(row: Doc<"tickets">, tags: PublicTag[] = []) {
  if (row.lifecycle === "purging") throw new Error("TICKET_UNAVAILABLE");
  return {
    _id: row._id, projectId: row.projectId, projectKey: row.projectKey,
    ticketNumber: row.ticketNumber, version: row.version, title: row.title,
    excerpt: Array.from(row.description).slice(0, 200).join(""), status: row.status,
    urgencyScore: row.urgencyScore, lifecycle: row.lifecycle,
    tagIds: row.tagIds ?? [], tags,
    archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
    mediaCount: row.media.length,
    annotationCount: row.annotations.filter(a => a.deletedAt === undefined).length,
  };
}

export function ticketDetail(row: Doc<"tickets">, tags: PublicTag[] = []) {
  if (row.lifecycle === "purging") throw new Error("TICKET_UNAVAILABLE");
  const { ownerCustomerId: _owner, purgeBlocked: _purge, searchText: _search, ...detail } = row;
  return { ...detail, tagIds: row.tagIds ?? [], tags, lifecycle: row.lifecycle };
}

/** One bounded row query for lanes, customer lists and staff CLI pages.
 * Equality scopes precede pagination; no post-read authorization scan.
 */
const pageTicketRows = queryOperation({
  args: {
    token: v.string(), projectId: v.id("projects"),
    lifecycle: v.union(v.literal("active"), v.literal("archived")),
    status: v.optional(ticketStatus),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const project = await requireUsableProject(ctx, ctx.actor, args.projectId);
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 50) throw new Error("INVALID_INPUT");
    // Also bound reactive pages whose endCursor spans more than numItems.
    const opts = { ...args.paginationOpts, maximumRowsRead: 50, maximumBytesRead: 1024 * 1024 };
    const query = ctx.actor.role === "customer"
      ? ctx.db.query("tickets").withIndex("by_owner_project", q => q.eq("ownerCustomerId", ctx.actor.role === "customer" ? ctx.actor.customerId : undefined)
        .eq("projectId", project._id).eq("lifecycle", args.lifecycle))
      : args.status !== undefined
        ? ctx.db.query("tickets").withIndex("by_project_lane", q => q.eq("projectId", project._id).eq("lifecycle", args.lifecycle).eq("status", args.status!))
        : ctx.db.query("tickets").withIndex("by_project_lifecycle", q => q.eq("projectId", project._id).eq("lifecycle", args.lifecycle));
    // Customer status tabs filter only their loaded summaries in the UI.
    if (ctx.actor.role === "customer" && args.status !== undefined) throw new Error("INVALID_INPUT");
    return await query.order("desc").paginate(opts);
  },
});

export const pageTickets = {
  ...pageTicketRows,
  handler: async (...args: Parameters<typeof pageTicketRows.handler>) => {
    const result = await pageTicketRows.handler(...args);
    return { ...result, page: await Promise.all(result.page.map(async row => ticketSummary(row, await resolveTicketTags(args[0], row)))) };
  },
};

/** Staff tools need full descriptions and annotation counts in one bounded read. */
export const pageTicketDetails = {
  ...pageTicketRows,
  handler: async (...args: Parameters<typeof pageTicketRows.handler>) => {
    const result = await pageTicketRows.handler(...args);
    return { ...result, page: await Promise.all(result.page.map(async row => ticketDetail(row, await resolveTicketTags(args[0], row)))) };
  },
};

export const laneTotals = queryOperation({
  args: { token: v.string(), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireUsableProject(ctx, ctx.actor, args.projectId);
    const rows = await ctx.db.query("ticketTotals").withIndex("by_project_status", q => q.eq("projectId", args.projectId)).take(5);
    return Object.fromEntries(rows.map(row => [row.status, row.count]));
  },
});

/** Convex 1.45 search pagination does not enforce maximumRows/BytesRead on
 * reactive endCursor ranges. Bound search explicitly to the top 50 matches.
 * hasMore is a lower-bound hint, never an exact search total.
 */
export const searchTickets = queryOperation({
  args: {
    token: v.string(), projectId: v.id("projects"),
    lifecycle: v.union(v.literal("active"), v.literal("archived")),
    status: v.optional(ticketStatus), search: v.string(),
  },
  handler: async (ctx, args) => {
    const project = await requireUsableProject(ctx, ctx.actor, args.projectId);
    const search = args.search.trim();
    if (!isTicketSearchWithinLimits(search)) throw new Error("INVALID_INPUT");
    if (!search.match(new RegExp("[\\p{L}\\p{N}]", "u"))) return { matches: [], hasMore: false };
    const reference = parseTicketReference(search);
    if (reference) {
      const row = await ctx.db.query("tickets").withIndex("by_project_ticket", q =>
        q.eq("projectKey", reference.projectKey).eq("ticketNumber", reference.ticketNumber)).unique();
      const visible = row && row.projectId === project._id && row.lifecycle === args.lifecycle
        && (args.status === undefined || row.status === args.status)
        && (ctx.actor.role === "staff" || row.ownerCustomerId === ctx.actor.customerId);
      if (visible) return { matches: [ticketSummary(row, await resolveTicketTags(ctx, row))], hasMore: false };
    }
    const rows = await ctx.db.query("tickets").withSearchIndex("search_text", q => {
      const scoped = q.search("searchText", search).eq("projectId", project._id).eq("lifecycle", args.lifecycle);
      const owned = ctx.actor.role === "customer" ? scoped.eq("ownerCustomerId", ctx.actor.customerId) : scoped;
      return args.status === undefined ? owned : owned.eq("status", args.status);
    }).take(51);
    return { matches: await Promise.all(rows.slice(0, 50).map(async row => ticketSummary(row, await resolveTicketTags(ctx, row)))), hasMore: rows.length > 50 };
  },
});
