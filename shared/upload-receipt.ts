import { ConvexError } from "convex/values";

class UploadWriteUnknownError extends Error {
  constructor() { super("UPLOAD_WRITE_UNKNOWN"); }
}

/** Replaying the identical write reconciles response loss. Failure to reconcile
 * retains ownership; it is never permission to call the provider's delete API.
 */
export async function reconcileUploadWrite<T>(write: () => Promise<T>): Promise<T> {
  try { return await write(); }
  catch (error) {
    if (definitiveUploadRejection(error)) throw error;
    try { return await write(); }
    catch { throw new UploadWriteUnknownError(); }
  }
}

export function definitiveUploadRejection(error: unknown) {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = error.data;
  const code = data && typeof data === "object" && "code" in data && typeof data.code === "string"
    ? data.code : typeof data === "string" && error instanceof ConvexError ? data : undefined;
  // Only a server rejection proves rollback; local/provider errors prove nothing.
  return (error instanceof ConvexError || code !== undefined) && !code?.endsWith("_UNKNOWN");
}
