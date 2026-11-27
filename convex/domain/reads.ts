import { isTicketSearchWithinLimits } from "../../shared/ticket-contracts";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { ticketStatus } from "../schema";
import { parseTicketReference } from "../../shared/ticket-numbers";
import { queryOperation } from "./operation";
import { requireRoutingStaff } from "./routing_identity";
import { legacyMediaEnabled } from "../pilot_access";
import { requireUsableProject } from "./projects";

type PublicTag = Pick<Doc<"ticketTags">, "_id" | "name" | "color">;

function ticketTagResolver(ctx: QueryCtx | MutationCtx) {
  // Share in-flight reads within this query, including IDs whose tag was deleted.
  const reads = new Map<Id<"ticketTags">, Promise<PublicTag | null>>();
  return async (row: Doc<"tickets">): Promise<PublicTag[]> => {
    const tags = await Promise.all((row.tagIds ?? []).map(id => {
      let read = reads.get(id);
      if (!read) {
        read = ctx.db.get(id).then(tag => tag && { _id: tag._id, name: tag.name, color: tag.color });
        reads.set(id, read);
      }
      return read;
    }));
    return tags.filter(tag => tag !== null);
  };
}

export function resolveTicketTags(ctx: QueryCtx | MutationCtx, row: Doc<"tickets">) {
  return ticketTagResolver(ctx)(row);
}

export function ticketExcerpt(description: string, limit = 200) {
  if (description.length <= limit) return description;
  let end = 0;
  let count = 0;
  for (const character of description) {
    end += character.length;
    if (++count === limit) break;
  }
  return description.slice(0, end);
}

type ReadRole = "staff" | "customer";

export function ticketSummary(row: Doc<"tickets">, tags: PublicTag[] = [], role: ReadRole = "staff") {
  if (row.lifecycle === "purging") throw new Error("TICKET_UNAVAILABLE");
  const mediaEnabled = legacyMediaEnabled();
  return {
    _id: row._id, projectId: row.projectId, projectKey: row.projectKey,
    ticketNumber: row.ticketNumber, version: row.version, title: row.title,
    excerpt: ticketExcerpt(row.description), status: row.status,
    ...(row.latestReply ? { latestReply: row.latestReply } : {}),
    ...(row.origin === "staff" ? { openedByStaff: true } : {}),
    ...(role === "staff" ? { urgencyScore: row.urgencyScore } : {}),
    lifecycle: row.lifecycle,
    tagIds: row.tagIds ?? [], tags,
    archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
    mediaCount: mediaEnabled ? row.media.length : 0,
    annotationCount: mediaEnabled ? row.annotations.filter(a => a.deletedAt === undefined).length : 0,
  };
}

export function ticketDetail(row: Doc<"tickets">, tags: PublicTag[] = [], role: ReadRole = "staff") {
  if (row.lifecycle === "purging") throw new Error("TICKET_UNAVAILABLE");
  const mediaEnabled = legacyMediaEnabled();
  return {
    _id: row._id, _creationTime: row._creationTime, projectId: row.projectId, projectKey: row.projectKey,
    ticketNumber: row.ticketNumber, version: row.version, title: row.title, description: row.description,
    status: row.status, lifecycle: row.lifecycle, origin: row.origin, hasCustomerOwner: !!row.ownerCustomerId,
    ...(row.latestReply ? { latestReply: row.latestReply } : {}),
    ...(role === "staff" && row.urgencyScore !== undefined ? { urgencyScore: row.urgencyScore } : {}),
    tagIds: row.tagIds ?? [], tags,
    ...(row.createdVia === undefined ? {} : { createdVia: row.createdVia }),
    ...(row.archivedAt === undefined ? {} : { archivedAt: row.archivedAt }),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(mediaEnabled && row.replyMediaKeys?.length ? { replyMediaKeys: row.replyMediaKeys } : {}),
    media: mediaEnabled ? row.media : [],
    annotations: mediaEnabled ? row.annotations : [],
  };
}

/** One bounded row query for lanes, customer lists and staff CLI pages.
 * Equality scopes precede pagination; no post-read authorization scan.
 */
