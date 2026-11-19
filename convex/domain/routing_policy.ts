import { replaceIntakeTeam } from "./staff_inbox";
import { v } from "convex/values";
import { evaluateTicketRule, ROUTING_LIMITS } from "../../shared/ticket-routing";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { area, classificationInput, rule, vocabularyEntry } from "../routing_schema";
import { mutationOperation, queryOperation } from "./operation";
import { requireRoutingStaff, routingStaffById, routingStaffDirectory, routingStaffForSession, type RoutingDb } from "./routing_identity";
import { findUsableProject, requireUsableProject } from "./projects";

export type Policy = Omit<Doc<"ticketRoutingPolicies">, "_id" | "_creationTime">;
async function loadRoutingPolicy(ctx: RoutingDb, projectId: Id<"projects">) {
  return await ctx.db.query("ticketRoutingPolicies").withIndex("by_project", q => q.eq("projectId", projectId)).unique();
}
function defaultPolicy(projectId: Id<"projects">): Policy {
  return { projectId, policyGeneration: 0, ruleRevision: 0, areas: [], products: [], symptoms: [], rules: [], intake: [] };
}
export async function currentRoutingPolicy(ctx: RoutingDb, projectId: Id<"projects">) {
  const row = await loadRoutingPolicy(ctx, projectId);
  if (!row) return defaultPolicy(projectId);
  const { _id, _creationTime, ...policy } = row;
  return policy;
}

async function writeRoutingPolicy(ctx: MutationCtx, policy: Policy) {
  const row = await loadRoutingPolicy(ctx, policy.projectId);
  if (row) await ctx.db.replace(row._id, policy);
  else await ctx.db.insert("ticketRoutingPolicies", policy);
}

async function auditRouting(ctx: MutationCtx, policy: Policy, staffId: string, operation: string, extra?: { target?: string; reason?: string }) {
  await ctx.db.insert("ticketRoutingAudit", {
    projectId: policy.projectId, policyGeneration: policy.policyGeneration, ruleRevision: policy.ruleRevision,
    staffId, operation, ...extra, createdAt: Date.now(),
  });
}

const codePattern = /^[a-z][a-z0-9_-]{0,31}$/;
function validateLabels<T extends { code: string; en: string; th: string }>(entries: T[], limit: number) {
  if (entries.length > limit || new Set(entries.map(entry => entry.code)).size !== entries.length) throw new Error("ROUTING_LIMIT");
  for (const entry of entries) {
    if (!codePattern.test(entry.code) || !entry.en.trim() || !entry.th.trim()
      || entry.en.length > 80 || entry.th.length > 80) throw new Error("INVALID_ROUTING_CONFIGURATION");
  }
}
function sameMapping(left: Policy, right: Policy) {
  const canonical = (policy: Policy) => JSON.stringify([
    policy.products.map(({ code, en, th, meaning }) => [code, en, th, meaning]).sort(),
    policy.symptoms.map(({ code, en, th, meaning }) => [code, en, th, meaning]).sort(),
    policy.areas.map(({ code, en, th, active, meaning }) => [code, en, th, active, meaning]).sort(),
    policy.rules.map(({ product, symptom, area }) => [product, symptom, area]).sort(),
  ]);
  return canonical(left) === canonical(right);
}

function allowedRuleCodes(policy: Policy) {
  return {
    products: policy.products.map(item => item.code), symptoms: policy.symptoms.map(item => item.code),
    areas: policy.areas.filter(item => item.active).map(item => item.code),
  };
}
export function routeTicket(policy: Policy, classification: Doc<"tickets">["routingClassification"]) {
  return evaluateTicketRule(classification, policy.rules, allowedRuleCodes(policy));
}

export async function validateTicketClassification(ctx: RoutingDb, projectId: Id<"projects">, input: typeof classificationInput.type) {
  const policy = await currentRoutingPolicy(ctx, projectId);
  const { products, symptoms } = allowedRuleCodes(policy);
  if ((input.product !== undefined && !products.includes(input.product))
    || (input.symptom !== undefined && !symptoms.includes(input.symptom))) throw new Error("UNKNOWN_ROUTING_CODE");
  return input;
}

