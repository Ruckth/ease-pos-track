import { ConvexError } from "convex/values";
import type { Storage } from "../../shared/storage.js";

export type CancelUploadDependencies = {
  cancel(input: { token: string; intentId: string; secret: string }): Promise<{ keys: string[] }>;
  storage(): Storage;
};

export function cancelUploadHandler(deps: CancelUploadDependencies) {
  return async (request: Request): Promise<Response> => {
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return Response.json({ error: "SESSION_EXPIRED" }, { status: 401 });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "UPLOAD_INTENT_INVALID" }, { status: 400 }); }
    if (!body || typeof body !== "object" || !("intentId" in body) || !("secret" in body)
      || typeof body.intentId !== "string" || !body.intentId
      || typeof body.secret !== "string" || !body.secret) {
      return Response.json({ error: "UPLOAD_INTENT_INVALID" }, { status: 400 });
    }
    try {
      const storage = deps.storage();
      const result = await deps.cancel({ token, intentId: body.intentId, secret: body.secret });
      if (result.keys.length > 0) {
        const outcome = await storage.deleteFiles(result.keys);
        if (outcome.outcome !== "deleted" && outcome.outcome !== "absent_verified") {
          return Response.json({ error: "UPLOAD_CLEANUP_UNKNOWN" }, { status: 502 });
        }
      }
      return Response.json({ ok: true, deleted: result.keys.length });
    } catch (error) {
      const data = error instanceof ConvexError ? error.data : error;
      const code = data && typeof data === "object" && "code" in data && typeof data.code === "string"
        ? data.code : "UPLOAD_CLEANUP_FAILED";
      return Response.json({ error: code }, { status: code === "SESSION_EXPIRED" ? 401 : code === "STORAGE_NOT_CONFIGURED" ? 503 : 400 });
    }
  };
}
