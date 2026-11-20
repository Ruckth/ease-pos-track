import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalGatewayQuery, t3DoctorHttp } from "./functions";
import { verifyDoctor } from "./domain/t3_keys";
import { t3Digest, t3Runtime } from "./t3_config";
import { T3_DOCTOR_AUDIENCE, T3_DOCTOR_PATH, t3BearerPattern } from "../shared/t3-doctor";

export const verify = internalGatewayQuery({
  name: "t3_doctor:verify",
  args: { selector: v.string(), digest: v.string() },
  handler: (ctx, { selector, digest }) => verifyDoctor(ctx, selector, digest),
});

function respond(status: number, body: object) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store",
    ...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="Track Ease T3 Doctor"' } : {}),
  } });
}

async function hasPayload(request: Request) {
  if (!request.body) return false;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return false;
      if (part.value.length) return true;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export const doctorRoute = t3DoctorHttp(async (ctx, request) => {
  const runtime = t3Runtime();
  const url = new URL(request.url);
  if (!runtime || url.protocol !== "https:" || url.origin !== runtime.release.gatewayOrigin
    || url.pathname !== T3_DOCTOR_PATH || request.method !== "POST") return respond(404, { code: "NOT_FOUND" });
  const mixed = ["cookie", "origin", "proxy-authorization", "x-api-key", "x-upload-callback-secret"]
    .some(header => request.headers.has(header));
  if (mixed || url.search) return respond(400, { code: "INVALID_REQUEST" });

  const match = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i);
  const bearer = match?.[1];
  const selector = bearer?.match(t3BearerPattern)?.[1];
  if (!bearer || !selector) return respond(401, { code: "KEY_REJECTED" });

  try {
    if (await hasPayload(request)) return respond(400, { code: "INVALID_REQUEST" });
    const digest = await t3Digest(runtime.epoch, T3_DOCTOR_AUDIENCE, runtime.release.deployment, bearer);
    const result = await ctx.runQuery(internal.t3_doctor.verify, { selector, digest });
    return result ? respond(200, result) : respond(401, { code: "KEY_REJECTED" });
  } catch {
    return respond(503, { code: "DOCTOR_UNAVAILABLE" });
  }
});
