import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { ROUTING_LIMITS } from "../../shared/ticket-routing";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { classificationInput } from "../routing_schema";
import { hashTicketRequest, normalizeRequestId } from "../ticket_requests";
import { mutationOperation, queryOperation } from "./operation";
import { requireUsableProject } from "./projects";
import { requireRoutingStaff, type RoutingDb } from "./routing_identity";
import { chooseAssignee, currentRoutingPolicy, routeTicket, validateTicketClassification, type Policy } from "./routing_policy";
import { activeRoutingTicket, assignManually } from "./ticket_assignment";
import { requireCurrentVersion } from "../../shared/ticket-state";

type Proposal = Pick<Doc<"ticketRoutingSuggestions">,
  "source" | "projectId" | "ticketId" | "ticketVersion" | "policyGeneration" | "ruleRevision" | "area" | "reason">;
type Request = { source: Proposal["source"]; caller: string; requestId: string; inputDigest: string };

async function proposalRequest(ctx: RoutingDb, input: Request) {
  const request = await ctx.db.query("ticketRoutingSuggestionRequests").withIndex("by_caller_request", q =>
    q.eq("source", input.source).eq("caller", input.caller).eq("requestId", input.requestId)).unique();
  if (!request) return null;
  if (request.inputDigest !== input.inputDigest) throw new Error("REQUEST_ID_CONFLICT");
  const suggestion = request.suggestionId ? await ctx.db.get(request.suggestionId) : null;
  if (request.suggestionId && !suggestion) throw new Error("TICKET_UNAVAILABLE");
  return { request, suggestion };
}

async function commitProposal(ctx: MutationCtx, request: Request, input: Proposal, now: number) {
  const previous = await proposalRequest(ctx, request);
  if (previous) {
    if (!previous.suggestion) throw new Error("REQUEST_ID_CONFLICT");
    return previous.suggestion;
  }
  const { area, reason, ...key } = input;
  const canonical = await ctx.db.query("ticketRoutingSuggestions").withIndex("by_key", q =>
    q.eq("source", key.source).eq("projectId", key.projectId).eq("ticketId", key.ticketId)
      .eq("ticketVersion", key.ticketVersion).eq("policyGeneration", key.policyGeneration).eq("ruleRevision", key.ruleRevision)).unique();
  if (canonical && (canonical.area !== area || canonical.reason !== reason)) throw new Error("ROUTING_PROPOSAL_CONFLICT");
  const suggestionId = canonical?._id ?? await ctx.db.insert("ticketRoutingSuggestions", {
    ...input, requestId: request.requestId, status: "pending", createdAt: now, expiresAt: now + ROUTING_LIMITS.suggestionMs,
  });
  await ctx.db.insert("ticketRoutingSuggestionRequests", {
    ...key, caller: request.caller, requestId: request.requestId, inputDigest: request.inputDigest, suggestionId,
  });
  const suggestion = await ctx.db.get(suggestionId);
  if (!suggestion) throw new Error("TICKET_UNAVAILABLE");
  return suggestion;
}

function proposalKey(ticket: Doc<"tickets">, policy: Policy) {
  return { projectId: ticket.projectId, ticketId: ticket._id, ticketVersion: ticket.version,
    policyGeneration: policy.policyGeneration, ruleRevision: policy.ruleRevision };
}

function canSuggest(ticket: Doc<"tickets">) {
  return ticket.lifecycle === "active" && ticket.status !== "done" && ticket.assigneeStaffId === undefined
    && !ticket.assignment?.held && !ticket.assignment?.manualOverride;
}

function currentProposal(suggestion: Doc<"ticketRoutingSuggestions">, ticket: Doc<"tickets"> | null, policy: Policy, now: number) {
  if (!ticket || !canSuggest(ticket) || ticket.version !== suggestion.ticketVersion || suggestion.expiresAt <= now
    || policy.policyGeneration !== suggestion.policyGeneration || policy.ruleRevision !== suggestion.ruleRevision) return false;
  const route = routeTicket(policy, ticket.routingClassification);
  return route.kind === "match" && route.area === suggestion.area;
}

function presentProposal(suggestion: Doc<"ticketRoutingSuggestions">, ticket: Doc<"tickets">, policy: Policy, now: number) {
  const status = suggestion.status === "pending" && !currentProposal(suggestion, ticket, policy, now) ? "stale" : suggestion.status;
  return { id: suggestion._id, status, area: suggestion.area };
}

async function suggestRule(ctx: MutationCtx, request: Request, ticket: Doc<"tickets">, policy: Policy, now: number) {
  const result = routeTicket(policy, ticket.routingClassification);
  if (result.kind !== "match" || !canSuggest(ticket) || !await chooseAssignee(ctx, policy, result.area, now)) {
    await ctx.db.insert("ticketRoutingSuggestionRequests", {
      ...proposalKey(ticket, policy), source: "rule", caller: request.caller,
      requestId: request.requestId, inputDigest: request.inputDigest,
    });
    return { id: undefined, status: "manual" as const, area: undefined };
  }
  const suggestion = await commitProposal(ctx, request, {
    ...proposalKey(ticket, policy), source: "rule", area: result.area, reason: "configured_match",
  }, now);
  return presentProposal(suggestion, ticket, policy, now);
}

