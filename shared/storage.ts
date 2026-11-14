import type { StorageDeletionOutcome } from "./ticket-contracts.js";

export type Storage = {
  deleteFiles(keys: string[]): Promise<StorageDeletionOutcome>;
  verifyAppKey(key: string): Promise<boolean>;
};

export type StorageProvider = {
  deleteFiles(keys: string[]): Promise<{ success: boolean; deletedCount: number }>;
  getFileUrls?(keys: string[]): Promise<{ data: readonly { key: string; url: string }[] }>;
};

export function providerStorage(provider: StorageProvider): Storage {
  return {
    async verifyAppKey(key) {
      // The authenticated per-key lookup avoids listing-order/size dependence.
      // A miss or error never authorizes deletion of a staff claim.
      if (!provider.getFileUrls) return false;
      try {
        const result = await provider.getFileUrls([key]);
        return result.data.some(file => file.key === key && file.url.startsWith("https://"));
      } catch { /* Unverified ownership is a non-deleting terminal outcome. */ }
      return false;
    },
    async deleteFiles(keys) {
      if (!keys.length) return { outcome: "deleted" };
      try { return deletionOutcome(await provider.deleteFiles(keys), keys.length); }
      catch { return { outcome: "unknown" }; }
    },
  };
}

export class StorageConfigurationError extends Error {
  readonly code = "STORAGE_NOT_CONFIGURED";
  constructor() { super("STORAGE_NOT_CONFIGURED"); }
}

function deletionOutcome(result: { success: boolean; deletedCount: number }, count: number): StorageDeletionOutcome {
  // Already absent behavior has not been verified against the provider.
  return result.success && result.deletedCount === count
    ? { outcome: "deleted" } : { outcome: "unknown" };
}
