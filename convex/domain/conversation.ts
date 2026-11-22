import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { requireCurrentVersion } from "../../shared/ticket-state";
import { normalizeRequestId } from "../ticket_requests";
import { readableTicket, updateTicketStatus } from "./operations";
import { requireUsableProject } from "./projects";
import { mutationOperation, queryOperation } from "./operation";

export const pageMessages = queryOperation({
  args: { id: v.id("tickets"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const ticket = await readableTicket(ctx, ctx.actor, args.id);
    const project = ticket && await ctx.db.get(ticket.projectId);
    if (!ticket?.ownerCustomerId || !project || project.archivedAt !== undefined) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 30) throw new Error("INVALID_INPUT");
    const result = await ctx.db.query("ticketMessages").withIndex("by_ticket", q => q.eq("ticketId", args.id))
      .order("desc").paginate({ ...args.paginationOpts, maximumRowsRead: 30, maximumBytesRead: 256_000 });
    return { ...result, page: result.page.map(({ _id, _creationTime, role, body }) => ({ _id, _creationTime, role, body })) };
  },
});

export const sendMessage = mutationOperation({
  args: {
    id: v.id("tickets"), body: v.string(), requestId: v.string(),
    expectedVersion: v.number(), inReplyTo: v.optional(v.id("ticketMessages")),
  },
  handler: async (ctx, args) => {
    const ticket = await readableTicket(ctx, ctx.actor, args.id);
    if (!ticket?.ownerCustomerId || ticket.lifecycle !== "active") throw new Error("TICKET_UNAVAILABLE");
    await requireUsableProject(ctx, ctx.actor, ticket.projectId);
    const body = args.body.trim();
    if (!body || body.length > 2000) throw new Error("INVALID_INPUT");
    const requestId = normalizeRequestId(args.requestId);
    const previous = await ctx.db.query("ticketMessages").withIndex("by_ticket_request", q =>
      q.eq("ticketId", args.id).eq("requestId", requestId)).unique();
    if (previous) {
      if (previous.role !== ctx.actor.role || previous.customerId !== ctx.actor.customerId ||
        previous.body !== body || previous.inReplyTo !== args.inReplyTo) throw new Error("REQUEST_ID_CONFLICT");
      return previous._id;
    }
    requireCurrentVersion(ticket, args.expectedVersion);
    if (ctx.actor.role === "customer") {
      const latest = await ctx.db.query("ticketMessages").withIndex("by_ticket", q => q.eq("ticketId", args.id)).order("desc").first();
      if (ticket.status !== "waiting" || latest?.role !== "staff" || latest._id !== args.inReplyTo) throw new Error("VERSION_CONFLICT");
    } else {
      if (args.inReplyTo || ticket.status === "done") throw new Error("INVALID_INPUT");
      await updateTicketStatus.handler(ctx, { id: args.id, status: "waiting", expectedVersion: args.expectedVersion });
    }
    return await ctx.db.insert("ticketMessages", {
      ticketId: args.id, role: ctx.actor.role, authorSessionId: ctx.session._id, customerId: ctx.actor.customerId, staffId: ctx.actor.staffId,
      body, requestId, inReplyTo: args.inReplyTo,
    });
  },
});
