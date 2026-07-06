import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createRouteHandler } from "uploadthing/server";
import { uploadRouter } from "./uploadthing";

const app = new Hono();
const uploadHandler = createRouteHandler({
  router: uploadRouter,
});

app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowHeaders: ["content-type", "x-uploadthing-package", "x-uploadthing-version"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));
app.all("/api/uploadthing", async (c) => uploadHandler(c.req.raw));

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Upload API listening on http://localhost:${port}`);
});
