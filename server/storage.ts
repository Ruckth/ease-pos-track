import { UTApi } from "uploadthing/server";
import { deletionOutcome, StorageConfigurationError, type Storage } from "../shared/storage.js";

export function createStorage(token: string | undefined): Storage {
  if (!token) throw new StorageConfigurationError();
  const provider = new UTApi({ token });
  return {
    async deleteFiles(keys) {
      if (keys.length === 0) return { outcome: "deleted" };
      try { return deletionOutcome(await provider.deleteFiles(keys), keys.length); }
      catch { return { outcome: "unknown" }; }
    },
  };
}
