import { UTApi } from "uploadthing/server";
import { providerStorage, StorageConfigurationError, type Storage, type StorageProvider } from "../shared/storage.js";

export function createStorage(token: string | undefined, providerFactory: (token: string) => StorageProvider = token => new UTApi({ token })): Storage {
  if (!token) throw new StorageConfigurationError();
  let provider: StorageProvider;
  try { provider = providerFactory(token); }
  catch { throw new StorageConfigurationError(); }
  return providerStorage(provider);
}
