import { pilotEnvironmentKeys } from "../../shared/pilot-settings";

export const firstEpoch = "1".repeat(64);
export const nextEpoch = "2".repeat(64);
export const pilotOrigin = "http://127.0.0.1:3212";

export const releaseEvidence = (id: string, epoch = firstEpoch) => ({
  deploymentOrigin: pilotOrigin, build: "a".repeat(40), epoch,
  projects: [{ id, mediaContainment: "contained", evidence: "synthetic/containment" }],
  privacyNotices: { th: "https://privacy.example.test/th", en: "https://privacy.example.test/en" },
  identityRetention: { challengeHours: 24, invitationDays: 30, attemptDays: 30, auditDays: 90 },
  inboxRetention: { itemDays: 30 },
  rollback: { mode: "maintenance" },
  gates: {
    operatorAndBackup: "synthetic/operator-and-backup",
    versionLockAndReleaseSwitchInventory: "synthetic/version-lock",
    callerInventoryAndLegacyRetirement: "synthetic/inventory",
    reservationsAndUnresolvedReceipts: "synthetic/reservations",
    namedIdentityAndSender: "synthetic/identity",
    textOnly: "synthetic/text",
    manualAssignment: "synthetic/assignment",
    authenticatedInbox: "synthetic/inbox",
    privacyAndRightsApproval: "synthetic/privacy",
    recoveryAndRollback: "synthetic/recovery",
  },
});

export const restorePlan = {
  deploymentOrigin: pilotOrigin, previousEpoch: firstEpoch, snapshotEpoch: firstEpoch, epoch: nextEpoch,
  snapshot: "synthetic/snapshot",
  trafficAndDirectRpcClosed: "synthetic/traffic",
  egressWorkersAndCallbacksFenced: "synthetic/egress",
  scheduledRetentionStopped: "synthetic/schedule",
  reservationsAndUnknownOutcomes: "synthetic/reservations",
  policyHighWaterOrDisjointNamespace: "synthetic/namespace",
};

export function pilotSettings(epoch: string, digest: string, previousEpoch?: string) {
  return {
    ...Object.fromEntries(pilotEnvironmentKeys.map(key => [key, null])),
    TICKET_DEPLOYMENT_MODE: "named-pilot",
    TICKET_PILOT_EPOCH: epoch,
    TICKET_PILOT_PREVIOUS_EPOCH: previousEpoch ?? null,
    TICKET_PILOT_MANIFEST_SHA256: digest,
    TICKET_PILOT_TRAFFIC: "closed",
    TICKET_PILOT_INVITATIONS: "false",
    TICKET_PILOT_IDENTITY_SENDER: "false",
    MEDIA_CLEANUP_ENABLED: "false",
  };
}
