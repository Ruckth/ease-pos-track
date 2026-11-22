import { validNoticeUrl } from "./privacy-notice";
import { z } from "zod";
import { pilotDigestPattern } from "./pilot-settings";

const digest = z.string().regex(pilotDigestPattern);
const build = z.string().regex(/^[a-f0-9]{40}$/);
// Opaque references to evidence kept in the operator's restricted store.
const evidence = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{2,159}$/);
const origin = z.string().refine(value => {
  try {
    const url = new URL(value);
    return value === url.origin && (url.protocol === "https:"
      || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  } catch { return false; }
});

export const pilotRestorePlan = z.object({
  deploymentOrigin: origin,
  previousEpoch: digest,
  snapshotEpoch: digest.nullable(),
  epoch: digest,
  snapshot: evidence,
  trafficAndDirectRpcClosed: evidence,
  egressWorkersAndCallbacksFenced: evidence,
  scheduledRetentionStopped: evidence,
  reservationsAndUnknownOutcomes: evidence,
  policyHighWaterOrDisjointNamespace: evidence,
}).strict().refine(plan => plan.previousEpoch !== plan.epoch && plan.snapshotEpoch !== plan.epoch);

const notice = z.string().url().refine(validNoticeUrl);
export const pilotPrivacyNotices = z.object({ th: notice, en: notice }).strict();
export const approvedIdentityRetention = z.object({
  challengeHours: z.literal(24), invitationDays: z.literal(30), attemptDays: z.literal(30), auditDays: z.literal(90),
}).strict();
export const approvedInboxRetention = z.object({ itemDays: z.literal(30) }).strict();

export const pilotReleaseManifest = z.object({
  deploymentOrigin: origin,
  build,
  epoch: digest,
  projects: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]{8,128}$/),
    mediaContainment: z.enum(["no-public-history", "contained"]),
    evidence,
  }).strict()).min(1).max(50),
  privacyNotices: pilotPrivacyNotices,
  identityRetention: approvedIdentityRetention,
  inboxRetention: approvedInboxRetention,
  ticketDisposal: z.object({
    // Unix milliseconds, UTC. The controller supplies the approved end date.
    deadline: z.number().int().positive().max(8_640_000_000_000_000),
    controllerDecision: evidence,
    operatorProcedure: evidence,
    syntheticRehearsal: evidence,
  }).strict(),
  rollback: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("maintenance") }).strict(),
    z.object({ mode: z.literal("compatible-build"), build, schemaCompatibility: evidence }).strict(),
  ]),
  gates: z.object({
    operatorAndBackup: evidence,
    versionLockAndReleaseSwitchInventory: evidence,
    callerInventoryAndLegacyRetirement: evidence,
    reservationsAndUnresolvedReceipts: evidence,
    namedIdentityAndSender: evidence,
    textOnly: evidence,
    manualAssignment: evidence,
    authenticatedInbox: evidence,
    privacyAndRightsApproval: evidence,
    recoveryAndRollback: evidence,
  }).strict(),
  recovery: z.object({
    plan: pilotRestorePlan,
    reconciledIdentityAndProjects: evidence,
    revokedAuthoritiesAndReenrollment: evidence,
  }).strict().optional(),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.projects.map(project => project.id)).size !== manifest.projects.length
    || (manifest.recovery && (manifest.recovery.plan.epoch !== manifest.epoch
      || manifest.recovery.plan.deploymentOrigin !== manifest.deploymentOrigin))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent pilot manifest" });
  }
});

export async function pilotManifestDigest(raw: string) {
  const bytes = new TextEncoder().encode(raw);
  if (bytes.length > 64 * 1024) throw new Error("PILOT_MANIFEST_INVALID");
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