const pageTicketRows = queryOperation({
  args: {
    projectId: v.id("projects"),
    lifecycle: v.union(v.literal("active"), v.literal("archived")),
    status: v.optional(ticketStatus),
    assignmentFilter: v.optional(v.union(v.literal("mine"), v.literal("unassigned"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const project = await requireUsableProject(ctx, ctx.actor, args.projectId);
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 50) throw new Error("INVALID_INPUT");
    // Also bound reactive pages whose endCursor spans more than numItems.
    const opts = { ...args.paginationOpts, maximumRowsRead: 50, maximumBytesRead: 1024 * 1024 };
    if (ctx.actor.role === "customer" && args.lifecycle !== "active") {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const named = args.assignmentFilter ? await requireRoutingStaff(ctx, ctx.session) : null;
    const assignee = args.assignmentFilter === "mine" ? named?.staffId : undefined;
    const query = ctx.actor.role === "customer"
      ? ctx.db.query("tickets").withIndex("by_owner_project", q => q.eq("ownerCustomerId", ctx.actor.role === "customer" ? ctx.actor.customerId : undefined)
        .eq("projectId", project._id).eq("lifecycle", args.lifecycle))
      : args.assignmentFilter
        ? args.status === undefined
          ? ctx.db.query("tickets").withIndex("by_project_assignee", q => q.eq("projectId", project._id)
            .eq("lifecycle", args.lifecycle).eq("assigneeStaffId", assignee))
          : ctx.db.query("tickets").withIndex("by_project_assignee_lane", q => q.eq("projectId", project._id)
            .eq("lifecycle", args.lifecycle).eq("assigneeStaffId", assignee).eq("status", args.status!))
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
  handler: async (ctx: Parameters<typeof pageTicketRows.handler>[0], args: Parameters<typeof pageTicketRows.handler>[1]) => {
    const result = await pageTicketRows.handler(ctx, args);
    const resolveTags = ticketTagResolver(ctx);
    return { ...result, page: await Promise.all(result.page.map(async row => ticketSummary(row, await resolveTags(row), ctx.actor.role))) };
  },
};

/** Staff tools need full descriptions and annotation counts in one bounded read. */
export const pageTicketDetails = {
  ...pageTicketRows,
  handler: async (ctx: Parameters<typeof pageTicketRows.handler>[0], args: Parameters<typeof pageTicketRows.handler>[1]) => {
    const result = await pageTicketRows.handler(ctx, args);
    const resolveTags = ticketTagResolver(ctx);
    return { ...result, page: await Promise.all(result.page.map(async row => ticketDetail(row, await resolveTags(row), ctx.actor.role))) };
  },
};

export const laneTotals = queryOperation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireUsableProject(ctx, ctx.actor, args.projectId);
    const rows = await ctx.db.query("ticketTotals").withIndex("by_project_status", q => q.eq("projectId", args.projectId)).take(5);
    return Object.fromEntries(rows.map(row => [row.status, row.count]));
  },
});

const SEARCH_LIMIT = 50;
const OPEN_STATUSES = ["new", "acknowledged", "in_progress", "waiting"] as const;

/** The index ranks each status independently and does not expose comparable
 * scores. Interleave equal rank positions in workflow order. Read one extra
 * candidate across all four streams to detect overflow without fetching 204 rows. */
async function mergeRankedLanes(queries: AsyncIterable<Doc<"tickets">>[]) {
  const remaining = new Set(queries.map(query => query[Symbol.asyncIterator]()));
  const rows: Doc<"tickets">[] = [];
  try {
    while (remaining.size && rows.length <= SEARCH_LIMIT) {
      const batch = Array.from(remaining).slice(0, SEARCH_LIMIT + 1 - rows.length);
      const results = await Promise.all(batch.map(stream => stream.next()));
      results.forEach((result, index) => {
        if (result.done) remaining.delete(batch[index]);
        else rows.push(result.value);
      });
    }
    return rows;
  } finally {
    await Promise.all(Array.from(remaining, stream => stream.return?.()));
  }
}

/** Convex 1.45 search pagination does not enforce maximumRows/BytesRead on
 * reactive endCursor ranges. Bound search explicitly and resolve tags only
 * on the fifty results actually returned. */
export const searchTickets = queryOperation({
  args: {
    projectId: v.id("projects"),
    lifecycle: v.union(v.literal("active"), v.literal("archived")),
    status: v.optional(ticketStatus), activeOnly: v.optional(v.boolean()), search: v.string(),
    assignmentFilter: v.optional(v.union(v.literal("mine"), v.literal("unassigned"))),
  },
  handler: async (ctx, args) => {
    const project = await requireUsableProject(ctx, ctx.actor, args.projectId);
    if (ctx.actor.role === "customer" && args.lifecycle !== "active") return { matches: [], hasMore: false };
    const named = args.assignmentFilter ? await requireRoutingStaff(ctx, ctx.session) : null;
    const assignee = args.assignmentFilter === "mine" ? named?.staffId : undefined;
    const search = args.search.trim();
    if (!isTicketSearchWithinLimits(search)) throw new Error("INVALID_INPUT");
    if (args.activeOnly && (args.lifecycle !== "active" || args.status !== undefined)) throw new Error("INVALID_INPUT");
    if (!search.match(new RegExp("[\\p{L}\\p{N}]", "u"))) return { matches: [], hasMore: false };
    const reference = parseTicketReference(search);
    if (reference) {
      const row = await ctx.db.query("tickets").withIndex("by_project_ticket", q =>
        q.eq("projectKey", reference.projectKey).eq("ticketNumber", reference.ticketNumber)).unique();
      const visible = row && row.projectId === project._id && row.lifecycle === args.lifecycle
        && (!args.activeOnly || row.status !== "done")
        && (args.status === undefined || row.status === args.status)
        && (!args.assignmentFilter || row.assigneeStaffId === assignee)
        && (ctx.actor.role === "staff" || row.ownerCustomerId === ctx.actor.customerId);
      if (visible) return { matches: [ticketSummary(row, await resolveTicketTags(ctx, row), ctx.actor.role)], hasMore: false };
    }
    const searchLane = (status?: Doc<"tickets">["status"]) => ctx.db.query("tickets").withSearchIndex("search_text", q => {
      const scoped = q.search("searchText", search).eq("projectId", project._id).eq("lifecycle", args.lifecycle);
      const owned = ctx.actor.role === "customer" ? scoped.eq("ownerCustomerId", ctx.actor.customerId) : scoped;
      const assigned = args.assignmentFilter ? owned.eq("assigneeStaffId", assignee) : owned;
      return status === undefined ? assigned : assigned.eq("status", status);
    });
    const rows = args.activeOnly
      ? await mergeRankedLanes(OPEN_STATUSES.map(searchLane))
      : await searchLane(args.status).take(SEARCH_LIMIT + 1);
    const resolveTags = ticketTagResolver(ctx);
    const matches = await Promise.all(rows.slice(0, SEARCH_LIMIT).map(async row => ticketSummary(row, await resolveTags(row), ctx.actor.role)));
    return { matches, hasMore: rows.length > SEARCH_LIMIT };
  },
});
