import { UTApi } from "uploadthing/server";
import { deletionOutcome, StorageConfigurationError, type Storage } from "../shared/storage.js";

type DeletionProvider = { deleteFiles(keys: string[]): Promise<{ success: boolean; deletedCount: number }> };

export function createStorage(token: string | undefined, providerFactory: (token: string) => DeletionProvider = token => new UTApi({ token })): Storage {
  if (!token) throw new StorageConfigurationError();
  let provider: DeletionProvider;
  try { provider = providerFactory(token); }
  catch { throw new StorageConfigurationError(); }
  return {
    async deleteFiles(keys) {
      if (keys.length === 0) return { outcome: "deleted" };
      try { return deletionOutcome(await provider.deleteFiles(keys), keys.length); }
      catch { return { outcome: "unknown" }; }
    },
  };
}
