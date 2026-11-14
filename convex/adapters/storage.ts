import { UTApi } from "uploadthing/server";
import { providerStorage, StorageConfigurationError } from "../../shared/storage";

/** Called at the action entry point, never during module loading. */
export function createStorage() {
  const token = process.env.UPLOADTHING_TOKEN;
  if (!token) throw new StorageConfigurationError();
  try { return providerStorage(new UTApi({ token })); }
  catch { throw new StorageConfigurationError(); }
}
