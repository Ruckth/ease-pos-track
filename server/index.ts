import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ConvexHttpClient } from "convex/browser";
import { createRouteHandler, UTApi } from "uploadthing/server";
import { uploadRouter } from "./uploadthing";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const app = new Hono();
const uploadHandler = createRouteHandler({
  router: uploadRouter,
});
const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
if (!convexUrl) throw new Error("CONVEX_URL or VITE_CONVEX_URL is required by the upload server.");
const convex = new ConvexHttpClient(convexUrl);
const utapi = new UTApi();

app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"],
    allowHeaders: ["authorization", "content-type", "x-uploadthing-package", "x-uploadthing-version"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));
app.all("/api/uploadthing", async (c) => uploadHandler(c.req.raw));
app.post("/api/uploads/cancel", async (c) => {
  const authorization = c.req.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return c.json({ error: "SESSION_EXPIRED" }, 401);
  const body = await c.req.json<{ intentId?: string; secret?: string }>();
  if (!body.intentId || !body.secret) return c.json({ error: "UPLOAD_INTENT_INVALID" }, 400);

  try {
    const result = await convex.mutation(api.uploads.cancelUploadIntent, {
      token,
      intentId: body.intentId as Id<"uploadIntents">,
      secret: body.secret,
    });
    if (result.keys.length > 0) await utapi.deleteFiles(result.keys);
    return c.json({ ok: true, deleted: result.keys.length });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "UPLOAD_CLEANUP_FAILED" }, 400);
  }
});

const port = Number(process.env.UPLOAD_API_PORT ?? 8787);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Upload API listening on http://localhost:${port}`);
});
