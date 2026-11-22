import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { installedPilot, namedIdentityEpoch, requireClosedPilot, requireCurrentPilotEpoch } from "./pilot_access";
import { readPilotSettings } from "../shared/pilot-settings";

type DatabaseCtx = Pick<QueryCtx, "db">;

export async function identityRecoveryAdmission(ctx: DatabaseCtx) {
  const epoch = await namedIdentityEpoch(ctx);
  if (epoch === undefined) return undefined;
  return { epoch, restored: readPilotSettings(process.env)?.previousEpoch !== undefined };
}

export function customerCredentialIsCurrent(customer: Doc<"customers">, pilot: Awaited<ReturnType<typeof identityRecoveryAdmission>>) {
  if (!pilot) return customer.credentialEpoch === undefined;
  return customer.pilotEpoch === pilot.epoch
    && (customer.credentialEpoch === pilot.epoch || (!pilot.restored && customer.credentialEpoch === undefined));
}

/** Replacement is available between restoring a snapshot and installing the final release. */
export async function requireIdentityRestore(ctx: DatabaseCtx, epoch: string) {
  const settings = requireClosedPilot();
  requireCurrentPilotEpoch(epoch, settings.epoch);
  if (!settings.previousEpoch || (await installedPilot(ctx))?.epoch === epoch) {
    throw new Error("IDENTITY_RESTORE_QUARANTINE_REQUIRED");
  }
  return settings;
}
