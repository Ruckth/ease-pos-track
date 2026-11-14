import { errorCode } from "../../shared/errors.js";

export type CancelUploadDependencies = {
  cancel(input: { token: string; intentId: string; secret: string }): Promise<{ state: "queued" | "completed" | "failed"; jobIds: string[] }>;
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
      const result = await deps.cancel({ token, intentId: body.intentId, secret: body.secret });
      if (result.state === "failed") return Response.json({ error: "UPLOAD_CLEANUP_FAILED", jobIds: result.jobIds }, { status: 409 });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const candidate = errorCode(error);
      if (!candidate) return Response.json({ error: "UPLOAD_CLEANUP_UNKNOWN", outcome: "unknown" }, { status: 503 });
      const code = candidate && ["SESSION_EXPIRED", "UPLOAD_INTENT_NOT_FOUND", "MEDIA_OWNERSHIP_CONFLICT"].includes(candidate)
        ? candidate : "UPLOAD_CLEANUP_FAILED";
      return Response.json({ error: code }, { status: code === "SESSION_EXPIRED" ? 401 : 400 });
    }
  };
}
