import { v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { audit, replaceCustomerPassword } from "./domain/identity";
import { internalJobMutation, internalJobQuery } from "./functions";
import { requireIdentityRestore } from "./identity_recovery_access";
import { checkNewPassword, constantTimeEquals } from "./identity_rules";
import {
  approveRestoreValues, verifyRestoreValues, decryptRestorePassword, restoreHexKey, restoreReference, signRestoreAttestation, type RestorePasswordBinding,
} from "../shared/identity-restore-crypto";

const CASE_TTL_MS = 60 * 60 * 1000;
const deployment = () => process.env.CONVEX_CLOUD_URL ?? "";

function restoreOperators() {
  const verifier = { id: process.env.IDENTITY_RESTORE_VERIFIER_ID, key: process.env.IDENTITY_RESTORE_VERIFIER_KEY };
  const reviewer = { id: process.env.IDENTITY_RESTORE_REVIEWER_ID, key: process.env.IDENTITY_RESTORE_REVIEWER_KEY };
  const entryKey = process.env.IDENTITY_RESTORE_ENTRY_KEY;
  if (!verifier.id || !reviewer.id || !restoreReference.test(verifier.id) || !restoreReference.test(reviewer.id)
    || verifier.id.toLowerCase() === reviewer.id.toLowerCase()
    || !verifier.key || !reviewer.key || !entryKey || ![verifier.key, reviewer.key, entryKey].every(key => restoreHexKey.test(key))
    || new Set([verifier.key, reviewer.key, entryKey]).size !== 3) throw new Error("RESTORE_OPERATORS_UNAVAILABLE");
  return { verifier: { id: verifier.id, key: verifier.key }, reviewer: { id: reviewer.id, key: reviewer.key }, entryKey };
}

async function requireAttestation(key: string, signature: string, values: readonly (string | number)[]) {
  if (!restoreHexKey.test(signature) || !constantTimeEquals(signature, await signRestoreAttestation(key, values))) {
    throw new Error("RESTORE_ATTESTATION_REQUIRED");
  }
}

async function reconciledCustomer(ctx: QueryCtx, input: Pick<Doc<"customerRestoreCases">, "customerId" | "userId" | "generation" | "epoch">) {
  const customer = await ctx.db.get(input.customerId);
  const user = await ctx.db.get(input.userId);
  if (!customer || customer.status !== "active" || customer.userId !== input.userId || customer.generation !== input.generation
    || customer.credentialEpoch === input.epoch || user?.kind !== "customer" || user.customerId !== customer._id) {
    throw new Error("RESTORE_CUSTOMER_MISMATCH");
  }
  const named = await ctx.runQuery(components.authUsername.public.getUserIdByUsername, { username: customer.username });
  if (named !== user._id) throw new Error("RESTORE_CUSTOMER_MISMATCH");
  return customer;
}

async function liveCase(ctx: QueryCtx, caseId: Id<"customerRestoreCases">, epoch: string) {
  await requireIdentityRestore(ctx, epoch);
  const row = await ctx.db.get(caseId);
  if (!row || row.epoch !== epoch || row.expiresAt <= Date.now() || row.completedAt !== undefined) {
    throw new Error("RESTORE_CASE_UNAVAILABLE");
  }
  return row;
}

function binding(row: Doc<"customerRestoreCases">): RestorePasswordBinding {
  return {
    deploymentOrigin: deployment(), epoch: row.epoch, caseId: row._id,
    customerId: row.customerId, userId: row.userId, generation: row.generation,
  };
}

async function approvedCase(ctx: QueryCtx, caseId: Id<"customerRestoreCases">, epoch: string) {
  const row = await liveCase(ctx, caseId, epoch);
  const operators = restoreOperators();
  if (row.approvedAt === undefined || row.verifierId !== operators.verifier.id || row.reviewerId !== operators.reviewer.id) {
    throw new Error("RESTORE_APPROVAL_REQUIRED");
  }
  const customer = await reconciledCustomer(ctx, row);
  return { row, customer, entryKey: operators.entryKey };
}

/** Verifier attests to independent proof of the person and the exact restored binding. */
export const verifyCustomer = internalJobMutation({
  name: "identity_restore:verifyCustomer",
  args: {
    epoch: v.string(), requestId: v.string(), customerId: v.id("customers"), userId: v.id("users"),
    generation: v.number(), evidenceRef: v.string(), expiresAt: v.number(), signature: v.string(),
  },
  handler: async (ctx, args) => {
    await requireIdentityRestore(ctx, args.epoch);
    const { verifier } = restoreOperators();
    const { signature, ...input } = args;
    const now = Date.now();
    if (!restoreHexKey.test(input.requestId) || !restoreReference.test(input.evidenceRef) || !Number.isSafeInteger(input.generation)
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + CASE_TTL_MS) {
      throw new Error("INVALID_RESTORE_CASE");
    }
    await requireAttestation(verifier.key, signature, verifyRestoreValues(deployment(), verifier.id, input));
    const replay = await ctx.db.query("customerRestoreCases").withIndex("by_epoch_request", q =>
      q.eq("epoch", input.epoch).eq("requestId", input.requestId)).unique();
    if (replay) throw new Error("RESTORE_CASE_REPLAY");
    const active = await ctx.db.query("customerRestoreCases").withIndex("by_epoch_customer", q =>
      q.eq("epoch", input.epoch).eq("customerId", input.customerId).gt("expiresAt", now)).first();
    if (active) throw new Error("RESTORE_CASE_EXISTS");
    await reconciledCustomer(ctx, input);
    const caseId = await ctx.db.insert("customerRestoreCases", { ...input, verifierId: verifier.id });
    await audit(ctx, "customer_restore.verified", { customerId: input.customerId, restoreCaseId: caseId });
    return { caseId };
  },
});

/** Reviewer uses a separate credential and approves this one case and binding. */
export const approveReplacement = internalJobMutation({
  name: "identity_restore:approveReplacement",
  args: { caseId: v.id("customerRestoreCases"), epoch: v.string(), signature: v.string() },
  handler: async (ctx, { caseId, epoch, signature }) => {
    const row = await liveCase(ctx, caseId, epoch);
    const { verifier, reviewer } = restoreOperators();
    if (row.approvedAt !== undefined) throw new Error("RESTORE_CASE_REPLAY");
    if (row.verifierId !== verifier.id) throw new Error("RESTORE_APPROVAL_REQUIRED");
    await requireAttestation(reviewer.key, signature, approveRestoreValues(deployment(), reviewer.id, { ...row, caseId }));
    await reconciledCustomer(ctx, row);
    await ctx.db.patch(caseId, { approvedAt: Date.now(), reviewerId: reviewer.id });
    await audit(ctx, "customer_restore.approved", { customerId: row.customerId, restoreCaseId: caseId });
    return { caseId };
  },
});

export const readCaseForReview = internalJobQuery({
  name: "identity_restore:readCaseForReview",
  args: { caseId: v.id("customerRestoreCases"), epoch: v.string() },
  handler: async (ctx, { caseId, epoch }) => {
    const row = await liveCase(ctx, caseId, epoch);
    const { customerId, userId, generation, verifierId, evidenceRef, expiresAt } = row;
    return { caseId, epoch, customerId, userId, generation, verifierId, evidenceRef, expiresAt };
  },
});

export const readReplacement = internalJobQuery({
  name: "identity_restore:readReplacement",
  args: { caseId: v.id("customerRestoreCases"), epoch: v.string() },
  handler: async (ctx, { caseId, epoch }) => {
    const { row, customer } = await approvedCase(ctx, caseId, epoch);
    return { binding: binding(row), username: customer.username };
  },
});

export const replacePassword = internalJobMutation({
  name: "identity_restore:replacePassword",
  args: { caseId: v.id("customerRestoreCases"), epoch: v.string(), envelope: v.object({ iv: v.bytes(), ciphertext: v.bytes() }) },
  handler: async (ctx, { caseId, epoch, envelope }) => {
    const { row, customer, entryKey } = await approvedCase(ctx, caseId, epoch);
    const checked = checkNewPassword(await decryptRestorePassword(entryKey, binding(row), envelope));
    if ("problem" in checked) return { success: false as const, error: checked.problem };
    const result = await replaceCustomerPassword(ctx, customer, checked.password);
    if (!result.success) return result;
    await ctx.db.patch(customer._id, { pilotEpoch: epoch, credentialEpoch: epoch, recoveryEnrollmentRequired: true });
    await ctx.db.patch(caseId, { completedAt: Date.now() });
    await audit(ctx, "customer_restore.replaced", { customerId: customer._id, restoreCaseId: caseId });
    return { success: true as const, customerId: customer._id };
  },
});