export const checkRule = mutationOperation({
  args: { ticketId: v.id("tickets"), expectedVersion: v.number(), requestId: v.string() },
  handler: async (ctx, { ticketId, expectedVersion, requestId }) => {
    const staff = await requireRoutingStaff(ctx, ctx.session);
    const ticket = await activeRoutingTicket(ctx, ticketId);
    await requireUsableProject(ctx, ctx.actor, ticket.projectId);
    const policy = await currentRoutingPolicy(ctx, ticket.projectId);
    const request = { source: "rule" as const, caller: staff.staffId, requestId: normalizeRequestId(requestId),
      ...await hashTicketRequest(JSON.stringify([ticket.projectId, ticketId, expectedVersion])) };
    const replay = await proposalRequest(ctx, request);
    if (replay?.suggestion) return presentProposal(replay.suggestion, ticket, policy, Date.now());
    if (replay) {
      const stale = replay.request.ticketVersion !== ticket.version || replay.request.policyGeneration !== policy.policyGeneration
        || replay.request.ruleRevision !== policy.ruleRevision;
      return { id: undefined, status: stale ? "stale" as const : "manual" as const, area: undefined };
    }
    requireCurrentVersion(ticket, expectedVersion);
    return await suggestRule(ctx, request, ticket, policy, Date.now());
  },
});

export const classify = mutationOperation({
  args: {
    ticketId: v.id("tickets"), expectedVersion: v.number(),
    value: classificationInput,
  },
  handler: async (ctx, { ticketId, expectedVersion, value }) => {
    const staff = await requireRoutingStaff(ctx, ctx.session);
    const ticket = await activeRoutingTicket(ctx, ticketId);
    await requireUsableProject(ctx, ctx.actor, ticket.projectId);
    const version = requireCurrentVersion(ticket, expectedVersion) + 1;
    await validateTicketClassification(ctx, ticket.projectId, value);
    const routingClassification = { ...value, reviewed: true };
    const now = Date.now();
    await ctx.db.patch(ticketId, { routingClassification, version, updatedAt: now });
    const policy = await currentRoutingPolicy(ctx, ticket.projectId);
    const requestId = crypto.randomUUID();
    const request = { source: "rule" as const, caller: staff.staffId, requestId, ...await hashTicketRequest(requestId) };
    return await suggestRule(ctx, request, { ...ticket, version, routingClassification }, policy, now);
  },
});

export const reviewSuggestion = mutationOperation({
  args: {
    suggestionId: v.id("ticketRoutingSuggestions"),
    decision: v.union(v.literal("accept"), v.literal("dismiss")),
  },
  handler: async (ctx, { suggestionId, decision }) => {
    const staff = await requireRoutingStaff(ctx, ctx.session);
    const suggestion = await ctx.db.get(suggestionId);
    if (!suggestion) throw new Error("ROUTING_SUGGESTION_UNAVAILABLE");
    await requireUsableProject(ctx, ctx.actor, suggestion.projectId);
    const ticket = await ctx.db.get(suggestion.ticketId);
    const policy = await currentRoutingPolicy(ctx, suggestion.projectId);
    if (suggestion.status !== "pending") return { status: suggestion.status, assignment: suggestion.assignment };
    const now = Date.now();
    if (ticket && currentProposal(suggestion, ticket, policy, now)) {
      if (decision === "dismiss") {
        await ctx.db.patch(suggestionId, { status: "dismissed", reviewer: staff.staffId });
        return { status: "dismissed" as const };
      }
      const assignee = await chooseAssignee(ctx, policy, suggestion.area, now);
      if (assignee) {
        const assignment = await assignManually(ctx, ticket, policy, suggestion.ticketVersion, {
          staffId: staff.staffId, assignee, area: suggestion.area, held: false,
        }, now);
        await ctx.db.patch(suggestionId, { status: "accepted", reviewer: staff.staffId, assignment });
        return { status: "accepted" as const, assignment };
      }
    }
    await ctx.db.patch(suggestionId, { status: "stale" });
    return { status: "stale" as const };
  },
});

export const listSuggestions = queryOperation({
  args: { projectId: v.id("projects"), policyGeneration: v.number(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { projectId, policyGeneration, paginationOpts }) => {
    await requireRoutingStaff(ctx, ctx.session);
    await requireUsableProject(ctx, ctx.actor, projectId);
    const policy = await currentRoutingPolicy(ctx, projectId);
    const now = Date.now();
    if (!Number.isInteger(paginationOpts.numItems) || paginationOpts.numItems < 1 || paginationOpts.numItems > 50) throw new Error("INVALID_INPUT");
    const page = await ctx.db.query("ticketRoutingSuggestions").withIndex("by_review", q =>
      q.eq("projectId", projectId).eq("policyGeneration", policyGeneration).eq("status", "pending"))
      .order("desc").paginate({ ...paginationOpts, maximumRowsRead: 50 });
    const visible = await Promise.all(page.page.map(async suggestion => {
      const ticket = await ctx.db.get(suggestion.ticketId);
      if (!ticket || !currentProposal(suggestion, ticket, policy, now)) return [];
      const { _id: id, area, source, expiresAt } = suggestion;
      return [{ id, ticketId: ticket._id, ticketNumber: ticket.ticketNumber, projectKey: ticket.projectKey,
        title: ticket.title, area, source, expiresAt }];
    }));
    return { ...page, page: visible.flat() };
  },
});