async function availability(ctx: RoutingDb, projectId: Id<"projects">, staffId: string) {
  return await ctx.db.query("ticketRoutingAvailability")
    .withIndex("by_project_staff", q => q.eq("projectId", projectId).eq("staffId", staffId)).unique();
}
export async function eligibleStaff(ctx: RoutingDb, projectId: Id<"projects">, staffId: string, now: number) {
  const [staff, state] = await Promise.all([routingStaffById(ctx, staffId), availability(ctx, projectId, staffId)]);
  return Boolean(staff?.active && isAvailable(state, now));
}
function isAvailable(state: Awaited<ReturnType<typeof availability>>, now: number) {
  return state?.available !== false && (state?.awayUntil ?? 0) <= now;
}
export function rosterFor(policy: Policy, code?: string) {
  const area = policy.areas.find(item => item.active && item.code === code);
  return area && [...area.primary, ...area.fallback];
}
export async function chooseAssignee(ctx: RoutingDb, policy: Policy, code: string, now: number) {
  const roster = rosterFor(policy, code) ?? [];
  const eligibility = await Promise.all(roster.map(id => eligibleStaff(ctx, policy.projectId, id, now)));
  return roster.find((_id, index) => eligibility[index]);
}

export const getVocabulary = queryOperation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    if (!await findUsableProject(ctx, ctx.actor, projectId)) return null;
    const { products, symptoms } = await currentRoutingPolicy(ctx, projectId);
    // Safe labels for Ticket entry; descriptions, staff and policy stay internal.
    const labels = ({ code, en, th }: typeof products[number]) => ({ code, en, th });
    return { products: products.map(labels), symptoms: symptoms.map(labels) };
  },
});

export const getSettings = queryOperation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    if (!await findUsableProject(ctx, ctx.actor, projectId)) return null;
    const staff = await routingStaffForSession(ctx, ctx.session);
    if (!staff?.active) return null;
    const policy = await currentRoutingPolicy(ctx, projectId);
    const directory = await routingStaffDirectory(ctx, ROUTING_LIMITS.staff + 1);
    const now = Date.now();
    const people = await Promise.all(directory.slice(0, ROUTING_LIMITS.staff).map(async ({ staffId, name, active }) => {
      const state = await availability(ctx, projectId, staffId);
      return { staffId, name, active, available: active && isAvailable(state, now),
        acceptsAssignments: state?.available ?? true, awayUntil: state?.awayUntil };
    }));
    const own = await availability(ctx, projectId, staff.staffId);
    return {
      staffId: staff.staffId, owner: staff.role === "owner", people, directoryOverflow: directory.length > ROUTING_LIMITS.staff,
      availability: { available: own?.available ?? true, awayUntil: own?.awayUntil },
      policy: {
        policyGeneration: policy.policyGeneration, ruleRevision: policy.ruleRevision,
        areas: policy.areas, products: policy.products, symptoms: policy.symptoms,
        rules: policy.rules, intake: policy.intake, backup: policy.backup,
      },
    };
  },
});

