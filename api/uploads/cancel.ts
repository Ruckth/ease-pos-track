import { ConvexHttpClient } from "convex/browser";
import { UTApi } from "uploadthing/server";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";

const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
if (!convexUrl) throw new Error("CONVEX_URL or VITE_CONVEX_URL is required by the upload API.");

const convex = new ConvexHttpClient(convexUrl);
const utapi = new UTApi();

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { intentId?: string; secret?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.intentId || !body.secret) {
    return Response.json({ error: "Invalid upload intent" }, { status: 400 });
  }

  try {
    const result = await convex.mutation(api.uploads.cancelUploadIntent, {
      token,
      intentId: body.intentId as Id<"uploadIntents">,
      secret: body.secret,
    });
    if (result.keys.length > 0) await utapi.deleteFiles(result.keys);
    return Response.json({ ok: true, deleted: result.keys.length });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to cancel upload" },
      { status: 400 },
    );
  }
}
