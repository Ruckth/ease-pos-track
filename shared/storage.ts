import type { StorageDeletionOutcome } from "./ticket-contracts.js";

export type Storage = { deleteFiles(keys: string[]): Promise<StorageDeletionOutcome> };

export class StorageConfigurationError extends Error {
  readonly code = "STORAGE_NOT_CONFIGURED";
  constructor() { super("STORAGE_NOT_CONFIGURED"); }
}

export function deletionOutcome(result: { success: boolean; deletedCount: number }, count: number): StorageDeletionOutcome {
  // Already absent behavior has not been verified against the provider.
  return result.success && result.deletedCount === count
    ? { outcome: "deleted" } : { outcome: "unknown" };
}