export const saveConfiguration = mutationOperation({
  args: {
    projectId: v.id("projects"), expectedGeneration: v.number(),
    areas: v.array(area), products: v.array(vocabularyEntry), symptoms: v.array(vocabularyEntry),
    rules: v.array(rule), intake: v.array(v.string()), backup: v.string(),
  },
  handler: async (ctx, { projectId, expectedGeneration, ...configuration }) => {
    const owner = await requireRoutingStaff(ctx, ctx.session, true);
    await requireUsableProject(ctx, ctx.actor, projectId);
    const policy = await currentRoutingPolicy(ctx, projectId);
    if (expectedGeneration !== policy.policyGeneration) throw new Error("STALE_ROUTING_POLICY");
    const next = { ...policy, ...configuration };
    validateLabels(next.areas, ROUTING_LIMITS.areas);
    validateLabels(next.products, ROUTING_LIMITS.vocabulary);
    validateLabels(next.symptoms, ROUTING_LIMITS.vocabulary);
    for (const item of [...next.products, ...next.symptoms]) {
      if (!item.meaning.trim() || item.meaning.length > 140) throw new Error("INVALID_ROUTING_CONFIGURATION");
    }
    if (next.rules.length > ROUTING_LIMITS.rules || !next.intake.length || next.intake.includes(next.backup)
      || new Set(next.intake).size !== next.intake.length) throw new Error("INVALID_ROUTING_CONFIGURATION");
    const allStaff = new Set([...next.intake, next.backup]);
    for (const item of next.areas) {
      if (item.meaning !== undefined && (!item.meaning.trim() || item.meaning.length > 140)) throw new Error("INVALID_ROUTING_CONFIGURATION");
      const members = [...item.primary, ...item.fallback];
      if (members.length > ROUTING_LIMITS.staff || new Set(members).size !== members.length) throw new Error("INVALID_ROUTING_CONFIGURATION");
      members.forEach(id => allStaff.add(id));
    }
    if (allStaff.size > ROUTING_LIMITS.staff) throw new Error("ROUTING_LIMIT");
    const identities = await Promise.all(Array.from(allStaff).map(id => routingStaffById(ctx, id)));
    if (identities.some(person => !person?.active)) throw new Error("INELIGIBLE_ASSIGNEE");
    const codes = allowedRuleCodes(next);
    const distinct = new Set<string>();
    for (const item of next.rules) {
      const key = JSON.stringify([item.product, item.symptom, item.area]);
      if (distinct.has(key) || !codes.products.includes(item.product) || !codes.symptoms.includes(item.symptom)
        || !next.areas.some(area => area.code === item.area)) throw new Error("UNKNOWN_ROUTING_CODE");
      distinct.add(key);
    }
    const mappingChanged = !sameMapping(policy, next);
    next.policyGeneration++;
    if (mappingChanged) next.ruleRevision++;
    await writeRoutingPolicy(ctx, next);
    await replaceIntakeTeam(ctx, projectId, [...next.intake, next.backup]);
    await auditRouting(ctx, next, owner.staffId, mappingChanged ? "mapping_changed" : "roster_changed");
    return { policyGeneration: next.policyGeneration, ruleRevision: next.ruleRevision };
  },
});

export const setAvailability = mutationOperation({
  args: {
    projectId: v.id("projects"), staffId: v.optional(v.string()),
    available: v.boolean(), awayUntil: v.optional(v.number()), reason: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, staffId, available, awayUntil, reason }) => {
    const actor = await requireRoutingStaff(ctx, ctx.session);
    await requireUsableProject(ctx, ctx.actor, projectId);
    const target = staffId ?? actor.staffId;
    const overriding = target !== actor.staffId;
    const note = reason?.trim();
    if (overriding && actor.role !== "owner") throw new Error("OWNER_REQUIRED");
    if (overriding && (!note || note.length > 240)) throw new Error("ROUTING_REASON_REQUIRED");
    if (!(await routingStaffById(ctx, target))?.active) throw new Error("INELIGIBLE_ASSIGNEE");
    if (awayUntil !== undefined && (!Number.isSafeInteger(awayUntil) || awayUntil <= Date.now())) throw new Error("INVALID_INPUT");
    const state = await availability(ctx, projectId, target);
    if ((state?.available ?? true) === available && state?.awayUntil === awayUntil) return;
    const value = { projectId, staffId: target, available, awayUntil };
    if (state) await ctx.db.replace(state._id, value);
    else await ctx.db.insert("ticketRoutingAvailability", value);
    const policy = await currentRoutingPolicy(ctx, projectId);
    const next = { ...policy, policyGeneration: policy.policyGeneration + 1 };
    await writeRoutingPolicy(ctx, next);
    await auditRouting(ctx, next, actor.staffId, "availability_changed", { target, reason: overriding ? note : undefined });
  },
});
