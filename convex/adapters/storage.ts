import { UTApi } from "uploadthing/server";
import { providerStorage, StorageConfigurationError, type Storage, type StorageProvider } from "../../shared/storage";

/** Called at the action entry point, never during module loading. Tests inject a provider. */
export function createStorage(token = process.env.UPLOADTHING_TOKEN,
  providerFactory: (token: string) => StorageProvider = token => new UTApi({ token })): Storage {
  if (!token) throw new StorageConfigurationError();
  try { return providerStorage(providerFactory(token)); }
  catch { throw new StorageConfigurationError(); }
}
