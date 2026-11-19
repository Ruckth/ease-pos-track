import { defineTable } from "convex/server";
import { v } from "convex/values";

export const classificationInput = v.object({
  product: v.optional(v.string()), symptom: v.optional(v.string()), restricted: v.boolean(),
});
export const classification = v.object({
  ...classificationInput.fields, reviewed: v.boolean(),
});
const proposalSource = v.literal("rule");
export const assignment = v.object({
  area: v.optional(v.string()),
  assignee: v.optional(v.string()),
  held: v.boolean(),
  manualOverride: v.optional(v.boolean()),
  source: v.literal("manual"),
  staffId: v.string(),
  version: v.number(),
});
const namedCode = { code: v.string(), en: v.string(), th: v.string() };
export const vocabularyEntry = v.object({ ...namedCode, meaning: v.string() });
export const area = v.object({
  ...namedCode, meaning: v.optional(v.string()), active: v.boolean(), primary: v.array(v.string()), fallback: v.array(v.string()),
});
export const rule = v.object({ product: v.string(), symptom: v.string(), area: v.string() });
const routingKey = {
  projectId: v.id("projects"), ticketId: v.id("tickets"), ticketVersion: v.number(),
  policyGeneration: v.number(), ruleRevision: v.number(),
};
const assignmentReceipt = { eventId: v.id("ticketAssignmentEvents"), version: v.number() };

export const routingTables = {
  // Staff IDs below are durable `staff` IDs, normalized on every read
  // (convex/domain/routing_identity.ts).
  ticketRoutingPolicies: defineTable({
    projectId: v.id("projects"), policyGeneration: v.number(), ruleRevision: v.number(),
    areas: v.array(area), products: v.array(vocabularyEntry),
    symptoms: v.array(vocabularyEntry), rules: v.array(rule),
    intake: v.array(v.string()), backup: v.optional(v.string()),
  }).index("by_project", ["projectId"]),
  ticketRoutingAvailability: defineTable({
    projectId: v.id("projects"), staffId: v.string(), available: v.boolean(), awayUntil: v.optional(v.number()),
  }).index("by_project_staff", ["projectId", "staffId"]),
  ticketRoutingAudit: defineTable({
    projectId: v.id("projects"), staffId: v.string(), operation: v.string(),
    policyGeneration: v.number(), ruleRevision: v.number(), target: v.optional(v.string()),
    reason: v.optional(v.string()), createdAt: v.number(),
  }).index("by_project", ["projectId", "createdAt"]),
  ticketAssignmentEvents: defineTable({
    projectId: v.id("projects"), ticketId: v.id("tickets"), version: v.number(),
    staffId: v.string(), source: assignment.fields.source,
    before: v.optional(assignment), after: assignment,
    createdAt: v.number(),
  }).index("by_ticket", ["ticketId", "createdAt"]).index("by_project", ["projectId", "createdAt"]),
  ticketRoutingSuggestions: defineTable({
    ...routingKey, source: proposalSource, area: v.string(), reason: v.literal("configured_match"),
    requestId: v.string(), createdAt: v.number(), expiresAt: v.number(),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("dismissed"), v.literal("stale")),
    reviewer: v.optional(v.string()), assignment: v.optional(v.object(assignmentReceipt)),
  }).index("by_key", ["source", "projectId", "ticketId", "ticketVersion", "policyGeneration", "ruleRevision"])
    .index("by_review", ["projectId", "policyGeneration", "status", "expiresAt"])
    .index("by_ticket", ["ticketId"]),
  ticketRoutingSuggestionRequests: defineTable({
    ...routingKey, source: proposalSource, caller: v.string(), requestId: v.string(),
    inputDigest: v.string(), suggestionId: v.optional(v.id("ticketRoutingSuggestions")),
  }).index("by_caller_request", ["source", "caller", "requestId"]).index("by_ticket", ["ticketId"]),
};
